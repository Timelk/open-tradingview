import type {DatasetInfo,HistoricalFlowAggregate} from './persistence-client';
import type {FlowPriceLevel} from './types';

export interface SessionRange {from:number;to:number;date:string;timeZone:string;startMinute:number}
const wallParts=(time:number,timeZone:string)=>{
  const values=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(time);
  const get=(name:string)=>Number(values.find(part=>part.type===name)?.value);
  return {year:get('year'),month:get('month'),day:get('day'),hour:get('hour'),minute:get('minute'),second:get('second')};
};
function wallTimestamp(year:number,month:number,day:number,hour:number,minute:number,timeZone:string){
  const wall=Date.UTC(year,month-1,day,hour,minute),matches=new Set<number>();
  // Inspect both sides of a potential DST transition; never silently resolve
  // a nonexistent or ambiguous local market-session start.
  for(const hours of [-36,-12,0,12,36]){
    const probe=wall+hours*3_600_000,p=wallParts(probe,timeZone),offset=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-probe;
    const candidate=wall-offset,q=wallParts(candidate,timeZone);
    if(q.year===year&&q.month===month&&q.day===day&&q.hour===hour&&q.minute===minute&&q.second===0)matches.add(candidate);
  }
  if(matches.size!==1)throw Error(matches.size?'会话开盘处于夏令时重复时段，请使用明确的 UTC 区间。':'会话开盘当地时间不存在，请更换开盘时间。');
  return [...matches][0];
}
export function sessionDate(time:number,timeZone:string){const p=wallParts(time,timeZone);return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;}
/** A daily session follows local calendar boundaries: DST days may have 23/25 h. */
export function sessionRange(date:string,timeZone:string,startMinute=0):SessionRange {
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if(!match||!Number.isInteger(startMinute)||startMinute<0||startMinute>=1440)throw Error('请选择有效会话日期与开盘时间');
  const [year,month,day]=match.slice(1).map(Number),check=new Date(Date.UTC(year,month-1,day));
  if(check.getUTCFullYear()!==year||check.getUTCMonth()+1!==month||check.getUTCDate()!==day)throw Error('会话日期无效');
  const next=new Date(check.getTime()+86400000),hour=Math.floor(startMinute/60),minute=startMinute%60;
  const from=wallTimestamp(year,month,day,hour,minute,timeZone),end=wallTimestamp(next.getUTCFullYear(),next.getUTCMonth()+1,next.getUTCDate(),hour,minute,timeZone);
  return {from,to:end-1,date,timeZone,startMinute};
}
export interface TpoStatistics {totalVisits:number;poc?:number;valueLow?:number;valueHigh?:number;singlePrints:Array<{price:number;priceEnd:number}>;valueAreaPercent:number}
/** TPO counts actual traded visits only. Interior one-block visits are marked
 * as single prints; outer one-block tails are deliberately kept separate. */
export function tpoStatistics(input:HistoricalFlowAggregate['tpo']['rows'],valueAreaPercent=70):TpoStatistics {
  const rows=input.filter(row=>Number.isFinite(row.price)&&Number.isFinite(row.priceEnd)&&row.priceEnd>row.price&&Number.isFinite(row.blocks)&&row.blocks>0).sort((a,b)=>a.price-b.price);
  const percent=Number.isFinite(valueAreaPercent)?Math.max(1,Math.min(100,valueAreaPercent)):70,totalVisits=rows.reduce((sum,row)=>sum+row.blocks,0);
  if(!rows.length)return {totalVisits:0,singlePrints:[],valueAreaPercent:percent};
  const center=(rows[0].price+rows.at(-1)!.priceEnd)/2;
  let pocIndex=0;for(let i=1;i<rows.length;i++)if(rows[i].blocks>rows[pocIndex].blocks||rows[i].blocks===rows[pocIndex].blocks&&Math.abs((rows[i].price+rows[i].priceEnd)/2-center)<Math.abs((rows[pocIndex].price+rows[pocIndex].priceEnd)/2-center))pocIndex=i;
  let left=pocIndex,right=pocIndex,count=rows[pocIndex].blocks;const target=totalVisits*percent/100;
  while(count<target&&(left>0||right<rows.length-1)){
    const down=left>0?rows[left-1].blocks:-1,up=right<rows.length-1?rows[right+1].blocks:-1;
    if(down>=up&&left>0)count+=rows[--left].blocks;
    if(up>=down&&right<rows.length-1)count+=rows[++right].blocks;
  }
  const firstBody=rows.findIndex(row=>row.blocks>1),singlePrints:Array<{price:number;priceEnd:number}>=[];let lastBody=rows.length-1;while(lastBody>=0&&rows[lastBody].blocks<=1)lastBody--;
  for(let i=firstBody+1;firstBody>=0&&i<lastBody;i++)if(rows[i].blocks===1){
    const row=rows[i],previous=singlePrints.at(-1);if(previous&&Math.abs(previous.priceEnd-row.price)<1e-9*Math.max(1,Math.abs(row.price)))previous.priceEnd=row.priceEnd;
    else singlePrints.push({price:row.price,priceEnd:row.priceEnd});
  }
  return {totalVisits,poc:rows[pocIndex].price,valueLow:rows[left].price,valueHigh:rows[right].priceEnd,singlePrints,valueAreaPercent:percent};
}
export interface ImbalanceOptions {mode:'same'|'diagonal';ratio:number;minVolume:number;unit:'base'|'quote';allowZero?:boolean}
export interface PriceImbalance {tick:number;buyRatio?:number;sellRatio?:number}
/** Diagonal ask at P compares bid at P-step; bid at P compares ask at P+step.
 * Missing price rows are unknown, not zero. Zero denominators need opt-in. */
