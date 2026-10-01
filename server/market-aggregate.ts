import {Worker} from 'node:worker_threads';
import type {HistoricalAggregateOptions,HistoricalFlowAggregate} from '../src/lib/flow/persistence-client';
let active=0;

/** Standalone worker body; no module-local state is captured by toString().
 * SQLite scans/groups the entire requested range, rather than truncating a tape
 * in JavaScript. Its read transaction fixes one consistent view during capture. */
function aggregateWorker(){
  // getBuiltinModule survives Vite's ESM config bundling. A literal require()
  // would become an outer __require helper absent from the evaluated worker.
  const {parentPort,workerData}=process.getBuiltinModule('node:worker_threads') as typeof import('node:worker_threads');
  const {DatabaseSync}=process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const {file,id,options}=workerData as {file:string;id:string;options:HistoricalAggregateOptions};
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    db.exec('PRAGMA temp_store=FILE;PRAGMA cache_size=-4096;PRAGMA busy_timeout=5000;BEGIN');
    const raw=db.prepare('SELECT meta FROM datasets WHERE id=?').get(id);if(!raw)throw Error('数据集不存在');
    const dataset=JSON.parse(String(raw.meta));if(dataset.kind==='archive'&&dataset.state!=='complete')throw Error('档案尚未完成校验导入');
    const bounds=db.prepare('SELECT COUNT(*) AS n,MIN(p) AS lo,MAX(p) AS hi FROM trades WHERE dataset=? AND t>=? AND t<=?').get(id,options.from,options.to)!;
    const maxBars=options.maxBars??120,maxLevels=Math.min(512,Math.max(16,Math.floor(30000/maxBars)));
    const lo=Number(bounds.lo??0),hi=Number(bounds.hi??0),loTick=Math.round(lo/options.tickSize),hiTick=Math.round(hi/options.tickSize);
    if(!Number.isSafeInteger(loTick)||!Number.isSafeInteger(hiTick))throw Error('最小价格跳动超出安全整数范围');
    const desired=options.priceStepTicks??1,step=desired*Math.max(1,Math.ceil((hiTick-loTick+1)/(desired*Math.max(1,maxLevels-1))));
    if(!Number.isSafeInteger(step))throw Error('价位聚合跨度过大');
    const block=options.tpoBlockMs??1800000,params={id,from:options.from,to:options.to,tick:options.tickSize,step,tf:options.timeframeMs,block,offset:options.sessionOffsetMs??0};
    const cte='WITH selected AS (SELECT *,CAST(CAST(ROUND(p / :tick) AS INTEGER) / :step AS INTEGER) * :step AS tick,t - ((t - :offset) % :tf + :tf) % :tf AS time,t - ((t - :offset) % :block + :block) % :block AS tb FROM trades WHERE dataset=:id AND t>=:from AND t<=:to) ';
    const sums="SUM(CASE side WHEN 'buy' THEN q ELSE 0 END) AS buyBase,SUM(CASE side WHEN 'sell' THEN q ELSE 0 END) AS sellBase,SUM(CASE side WHEN 'buy' THEN quote ELSE 0 END) AS buyQuote,SUM(CASE side WHEN 'sell' THEN quote ELSE 0 END) AS sellQuote,COUNT(*) AS aggregateCount";
    const amounts=(row:Record<string,unknown>)=>{const buyBase=Number(row.buyBase??0),sellBase=Number(row.sellBase??0),buyQuote=Number(row.buyQuote??0),sellQuote=Number(row.sellQuote??0);
      if(![buyBase,sellBase,buyQuote,sellQuote,buyBase+sellBase,buyQuote+sellQuote].every(Number.isFinite))throw Error('聚合数量超过安全数值范围');
      return {buyBase,sellBase,buyQuote,sellQuote,volumeBase:buyBase+sellBase,deltaBase:buyBase-sellBase,volumeQuote:buyQuote+sellQuote,deltaQuote:buyQuote-sellQuote,aggregateCount:Number(row.aggregateCount??0)};};
    const total=db.prepare(cte+`SELECT ${sums},MIN(t) AS firstTime,MAX(t) AS lastTime,MIN(k) AS firstId,MAX(k) AS lastId,COUNT(DISTINCT time) AS totalBars,COUNT(normal) AS normalCount,SUM(normal) AS normalBase FROM selected`).get(params)!;
    const profile=db.prepare(cte+`SELECT tick,${sums} FROM selected GROUP BY tick ORDER BY tick DESC`).all(params).map(row=>({tick:Number(row.tick),price:Number(row.tick)*options.tickSize,priceEnd:(Number(row.tick)+step)*options.tickSize,...amounts(row)}));
    const totals=amounts(total),barTotals=db.prepare(cte+`SELECT time,${sums} FROM selected GROUP BY time ORDER BY time DESC LIMIT :limit`).all({...params,limit:maxBars}).reverse();
    const firstBar=Number(barTotals[0]?.time??Number.MAX_SAFE_INTEGER);
    const cells=db.prepare(cte+`SELECT time,tick,${sums} FROM selected WHERE time>=:firstBar GROUP BY time,tick ORDER BY time,tick DESC`).all({...params,firstBar});
    const byTime=new Map<number,unknown[]>();for(const row of cells){const time=Number(row.time),levels=byTime.get(time)??[];levels.push({tick:Number(row.tick),price:Number(row.tick)*options.tickSize,priceEnd:(Number(row.tick)+step)*options.tickSize,...amounts(row)});byTime.set(time,levels);}
    const relevant="dataset=? AND json_extract(meta,'$.afterTime')<=? AND json_extract(meta,'$.beforeTime')>=?";
    const gapCount=Number(db.prepare(`SELECT COUNT(*) AS n FROM gaps WHERE ${relevant}`).get(id,options.to,options.from)!.n);
    const gaps=db.prepare(`SELECT meta FROM gaps WHERE ${relevant} ORDER BY lo LIMIT 500`).all(id,options.to,options.from).map(row=>JSON.parse(String(row.meta)));
    const depthGaps=db.prepare("SELECT payload FROM depth_events WHERE dataset=? AND kind='gap' AND t>=? AND t<=? ORDER BY seq LIMIT 500").all(id,options.from,options.to).map(row=>{const e=JSON.parse(String(row.payload));return{channel:e.channel??'depth',afterTime:e.time,beforeTime:e.time,reason:e.reason};});
    const earliestGap=Number(db.prepare(`SELECT MIN(json_extract(meta,'$.afterTime')) AS t FROM gaps WHERE ${relevant}`).get(id,options.to,options.from)!.t??Infinity);
    let base=totals.deltaBase,quote=totals.deltaQuote;for(const row of barTotals){const value=amounts(row);base-=value.deltaBase;quote-=value.deltaQuote;}
    let coverageFrom=Number(total.firstTime??0),coverageEnd=Number(total.lastTime??0)+1;
    if(dataset.kind==='archive'&&dataset.archiveDate){const start=Date.parse(`${dataset.archiveDate}${dataset.period==='monthly'?'-01':''}T00:00:00Z`),date=new Date(start);coverageFrom=start;coverageEnd=dataset.period==='daily'?start+86400000:Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1);}
    // Dataset-level times also include L2 and receipt events. Only actual trade
    // witnesses may certify a recording's selected interval as complete.
    let tradeCoverage:{fromTime:number;toTime:number;complete:boolean;basis:'verified-archive'|'continuous-trade-ids'|'unproven';availableAt?:number;firstTradeTime?:number;lastTradeTime?:number;reason:string}={fromTime:options.from,toTime:options.to,complete:false,basis:'unproven',reason:'真实成交尚未从两端覆盖所选区间'};
    if(dataset.kind==='archive'&&dataset.archiveDate){
      const complete=options.from>=coverageFrom&&options.to<coverageEnd&&gapCount===0;
      tradeCoverage={...tradeCoverage,complete,basis:complete?'verified-archive':'unproven',availableAt:options.to,reason:complete?'已校验档案覆盖所选区间，且无已知成交 ID 缺口':'超出已校验档案日期或存在成交 ID 缺口'};
    }else{
      const before=db.prepare('SELECT k,t FROM trades WHERE dataset=? AND t<=? ORDER BY t DESC,k DESC LIMIT 1').get(id,options.from);
      const after=db.prepare('SELECT k,t FROM trades WHERE dataset=? AND t>=? ORDER BY t,k LIMIT 1').get(id,options.to);
      if(before&&after){
        const first=String(before.k),last=String(after.k),expected=BigInt(last)-BigInt(first)+1n;
        const actual=BigInt(String(db.prepare('SELECT COUNT(*) AS n FROM trades WHERE dataset=? AND k>=? AND k<=?').get(id,first,last)!.n));
        const complete=expected>0n&&actual===expected&&gapCount===0;
        tradeCoverage={...tradeCoverage,complete,basis:complete?'continuous-trade-ids':'unproven',availableAt:Number(after.t),firstTradeTime:Number(before.t),lastTradeTime:Number(after.t),reason:complete?'所选区间由两端真实成交及其间连续 ID 证明':'区间两端成交之间尚有未补齐 ID'};
      }
    }
    const footprint=barTotals.map(row=>{const time=Number(row.time),endTime=time+options.timeframeMs,value=amounts(row);base+=value.deltaBase;quote+=value.deltaQuote;
      const unknown=endTime>earliestGap;
      return {...value,time,endTime,levels:byTime.get(time)??[],cvdBase:unknown?NaN:base,cvdQuote:unknown?NaN:quote,
        partial:time<options.from||endTime>options.to+1||time<coverageFrom||endTime>coverageEnd||gaps.some(g=>g.afterTime<endTime&&g.beforeTime>=time)};});
    const tpoRows=db.prepare(cte+'SELECT tick,COUNT(DISTINCT tb) AS blocks FROM selected GROUP BY tick ORDER BY tick DESC').all(params).map(row=>({tick:Number(row.tick),price:Number(row.tick)*options.tickSize,priceEnd:(Number(row.tick)+step)*options.tickSize,blocks:Number(row.blocks)}));
    const count=Number(total.aggregateCount),source=dataset.tradeType==='trades'?'Binance USDⓈ-M trades':'Binance USDⓈ-M aggTrade';
    const snapshot={symbol:dataset.symbol,revision:dataset.tradeCount,aggregation:{tickSize:options.tickSize,timeframeMs:options.timeframeMs,priceStepTicks:desired,sessionOffsetMs:options.sessionOffsetMs??0},effectivePriceStepTicks:step,effectivePriceStep:step*options.tickSize,profile,footprint,totals,
      coverage:{fromTime:total.firstTime??undefined,throughTime:total.lastTime??undefined,fromId:total.firstId?BigInt(String(total.firstId)).toString():undefined,throughId:total.lastId?BigInt(String(total.lastId)).toString():undefined,retainedTrades:count,evictedTrades:0,rejectedTrades:0,conflictingDuplicates:0,gaps:gaps.slice(0,64),gapCount,continuous:count>0&&gapCount===0,completeHistory:false,source,scope:'persisted-selected-range',normalQuantityTrades:Number(total.normalCount),...(Number(total.normalCount)===count&&count?{normalQuantityBase:Number(total.normalBase)}:{}),cvdAnchorTime:options.from,
        note:`服务端聚合整个所选区间的 ${count} 条持久化成交；Profile 不截断成交数量。Footprint 仅展示末 ${maxBars} 根有成交的时间桶；CVD 从所选区间起点累计，ID 缺口之后标为未知。记录计数按 ${dataset.tradeType} 原始来源解释。`}};
    const result={datasetId:id,fromTime:options.from,toTime:options.to,tradeCoverage,...(count?{priceRange:{low:lo,high:hi}}:{}),snapshot,coverage:{dataset,gaps:[...gaps,...depthGaps].slice(0,500),gapsTruncated:gapCount+depthGaps.length>500,note:'只覆盖所选数据集实际持久化的区间。深度连接缺口单列，不将缺失成交补为零。'},totalBars:Number(total.totalBars),returnedBars:footprint.length,footprintTruncated:Number(total.totalBars)>footprint.length,tpo:{blockMs:block,rows:tpoRows,totalBlocks:tpoRows.reduce((sum,row)=>sum+row.blocks,0)}};
    db.exec('COMMIT');parentPort!.postMessage({result});
  }catch(error){parentPort!.postMessage({error:error instanceof Error?error.message:'历史聚合失败'});}
  finally{db.close();}
}

