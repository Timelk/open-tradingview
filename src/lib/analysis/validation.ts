import type {BarInput,ColumnView,DerivedSeries,IndicatorDef,ParamValues} from '../core/types';
import type {DatasetSnapshot} from '../history/types';
import {IndicatorRegistry,registerBuiltins} from '../indicators/registry';
import {IndicatorRuntime} from '../indicators/runtime';
import {availableTime} from './features';

export interface ValidationStudy {
  id:string;params?:ParamValues;timeframe?:string;
  signalMode?:'auto'|'none'|'confirmed-pattern'|'confirmed-observation'|'event';eventKinds?:string[];
}
export interface ResearchSettings {
  enabled?:boolean;initialCapital?:number;notional?:number;feeBps?:number;slippageBps?:number;
  stopAtr?:number;takeAtr?:number;maxHoldBars?:number;responseBars?:number;
}
export interface ValidationRequest {
  dataset:DatasetSnapshot|readonly BarInput[];studies:ValidationStudy[];
  /** Defaults to excluding the last (possibly forming) candle. */
  closedLength?:number;intervalMs?:number;prefixProbes?:number;holdoutFraction?:number;maxHoldoutBars?:number;
  research?:ResearchSettings;maxDurationMs?:number;
  funding?:{from:number;to:number;rates:readonly {time:number;rate:number;markPrice:number}[]};
}
export interface ValidationProgress {phase:'prepare'|'causality'|'holdout'|'complete';completed:number;total:number;percent:number}
export interface ValidationSignal {id:string;studyId:string;name:string;kind:string;direction:1|-1;time:number;availableAt:number;observedAt:number;signalBar:number}
export interface ValidationResponse {signal:ValidationSignal;entryBar:number;endBar:number;directionalReturnPct:number;afterFrictionPct:number;favorableExcursionPct:number;adverseExcursionPct:number}
export interface ResearchTrade {
  id:string;signal:ValidationSignal;side:'long'|'short';entryBar:number;exitBar:number;entryTime:number;exitTime:number;
  entryPrice:number;exitPrice:number;quantity:number;grossBeforeCosts:number;slippageCost:number;fees:number;funding:number;net:number;
  exitReason:'stop'|'take'|'both-hit-stop-first'|'time'|'data-end'|'data-gap';ambiguous:boolean;
}
export interface ValidationReport {
  version:'analysis-validation/1';status:'complete';startedAt:number;finishedAt:number;durationMs:number;
  dataset:{hash:string;hashAlgorithm:'SHA-256';symbol:string;interval:string;source:string;inputBars:number;closedBars:number;excludedFormingBars:number;from:number|null;through:number|null;gaps:number;invalidBars:number};
  fundingData?:{hash:string;from:number;to:number;events:number;coverageDeclared:true};
  studies:{id:string;params:ParamValues;timeframe:string;signalMode:string;ruleVersions:string[]}[];
  split:{trainingBars:number;holdoutBars:number;holdoutFrom:number|null;holdoutThrough:number|null;requestedFraction:number;capped:boolean;parametersFrozen:true};
  causality:{probes:number;comparisons:number;changedKnownFacts:number;futureEmissions:number;futureBackingDifferences:number;unmatchedPastFacts:number;ignoredDevelopingCandidates:number;status:'passed-sampled'|'issues';issues:{studyId:string;prefixBars:number;kind:string;factId:string}[]};
  responses:{signals:number;evaluated:number;unresolved:number;overlapping:number;positiveAfterFriction:number;positiveRate:number|null;meanAfterFrictionPct:number|null;items:ValidationResponse[]};
  research:{enabled:boolean;settings:Required<ResearchSettings>;trades:ResearchTrade[];ignoredWhilePositionOpen:number;conflictingSignals:number;unusableSignals:number;
    grossBeforeCosts:number;slippageCost:number;fees:number;funding:number;net:number;endingEquity:number;maxDrawdown:number;winRate:number|null;profitFactor:number|null;equity:{time:number;value:number}[];
    fundingBasis:'not-provided'|'partial'|'covered';conclusion:'disabled'|'no-signals'|'insufficient-sample'|'non-positive-sample'|'positive-sample-only'};
  warnings:string[];
}
export interface ValidationOptions {registry?:IndicatorRegistry;definitions?:IndicatorDef[];signal?:AbortSignal;onProgress?:(progress:ValidationProgress)=>void;yieldControl?:()=>Promise<void>}
export type ValidationWorkerRequest={type:'run';jobId:string;request:ValidationRequest}|{type:'cancel';jobId:string};
export type ValidationWorkerResponse={type:'progress';jobId:string;progress:ValidationProgress}|{type:'result';jobId:string;report:ValidationReport}|{type:'cancelled';jobId:string}|{type:'error';jobId:string;message:string};