export function footprintImbalances(levels:readonly FlowPriceLevel[],stepTicks:number,options:ImbalanceOptions):PriceImbalance[]{
  if(!Number.isFinite(options.ratio)||options.ratio<=1||!Number.isFinite(options.minVolume)||options.minVolume<0||!Number.isFinite(stepTicks)||stepTicks<=0)return [];
  const byTick=new Map(levels.map(row=>[row.tick,row])),buy=(row:FlowPriceLevel)=>options.unit==='base'?row.buyBase:row.buyQuote,sell=(row:FlowPriceLevel)=>options.unit==='base'?row.sellBase:row.sellQuote;
  const qualify=(strong:number,weak:number|undefined)=>{
    if(!Number.isFinite(strong)||strong<=0||strong<options.minVolume||weak===undefined||!Number.isFinite(weak)||weak<0)return;
    if(weak===0)return options.allowZero?Infinity:undefined;
    const ratio=strong/weak;return ratio>=options.ratio?ratio:undefined;
  };
  const result:PriceImbalance[]=[];
  for(const row of levels){const below=options.mode==='same'?row:byTick.get(row.tick-stepTicks),above=options.mode==='same'?row:byTick.get(row.tick+stepTicks);
    const buyRatio=qualify(buy(row),below?sell(below):undefined),sellRatio=qualify(sell(row),above?buy(above):undefined);
    if(buyRatio!==undefined||sellRatio!==undefined)result.push({tick:row.tick,buyRatio,sellRatio});
  }
  return result;
}
export function datasetRange(dataset:DatasetInfo):{from?:number;to?:number}{
  if(dataset.kind==='archive'&&dataset.state==='complete'&&dataset.archiveDate){
    const from=Date.parse(`${dataset.archiveDate}${dataset.period==='monthly'?'-01':''}T00:00:00Z`),start=new Date(from);
    return {from,to:dataset.period==='monthly'?Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1)-1:from+86400000-1};
  }
  return {from:dataset.fromTime,to:dataset.recordedThrough??dataset.throughTime};
}
export interface InitialBalance {status:'loading'|'forming'|'complete'|'partial'|'empty';from:number;through:number;low?:number;high?:number;reason:string}
export function initialBalance(result:HistoricalFlowAggregate|undefined,from:number,durationMs:number,cursor:number):InitialBalance {
  const through=from+durationMs-1,base={from,through};
  if(!result||result.toTime>cursor)return {...base,status:'loading',reason:'等待初始平衡区间的独立成交查询'};
  if(!result.priceRange||result.snapshot.totals.aggregateCount===0)return {...base,status:'empty',reason:'该初始平衡区间暂无真实成交'};
  const dataset=result.coverage.dataset,hasGaps=result.snapshot.coverage.gapCount>0,requiredThrough=Math.min(cursor,through),proof=result.tradeCoverage;
  const prices={low:result.priceRange.low,high:result.priceRange.high};
  // Complete archives prove their file range. Recording metadata mixes trade,
  // depth and receive clocks, so it must never substitute for trade witnesses.
  const archiveRange=dataset.kind==='archive'&&dataset.state==='complete'&&dataset.archiveDate?datasetRange(dataset):undefined;
  const covered=archiveRange?archiveRange.from!==undefined&&archiveRange.to!==undefined&&archiveRange.from<=from&&archiveRange.to>=requiredThrough:
    !!proof?.complete&&proof.basis==='continuous-trade-ids'&&proof.fromTime===from&&proof.toTime>=requiredThrough&&proof.availableAt!==undefined&&proof.availableAt<=cursor;
  if(result.fromTime!==from||!covered||hasGaps)return {...base,...prices,status:'partial',reason:hasGaps?'初始平衡区间存在成交 ID 缺口':proof?.availableAt!==undefined&&proof.availableAt>cursor?'尚未到达可证明成交覆盖完整的后端成交时点':'真实成交尚未证明覆盖整个初始平衡区间'};
  if(cursor<through||result.toTime<through)return {...base,...prices,status:'forming',reason:'尚未走完初始平衡时段，当前高低仅为已知部分'};
  return {...base,...prices,status:'complete',reason:'已覆盖完整初始平衡时段，无已知成交 ID 缺口'};
}