export function aggregateStoredTrades(file:string,id:string,input:HistoricalAggregateOptions,signal?:AbortSignal):Promise<HistoricalFlowAggregate>{
  if(!/^[\da-f-]{36}$/.test(id)||![input.from,input.to].every(n=>Number.isSafeInteger(n)&&n>=0)||input.to<input.from||!Number.isFinite(input.tickSize)||input.tickSize<=0||!Number.isSafeInteger(input.timeframeMs)||input.timeframeMs<1000||input.timeframeMs>366*86400000)throw Error('无效历史聚合范围或价格/周期参数');
  const options={...input,priceStepTicks:Math.max(1,Math.min(1e9,Math.round(input.priceStepTicks??1))),maxBars:Math.max(1,Math.min(500,Math.round(input.maxBars??120))),tpoBlockMs:Math.max(1000,Math.min(86400000,Math.round(input.tpoBlockMs??1800000)))};
  if(!Number.isSafeInteger(options.sessionOffsetMs??0)||![options.priceStepTicks,options.maxBars,options.tpoBlockMs].every(Number.isFinite))throw Error('无效历史聚合参数');
  signal?.throwIfAborted();if(active>=2)throw Error('已有两个历史聚合查询执行中，请稍后重试');active++;
  return new Promise((resolve,reject)=>{
    const worker=new Worker(`(${aggregateWorker.toString()})()`,{eval:true,workerData:{file,id,options},resourceLimits:{maxOldGenerationSizeMb:96}});let done=false;
    const finish=(error?:Error,result?:HistoricalFlowAggregate)=>{if(done)return;done=true;active--;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolve(result!);};
    const abort=()=>finish(Error('历史聚合查询已取消')),timer=setTimeout(()=>finish(Error('历史聚合超过 60 秒，请缩短查询范围或增大时间桶')),60000);
    signal?.addEventListener('abort',abort,{once:true});worker.on('message',value=>finish(value.error?Error(value.error):undefined,value.result));worker.on('error',error=>finish(error instanceof Error?error:Error(String(error))));worker.on('exit',code=>{if(!done)finish(Error(`历史聚合 Worker 提前结束（${code}）`));});
  });
}