const finite=(n:unknown,fallback:number,min:number,max:number)=>Number.isFinite(Number(n))?Math.max(min,Math.min(max,Number(n))):fallback;
const waitTask=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
const abortError=()=>new DOMException('分析验收已取消','AbortError');
const settings=(r:ResearchSettings={}):Required<ResearchSettings>=>({enabled:r.enabled!==false,
  initialCapital:finite(r.initialCapital,10000,1,1e12),notional:finite(r.notional,1000,1,1e10),feeBps:finite(r.feeBps,5,0,1000),slippageBps:finite(r.slippageBps,1,0,1000),
  stopAtr:finite(r.stopAtr,1.5,0,100),takeAtr:finite(r.takeAtr,2,0,100),maxHoldBars:Math.round(finite(r.maxHoldBars,24,1,512)),responseBars:Math.round(finite(r.responseBars,8,1,256))});
function nominal(interval:string,bars:readonly BarInput[]):number {
  const match=/^(\d+)([smhdwM])$/.exec(interval);if(match)return +match[1]*({s:1000,m:60000,h:3600000,d:86400000,w:604800000,M:2592000000}[match[2] as 'm']);
  const differences=bars.slice(1,64).map((b,i)=>b.time-bars[i].time).filter(d=>Number.isFinite(d)&&d>0).sort((a,b)=>a-b);
  return differences[Math.floor(differences.length/2)]??60000;
}
function valid(b:BarInput):boolean {return [b.time,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)&&b.time>=0&&b.open>0&&b.close>0&&b.low>0&&b.volume>=0&&b.high>=Math.max(b.open,b.close)&&b.low<=Math.min(b.open,b.close);}
function views(bars:readonly BarInput[],intervalMs:number){
  const keys=['time','open','high','low','close','volume'] as const,flowKeys=['quoteVolume','tradeCount','takerBuyBase','takerBuyQuote'] as const;
  const columns=Object.fromEntries(keys.map(key=>[key,Float64Array.from(bars,b=>b[key])])) as Record<typeof keys[number],Float64Array>;
  const flow=Object.fromEntries(flowKeys.map(key=>[key,Float64Array.from(bars,b=>b[key]??NaN)])) as Record<typeof flowKeys[number],Float64Array>;
  return (end:number,exposeFuture=false):ColumnView=>({length:end,closedLength:end,intervalMs,
    col:key=>exposeFuture?columns[key]:columns[key].subarray(0,end),flow:key=>exposeFuture?flow[key]:flow[key].subarray(0,end)});
}
async function fingerprint(meta:unknown,bars:readonly BarInput[]):Promise<string>{
  const bytes=new TextEncoder().encode(JSON.stringify({meta,bars:bars.map(b=>[b.time,b.open,b.high,b.low,b.close,b.volume,b.quoteVolume??null,b.tradeCount??null,b.takerBuyBase??null,b.takerBuyQuote??null])}));
  const digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
interface Fact {id:string;knownAt:number;payload:string}
function knownFacts(series:DerivedSeries[],cutoff:number):{facts:Map<string,Fact>;future:number;ignored:number}{
  const facts=new Map<string,Fact>();let future=0,ignored=0;
  const add=(id:string,knownAt:number,geometry:unknown)=>{if(!Number.isFinite(knownAt))return;if(knownAt>cutoff){future++;return;}facts.set(id,{id,knownAt,payload:JSON.stringify(geometry)});};
  for(const line of series){
    ignored+=line.candidates?.length??0;
    for(const p of line.patterns??[])if(p.formation!=='early')add(`pattern:${p.id}`,p.confirmedAt,{time:p.confirmedAt,points:p.points,direction:p.direction});
    for(const o of line.observations??[]){
      if(o.events.length){for(const e of o.events)add(`event:${o.id}:${e.id}`,Math.max(o.availableAt,e.availableAt),{kind:e.kind,time:e.time,availableAt:e.availableAt,price:e.price});}
      else if(o.state!=='observing')add(`observation:${o.id}`,o.availableAt,{time:o.time,availableAt:o.availableAt,points:o.points,direction:o.direction});
      else ignored++;
    }
  }
  return {facts,future,ignored};
}
function defaultMode(study:ValidationStudy):NonNullable<ValidationStudy['signalMode']>{return study.signalMode??'auto';}
const eventKinds=new Set(['breakout','activation','SOS','SOW','fvg']);
function candidates(series:DerivedSeries[],study:ValidationStudy):Omit<ValidationSignal,'observedAt'|'signalBar'>[]{
  const mode=defaultMode(study);if(mode==='none')return [];
  const result:Omit<ValidationSignal,'observedAt'|'signalBar'>[]=[];
  for(const line of series){
    if(mode==='auto'||mode==='confirmed-pattern')for(const p of line.patterns??[]){
      if(p.status!=='confirmed'||p.formation==='early'||p.resolution||p.dataWarning)continue;
      result.push({id:`${study.id}:pattern:${p.id}`,studyId:study.id,name:p.name,kind:'pattern-confirmation',direction:p.direction==='bullish'?1:-1,time:p.points.at(-1)?.time??p.confirmedAt,availableAt:p.confirmedAt});
    }
    for(const o of line.observations??[]){
      if(o.state!=='confirmed'||o.direction==='neutral'||o.trackingEndedAt||o.dataWarning)continue;
      // Wave/cycle hypotheses, projections and historic stages do not become
      // orders merely because an overlay has a directional name.
      if(o.family==='wave'||o.family==='cycle'||o.ruleVersion.startsWith('point-figure'))continue;
      const direction=o.direction==='bullish'?1:-1;
      if((mode==='auto'||mode==='event')&&o.events.length){
        for(const e of o.events){
          if(!(study.eventKinds?study.eventKinds.includes(e.kind):eventKinds.has(e.kind)))continue;
          result.push({id:`${study.id}:event:${o.id}:${e.id}`,studyId:study.id,name:o.name,kind:e.kind,direction,time:e.time,availableAt:Math.max(o.availableAt,e.availableAt)});
        }
      }else if((mode==='confirmed-observation'||mode==='auto'&&o.family==='candlestick')&&!o.events.length){
        result.push({id:`${study.id}:observation:${o.id}`,studyId:study.id,name:o.name,kind:'observation-confirmation',direction,time:o.time,availableAt:o.availableAt});
      }
    }
  }
  return result;
}

/** A reproducible study audit and explicitly defined research simulation.
 * Parameters never fit against holdout prices. This does not submit orders. */
export async function runAnalysisValidation(request:ValidationRequest,options:ValidationOptions={}):Promise<ValidationReport>{
  const startedAt=Date.now(),began=performance.now(),warnings:string[]=[];
  const check=()=>{if(options.signal?.aborted)throw abortError();if(performance.now()-began>finite(request.maxDurationMs,180000,1000,600000))throw Error('验收超时，请减少模块、抽样次数或后段柱数。');};
  const yieldControl=options.yieldControl??waitTask;
  const progress=(phase:ValidationProgress['phase'],completed:number,total:number,percent:number)=>options.onProgress?.({phase,completed,total,percent});
  check();progress('prepare',0,1,0);
  const raw=Array.isArray(request.dataset)?request.dataset as readonly BarInput[]:(request.dataset as DatasetSnapshot).bars;
  const meta=Array.isArray(request.dataset)?{symbol:'未指定',interval:'',source:'import'}:request.dataset as DatasetSnapshot;
  if(raw.length>20000)throw Error('单次验收最多 20,000 根，请选择明确区间。');
  if(!request.studies.length||request.studies.length>8)throw Error('请选择 1–8 个分析模块。');
  const n=Math.max(0,Math.min(raw.length,Math.floor(request.closedLength??raw.length-1))),bars=raw.slice(0,n).map(b=>({...b}));
  if(n<32)throw Error('至少需要 32 根已收盘行情用于前段预热与后段检验。');
  const intervalMs=finite(request.intervalMs,nominal(meta.interval,bars),1000,366*86400000),view=views(bars,intervalMs);
  let gaps=0,invalidBars=0;const good=bars.map(valid),adjacent=bars.map((b,i)=>i===0||b.time===availableTime(view(i),i-1));
  for(let i=0;i<n;i++){if(!Number.isFinite(bars[i].time)||bars[i].time<0)throw Error('行情包含无效时间，不能建立可复现事件顺序。');if(!good[i])invalidBars++;if(i&&bars[i].time<=bars[i-1].time)throw Error('行情时间重复或倒序，不能建立可复现事件顺序。');if(!adjacent[i])gaps++;}
  if(invalidBars)warnings.push(`${invalidBars} 根无效行情：不作为入场柱，跨越该处的持仓按前一有效收盘结束。`);
  if(gaps)warnings.push(`${gaps} 处时间缺口：不跨缺口入场或累计后续响应。`);
  const hash=await fingerprint({symbol:meta.symbol,interval:meta.interval,source:meta.source,intervalMs,
    marketType:'marketType'in meta?meta.marketType:undefined,quoteCurrency:'quoteCurrency'in meta?meta.quoteCurrency:undefined},bars);check();
  let fundingData:ValidationReport['fundingData'];
  if(request.funding){
    const f=request.funding,seenTimes=new Set<number>();
    if(!Number.isFinite(f.from)||!Number.isFinite(f.to)||f.from>f.to)throw Error('资金费率覆盖范围无效。');
    for(const point of f.rates){if(![point.time,point.rate,point.markPrice].every(Number.isFinite)||point.markPrice<=0||point.time<f.from||point.time>f.to||seenTimes.has(point.time))throw Error('资金费率快照包含无效或重复事件。');seenTimes.add(point.time);}
    fundingData={hash:await fingerprint({from:f.from,to:f.to,rates:[...f.rates].sort((a,b)=>a.time-b.time)},[]),from:f.from,to:f.to,events:f.rates.length,coverageDeclared:true};
  }
  const reg=options.registry??new IndicatorRegistry();if(!options.registry)registerBuiltins(reg);
  for(const definition of options.definitions??[]){if(reg.list().some(d=>d.id===definition.id))throw Error(`自定义定义重复：${definition.id}`);reg.register(definition);}
  const studies=request.studies.map((study,index)=>{const def=reg.get(study.id);return {...study,params:{...reg.defaults(def.id),...study.params},instanceId:`validation:${index}`};});
  const compute=(end:number,expose=false)=>{
    check();const runtime=new IndicatorRuntime(reg);runtime.set(studies.map(s=>({id:s.id,params:s.params,instanceId:s.instanceId,timeframe:s.timeframe??'chart',baseIntervalMs:intervalMs})),true);
    return runtime.compute(view(end,expose),0);
  };
  const full=compute(n),fullByStudy=studies.map(s=>full.filter(line=>line.indicatorId===s.instanceId));
  const fraction=finite(request.holdoutFraction,.3,.1,.8),desired=Math.max(8,Math.floor(n*fraction)),holdout=Math.min(desired,Math.round(finite(request.maxHoldoutBars,512,8,2048)),n-24),split=n-holdout;
  const maxProbes=Math.round(finite(request.prefixProbes,64,4,128)),probeIndices=[...new Set(Array.from({length:maxProbes},(_,i)=>Math.round(24+(n-24)*(i+1)/maxProbes)))];
  const causality:ValidationReport['causality']={probes:probeIndices.length,comparisons:0,changedKnownFacts:0,futureEmissions:0,futureBackingDifferences:0,unmatchedPastFacts:0,ignoredDevelopingCandidates:0,status:'passed-sampled',issues:[]};
  for(let probe=0;probe<probeIndices.length;probe++){
    check();const end=probeIndices[probe],cutoff=availableTime(view(end),end-1),prefix=compute(end),backing=compute(end,true);
    studies.forEach((study,index)=>{
      const actual=knownFacts(prefix.filter(s=>s.indicatorId===study.instanceId),cutoff),exposed=knownFacts(backing.filter(s=>s.indicatorId===study.instanceId),cutoff),later=knownFacts(fullByStudy[index],cutoff);
      causality.futureEmissions+=actual.future;causality.ignoredDevelopingCandidates+=actual.ignored;
      const issue=(kind:string,factId:string)=>{if(causality.issues.length<80)causality.issues.push({studyId:study.id,prefixBars:end,kind,factId});};
      if(actual.future)issue('future-emission',`${actual.future} records`);
      const serialize=(facts:Map<string,Fact>)=>JSON.stringify([...facts.entries()].sort(([a],[b])=>a.localeCompare(b)));
      if(serialize(actual.facts)!==serialize(exposed.facts)||exposed.future!==actual.future){causality.futureBackingDifferences++;issue('future-backing-read','output');}
      for(const [id,fact] of actual.facts){const retained=later.facts.get(id);if(!retained){causality.unmatchedPastFacts++;continue;}causality.comparisons++;if(fact.payload!==retained.payload){causality.changedKnownFacts++;issue('known-fact-changed',id);}}
    });
    progress('causality',probe+1,probeIndices.length,5+30*(probe+1)/probeIndices.length);await yieldControl();
  }
  if(causality.changedKnownFacts||causality.futureEmissions||causality.futureBackingDifferences)causality.status='issues';
  if(causality.unmatchedPastFacts)warnings.push('部分旧记录未保留在最终窗口，可能来自显示上限、窗口滚动或合法候选撤销；未将缺失直接判为重绘，也未因此证明其不重绘。');
  const cfg=settings(request.research),atr=new Float64Array(n).fill(NaN);let ranges:number[]=[];
  for(let i=0;i<n;i++){if(!good[i]||!adjacent[i])ranges=[];if(!good[i])continue;const tr=Math.max(bars[i].high-bars[i].low,i&&adjacent[i]?Math.abs(bars[i].high-bars[i-1].close):0,i&&adjacent[i]?Math.abs(bars[i].low-bars[i-1].close):0);ranges.push(tr);if(ranges.length>14)ranges.shift();if(ranges.length>=5)atr[i]=ranges.reduce((a,b)=>a+b,0)/ranges.length;}
  const discovered:ValidationSignal[]=[],seen=new Set<string>(),signalsByEntry=new Map<number,ValidationSignal[]>();let unusable=0;
  const initial=compute(split);studies.forEach(study=>candidates(initial.filter(line=>line.indicatorId===study.instanceId),study).forEach(signal=>seen.add(signal.id)));
  for(let i=split;i<n;i++){
    const output=compute(i+1),cutoff=availableTime(view(i+1),i),previousCut=availableTime(view(i),i-1);
    for(const study of studies)for(const candidate of candidates(output.filter(line=>line.indicatorId===study.instanceId),study)){
      if(seen.has(candidate.id))continue;seen.add(candidate.id);
      if(candidate.availableAt<=previousCut||candidate.availableAt>cutoff||!good[i]){unusable++;continue;}
      const signal={...candidate,signalBar:i,observedAt:cutoff};discovered.push(signal);
      if(i+1>=n||!good[i+1]||!adjacent[i+1]||candidate.availableAt>bars[i+1].time){unusable++;continue;}
      const queue=signalsByEntry.get(i+1)??[];queue.push(signal);signalsByEntry.set(i+1,queue);
    }
    progress('holdout',i-split+1,holdout,35+60*(i-split+1)/holdout);await yieldControl();
  }
  const responseItems:ValidationResponse[]=[];let overlapping=0,lastResponseEnd=-1;
  for(const signal of discovered){
    const entry=signal.signalBar+1,end=entry+cfg.responseBars-1;
    if(end>=n||bars.slice(entry,end+1).some((_,j)=>!good[entry+j]||!adjacent[entry+j]))continue;
    const open=bars[entry].open,move=signal.direction*(bars[end].close/open-1)*100;
    const hi=Math.max(...bars.slice(entry,end+1).map(b=>b.high)),lo=Math.min(...bars.slice(entry,end+1).map(b=>b.low));
    responseItems.push({signal,entryBar:entry,endBar:end,directionalReturnPct:move,afterFrictionPct:move-2*(cfg.feeBps+cfg.slippageBps)/100,
      favorableExcursionPct:signal.direction===1?(hi/open-1)*100:(1-lo/open)*100,adverseExcursionPct:signal.direction===1?(lo/open-1)*100:(1-hi/open)*100});
    if(entry<=lastResponseEnd)overlapping++;lastResponseEnd=Math.max(lastResponseEnd,end);
  }
  const trades:ResearchTrade[]=[],equity:ValidationReport['research']['equity']=[];
  let active:{signal:ValidationSignal;entry:number;raw:number;fill:number;qty:number;stop:number;take:number}|undefined,
    cash=cfg.initialCapital,peak=cash,drawdown=0,ignored=0,conflicts=0;
  const fundingCovered=!!request.funding&&request.funding.from<=bars[split].time&&request.funding.to>=availableTime(view(n),n-1);
  const fundingBasis:ValidationReport['research']['fundingBasis']=!request.funding?'not-provided':fundingCovered?'covered':'partial';
  const closePosition=(index:number,rawPrice:number,reason:ResearchTrade['exitReason'],ambiguous=false)=>{
    if(!active)return;const p=active,side=p.signal.direction,fill=rawPrice*(1-side*cfg.slippageBps/10000),entryFee=p.qty*p.fill*cfg.feeBps/10000,exitFee=p.qty*fill*cfg.feeBps/10000;
    const gross=side*(rawPrice-p.raw)*p.qty,slippage=side*((p.fill-p.raw)+(rawPrice-fill))*p.qty;
    let funding=0;
    for(const point of request.funding?.rates??[]){if(![point.time,point.rate,point.markPrice].every(Number.isFinite)||point.markPrice<=0)continue;
      if(point.time>=bars[p.entry].time&&point.time<=availableTime(view(index+1),index)){
        const cost=side*p.qty*point.markPrice*point.rate;
        // Entry/exit-bar funding ordering is unknowable from OHLC. Debit the
        // adverse charge, omit an uncertain credit, and disclose this policy.
        funding+=point.time>=bars[index].time||point.time===bars[p.entry].time?Math.max(0,cost):cost;
      }}
    const net=gross-slippage-entryFee-exitFee-funding;cash+=gross-slippage-exitFee-funding;
    trades.push({id:`trade:${trades.length+1}`,signal:p.signal,side:side===1?'long':'short',entryBar:p.entry,exitBar:index,entryTime:bars[p.entry].time,exitTime:bars[index].time,
      entryPrice:p.fill,exitPrice:fill,quantity:p.qty,grossBeforeCosts:gross,slippageCost:slippage,fees:entryFee+exitFee,funding,net,exitReason:reason,ambiguous});active=undefined;
  };
  for(let i=split;i<n;i++){
    check();
    if(active&&(!good[i]||!adjacent[i]))closePosition(i-1,bars[i-1].close,'data-gap');
    const queue=signalsByEntry.get(i)??[];
    if(cfg.enabled&&queue.length){
      if(active)ignored+=queue.length;
      else if(new Set(queue.map(s=>s.direction)).size>1)conflicts+=queue.length;
      else if(good[i]&&adjacent[i]&&Number.isFinite(atr[i-1])){
        const signal=queue[0],raw=bars[i].open,fill=raw*(1+signal.direction*cfg.slippageBps/10000),qty=cfg.notional/fill;
        active={signal,entry:i,raw,fill,qty,stop:cfg.stopAtr?fill-signal.direction*atr[i-1]*cfg.stopAtr:NaN,take:cfg.takeAtr?fill+signal.direction*atr[i-1]*cfg.takeAtr:NaN};
        cash-=qty*fill*cfg.feeBps/10000;ignored+=queue.length-1;
      }else unusable+=queue.length;
    }
    if(active&&good[i]){
      const p=active,long=p.signal.direction===1,b=bars[i],hitStop=Number.isFinite(p.stop)&&(long?b.low<=p.stop:b.high>=p.stop),hitTake=Number.isFinite(p.take)&&(long?b.high>=p.take:b.low<=p.take);
      const gapStop=Number.isFinite(p.stop)&&(long?b.open<=p.stop:b.open>=p.stop);
      if(gapStop)closePosition(i,b.open,'stop');
      else if(hitStop)closePosition(i,p.stop,hitTake?'both-hit-stop-first':'stop',hitTake);
      else if(hitTake)closePosition(i,p.take,'take');
      else if(i-p.entry+1>=cfg.maxHoldBars)closePosition(i,b.close,'time');
      else if(i===n-1)closePosition(i,b.close,'data-end');
    }
    const mark=cash+(active&&good[i]?active.signal.direction*(bars[i].close-active.fill)*active.qty:0);peak=Math.max(peak,mark);drawdown=Math.max(drawdown,peak-mark);equity.push({time:bars[i].time,value:mark});
  }
  const sum=(key:'grossBeforeCosts'|'slippageCost'|'fees'|'funding'|'net')=>trades.reduce((s,t)=>s+t[key],0),net=sum('net'),wins=trades.filter(t=>t.net>0),losses=trades.filter(t=>t.net<0),positive=responseItems.filter(r=>r.afterFrictionPct>0).length;
  warnings.push('后段检验参数固定，不做自动选参。响应样本可能重叠；单持仓研究交易采用 next-open、固定名义金额，不模拟交易所最低数量、保证金、强平或真实委托队列。');
  warnings.push('事件响应的 afterFrictionPct 扣除双边固定基点作近似比较；交易清单按实际模拟成交额计算费用。最大回撤使用柱收盘盯市，资金费在退出结算。');
  warnings.push(fundingBasis==='not-provided'?'未提供资金费率：净值只扣手续费和滑点，不是包含合约资金费的完整净收益。':fundingBasis==='partial'?'资金费率覆盖不完整，净收益仍缺少未覆盖费用。':'资金费率按给定覆盖数据计入；出入场同柱资金费顺序不确定时只计不利支出。');
  warnings.push('同柱同时触及止损与止盈按止损先发生；缺口穿越止损按开盘成交。研究结果不证明存在可持续盈利优势。');
  const report:ValidationReport={version:'analysis-validation/1',status:'complete',startedAt,finishedAt:Date.now(),durationMs:performance.now()-began,
    dataset:{hash,hashAlgorithm:'SHA-256',symbol:meta.symbol,interval:meta.interval||`${intervalMs}ms`,source:meta.source,inputBars:raw.length,closedBars:n,excludedFormingBars:raw.length-n,from:bars[0]?.time??null,through:availableTime(view(n),n-1),gaps,invalidBars},
    ...(fundingData?{fundingData}:{}),
    studies:studies.map((s,i)=>{const versions=[...new Set(fullByStudy[i].flatMap(line=>(line.observations??[]).map(o=>o.ruleVersion)))].concat(fullByStudy[i].some(line=>line.patterns?.length)?['pattern-rule-version-not-declared']:[]);return {id:s.id,params:s.params,timeframe:s.timeframe??'chart',signalMode:defaultMode(s),ruleVersions:versions.length?versions:['not-observed-or-declared']};}),
    split:{trainingBars:split,holdoutBars:holdout,holdoutFrom:bars[split].time,holdoutThrough:availableTime(view(n),n-1),requestedFraction:fraction,capped:holdout<desired,parametersFrozen:true},causality,
    responses:{signals:discovered.length,evaluated:responseItems.length,unresolved:discovered.length-responseItems.length,overlapping,positiveAfterFriction:positive,positiveRate:responseItems.length?positive/responseItems.length:null,
      meanAfterFrictionPct:responseItems.length?responseItems.reduce((s,r)=>s+r.afterFrictionPct,0)/responseItems.length:null,items:responseItems},
    research:{enabled:cfg.enabled,settings:cfg,trades,ignoredWhilePositionOpen:ignored,conflictingSignals:conflicts,unusableSignals:unusable,grossBeforeCosts:sum('grossBeforeCosts'),slippageCost:sum('slippageCost'),fees:sum('fees'),funding:sum('funding'),net,endingEquity:cash,maxDrawdown:drawdown,
      winRate:trades.length?wins.length/trades.length:null,profitFactor:losses.length?wins.reduce((s,t)=>s+t.net,0)/-losses.reduce((s,t)=>s+t.net,0):null,equity,fundingBasis,
      conclusion:!cfg.enabled?'disabled':!trades.length?'no-signals':trades.length<20?'insufficient-sample':net<=0?'non-positive-sample':'positive-sample-only'},warnings};
  check();progress('complete',1,1,100);return report;
}
