import type {ColumnView, ParamValues} from '../core/types';
import type {AnalysisEvent, AnalysisObservation} from './types';

/** An event-first, OHLCV-observable subset of Wyckoff. These are competing
 * range interpretations, not observations of institutional inventory. */
const VERSION = 'wyckoff-events-1';
interface Settings {
  radius:number; lookback:number; minBars:number; maxBars:number;
  minAtr:number; tolerance:number; breakout:number; volumeRatio:number; limit:number;
}
interface Frame {
  index:number; time:number; open:number; high:number; low:number; close:number;
  volume:number; atr:number; relativeVolume:number; spread:number;
}
interface Pivot {frame:Frame; kind:'low'|'high'; availableAt:number}
interface Clock {step:number; monthly:boolean}
interface Range {
  seed:Pivot; rally:Pivot; bottom:number; top:number; atr:number;
  observation:AnalysisObservation; lastIndex:number; lastTest:number;
  spring?:{index:number;price:number}; excursion?:{index:number;price:number;extreme:Frame};
  breakoutIndex?:number; departureBars:number; stopped:boolean;
}
const bounded = (p:ParamValues, key:string, fallback:number, min:number, max:number) => {
  const value = Number(p[key]);
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
};
function settings(p:ParamValues):Settings {
  const minBars = Math.round(bounded(p, 'minRangeBars', 12, 6, 120));
  return {
    radius:Math.round(bounded(p, 'pivotStrength', 2, 1, 6)),
    lookback:Math.round(bounded(p, 'lookback', 1800, 100, 5000)), minBars,
    maxBars:Math.max(minBars * 2, Math.round(bounded(p, 'maxRangeBars', 240, 30, 1500))),
    minAtr:bounded(p, 'rangeMinAtr', 2, 1, 10),
    tolerance:bounded(p, 'boundaryToleranceAtr', .3, .05, 1),
    breakout:bounded(p, 'breakoutAtr', .3, .05, 1.5),
    volumeRatio:bounded(p, 'volumeRatio', 1.35, 1, 3),
    limit:Math.round(bounded(p, 'maxObservations', 24, 4, 80)),
  };
}
const unique = (list:string[], value:string) => {if (!list.includes(value)) list.push(value);};
const mirror = (f:Frame, side:1|-1):Frame => side === 1 ? f : {
  ...f, open:-f.open, high:-f.low, low:-f.high, close:-f.close,
};
const fmt = (n:number) => n.toFixed(2);
const closeTime=(time:number, clock:Clock) => {
  if(!clock.monthly)return time+clock.step;
  const date=new Date(time);
  return Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1);
};

function event(range:Range, f:Frame, side:1|-1, kind:string, label:string,
  price:number, explanation:string, availableAt:number):void {
  const e:AnalysisEvent = {
    id:`${range.observation.id}:${kind}:${f.time}`, kind, label,
    time:f.time, availableAt, price:price * side, explanation,
  };
  if (range.observation.events.some(item => item.id === e.id)) return;
  // A repeated-test range is allowed, but an arbitrarily long sideways market
  // must not create an unbounded render/transport payload.
  if (range.observation.events.length >= 48) {
    range.observation.events.splice(2, 1);
    unique(range.observation.counterEvidence, '事件较密集，列表保留初始边界与最近 46 个事件');
  }
  range.observation.events.push(e);
}

function seedHasTrend(frames:Frame[], at:number):boolean {
  if (at < 12) return false;
  const f=frames[at], older=frames.slice(Math.max(0, at-16), at-5);
  const mean=older.reduce((sum, bar) => sum+bar.close, 0)/older.length;
  const recent=frames.slice(at-5, at).reduce((sum, bar) => sum+bar.close, 0)/5;
  return mean-f.low >= f.atr*2 && mean-recent >= f.atr*.6;
}

function createRange(seed:Pivot, rally:Pivot, side:1|-1, cfg:Settings):Range|null {
  const bottom=seed.frame.low, top=rally.frame.high, atr=seed.frame.atr;
  if (rally.frame.index-seed.frame.index < cfg.radius+1 || top-bottom < atr*cfg.minAtr) return null;
  const bullish=side===1, direction=bullish?'bullish':'bearish';
  const climax=seed.frame.relativeVolume>=cfg.volumeRatio && seed.frame.spread>=1.1;
  const observation:AnalysisObservation = {
    id:`wyckoff:${direction}:${seed.frame.time}:${rally.frame.time}`,
    family:'wyckoff', name:bullish?'威科夫 · 吸筹假设':'威科夫 · 派发假设',
    ruleVersion:VERSION, direction, state:'observing', time:seed.frame.time,
    availableAt:rally.availableAt, throughTime:rally.frame.time,
    points:[], events:[], evidence:[], counterEvidence:[], waitingFor:[],
    phase:'阶段 A 假设 · 趋势停顿',
    alternatives:[bullish?'下跌中的继续整理 / 再派发':'上涨中的继续整理 / 再吸筹', '区间尚未形成明确方向'],
  };
  const range:Range = {seed, rally, bottom, top, atr, observation,
    lastIndex:rally.frame.index, lastTest:seed.frame.index, departureBars:0, stopped:false};
  event(range, seed.frame, side, climax?(bullish?'SC':'BC'):'PAUSE',
    climax?(bullish?'SC 候选':'BC 候选'):'趋势停顿', bottom,
    climax?'此前趋势后出现相对放量与宽幅；高潮事件仍为量价候选，未证明吸筹或派发'
      :'此前趋势出现可知拐点，但量价证据不足以命名为高潮事件', seed.availableAt);
  event(range, rally.frame, side, 'AR', bullish?'AR 反弹':'AR 回落', top,
    '反向波段建立区间另一侧；右侧确认柱收盘后才可知', rally.availableAt);
  observation.evidence.push(`初始反向波段高度 ${fmt((top-bottom)/atr)} ATR`,
    '边界由已确认拐点建立；量价只用于解释，不代表参与者身份');
  if (!climax) observation.counterEvidence.push('缺少明确高潮量价，保留无高潮的趋势停止分支');
  if (!Number.isFinite(seed.frame.relativeVolume)) observation.dataWarning='成交量缺失或历史不足，量价证据不完整';
  observation.waitingFor=['更多区间测试与价格进展；不要求必须出现 Spring / UTAD'];
  return range;
}

function finishGeometry(range:Range, f:Frame, side:1|-1):void {
  const o=range.observation;
  o.throughTime=f.time;
  const low=side===1?range.bottom:-range.top, high=side===1?range.top:-range.bottom;
  o.zone={low, high, fromTime:range.seed.frame.time, toTime:f.time};
  o.lines=[
    {role:'boundary', label:'区间上界', points:[
      {label:'',time:range.seed.frame.time,value:high},{label:'',time:f.time,value:high}]},
    {role:'boundary', label:'区间下界', points:[
      {label:'',time:range.seed.frame.time,value:low},{label:'',time:f.time,value:low}]},
  ];
  o.points=o.events.map(e => ({label:e.label,time:e.time,value:e.price}));
}

function updateRange(range:Range, f:Frame, previous:Frame, pivot:Pivot|undefined,
  side:1|-1, clock:Clock, cfg:Settings):void {
  if (range.stopped) return;
  const o=range.observation, bullish=side===1, height=range.top-range.bottom;
  const atr=Math.max(f.atr,range.atr*.5), tolerance=atr*cfg.tolerance;
  const breakoutBuffer=atr*cfg.breakout, age=f.index-range.seed.frame.index;
  const known=closeTime(f.time,clock);
  range.lastIndex=f.index;
  if (!Number.isFinite(f.relativeVolume)) o.dataWarning='成交量缺失或历史不足，量价证据不完整';

  // Breaching support is an observation, not immediate invalidation: allow a
  // prompt closed-bar reclaim. It never scans ahead to find a convenient return.
  if (f.low<range.bottom-tolerance*.5) {
    if (!range.excursion) range.excursion={index:f.index,price:f.low,extreme:f};
    else if(f.low<range.excursion.price) {
      range.excursion.price=f.low;range.excursion.extreme=f;
    }
  }
  if (range.excursion) {
    if (f.close>=range.bottom && f.index-range.excursion.index<=3) {
      if (age>=cfg.minBars) {
        range.spring={index:f.index,price:range.excursion.price};
        event(range,range.excursion.extreme,side,bullish?'SPRING':'UT',bullish?'Spring':'UT',
          range.excursion.price,
          `越过既有区间边界后在 ${f.index-range.excursion.index+1} 根闭柱内收回；需后续测试与跟随验证`,known);
        o.phase='阶段 C 假设 · 越界收回';
        o.state='observing';
        o.waitingFor=[bullish?'更高低点的缩量测试，或直接出现强势突破':'更低高点的缩量测试，或直接出现弱势跌破'];
      }
      range.excursion=undefined;
    } else if (f.index-range.excursion.index>=3 && f.close<range.bottom-tolerance) {
      event(range,f,side,'RANGE_FAILURE','区间失守',f.close,
        '越界后未及时收回，原方向假设的边界证据被破坏',known);
      o.state='invalidated';o.invalidatedAt=known;
      o.phase='原区间假设失效';o.waitingFor=[];
      o.counterEvidence.push('边界外持续收盘，原吸筹 / 派发假设停止追踪');
      range.stopped=true;
    } else if (f.index-range.excursion.index>3 && f.close>=range.bottom) {
      // Late recovery cannot be back-labelled as a timely Spring.
      unique(o.counterEvidence,'曾长时间越过边界，后续回收不追溯命名为 Spring / UT');
      range.excursion=undefined;
    }
  }
  if (!range.stopped && pivot?.kind==='low' && pivot.frame.index>range.rally.frame.index
    && pivot.frame.index-range.lastTest>=Math.max(3,cfg.radius*2)) {
    const p=pivot.frame;
    const shallow=p.low>=range.bottom-tolerance && p.low<=range.bottom+height*.35;
    if (range.breakoutIndex!==undefined && p.index>range.breakoutIndex
      && p.low>=range.top-tolerance && p.low<=range.top+atr && f.close>=range.top-tolerance) {
      event(range,p,side,bullish?'LPS':'LPSY',bullish?'LPS':'LPSY',p.low,
        '离开区间后回测原边界；阶段方向仍是解释，非成交信号',pivot.availableAt);
      o.phase='阶段 D 假设 · 突破后回测';
      o.waitingFor=['回测后是否继续沿突破方向推进'];range.lastTest=p.index;
      if (p.relativeVolume>cfg.volumeRatio) unique(o.counterEvidence,'回测并未缩量，供需测试证据存在冲突');
      else if (Number.isFinite(p.relativeVolume)) unique(o.evidence,'突破后回测的相对量能未扩张');
    } else if (shallow && age>=cfg.minBars) {
      const isTest=range.spring!==undefined && p.index>range.spring.index && p.low>range.spring.price;
      event(range,p,side,isTest?'TEST':'ST',isTest?'Test':'ST',p.low,
        isTest?'越界收回之后形成更高的测试低点（看空方向镜像）':'再次接近既有边界；ST 可重复，不强制完整事件链',pivot.availableAt);
      range.lastTest=p.index;
      o.phase=isTest?'阶段 C 假设 · 边界测试':'阶段 B 假设 · 区间测试';
      o.state='observing';
      o.waitingFor=[bullish?'向上价格进展与 SOS；Spring 不是必需条件':'向下价格进展与 SOW；UTAD 不是必需条件'];
      if (Number.isFinite(p.relativeVolume) && Number.isFinite(range.seed.frame.relativeVolume)) {
        if (p.relativeVolume<range.seed.frame.relativeVolume) unique(o.evidence,'测试的相对量能低于初始停顿');
        else unique(o.counterEvidence,'测试量能未低于初始停顿，不能据此认定供需耗尽');
      }
    }
  }
  if (!range.stopped && age>=cfg.minBars) {
    const progress=f.close-previous.close, closePosition=(f.close-f.low)/Math.max(f.high-f.low,Number.EPSILON);
    const outside=f.close>range.top+breakoutBuffer;
    if (outside && range.breakoutIndex===undefined && progress>atr*.25 && closePosition>=.6) {
      range.breakoutIndex=f.index;
      event(range,f,side,bullish?'SOS':'SOW',bullish?'SOS':'SOW',f.close,
        `闭柱离开区间，价格进展 ${fmt(progress/atr)} ATR；量能为独立证据`,known);
      o.state='confirmed';o.phase='阶段 D 假设 · 已观察到突破';
      o.evidence.push('价格收盘突破已建立区间；确认的是突破事件，非机构意图');
      if (f.relativeVolume>=cfg.volumeRatio) unique(o.evidence,'突破柱的相对量能扩张');
      else unique(o.counterEvidence,'突破未见充分量能扩张，方向假设仍需跟随验证');
      o.waitingFor=[bullish?'原阻力附近的 LPS 回测，或持续离开区间':'原支撑附近的 LPSY 回测，或持续离开区间'];
    } else if (range.breakoutIndex!==undefined && f.close<range.top-breakoutBuffer) {
      event(range,f,side,'RETURN','突破回收',f.close,'突破后重新收回区间，原方向证据减弱',known);
      o.state='observing';o.phase='阶段待定 · 突破回收';
      unique(o.counterEvidence,'突破后回到区间内，不能将此前突破当作趋势已成立');
      o.waitingFor=['区间内重新测试，或新的有效突破'];
      range.breakoutIndex=undefined;range.departureBars=0;
    }
    // Stop tracking a historical range after sustained departure. This is not
    // a target or a profitable trade, and a much later decline cannot rewrite it.
    if (range.breakoutIndex!==undefined && f.close>range.top+height*.5) range.departureBars++;
    else range.departureBars=0;
    if (range.departureBars>=3) {
      o.phase='阶段 E 假设 · 持续离开区间';o.waitingFor=[];
      o.trackingEndedAt=known;o.trackingEndReason='departure';
      unique(o.evidence,'连续闭柱持续离开原区间，本段观察结束');range.stopped=true;
    }
  }
  if (!range.stopped && age>=cfg.maxBars) {
    unique(o.counterEvidence,'达到本级别最大观察跨度；没有补造突破或结束价位');
    o.trackingEndedAt=known;o.trackingEndReason='expired';
    o.waitingFor=[];range.stopped=true;
  }
  finishGeometry(range,f,side);
}

function scanSegment(frames:Frame[], side:1|-1, clock:Clock, cfg:Settings, results:AnalysisObservation[], broken:boolean):void {
  const data=frames.map(f=>mirror(f,side)), radius=cfg.radius;
  let seed:Pivot|undefined, active:Range|undefined;
  for (let i=radius*2; i<data.length; i++) {
    const center=i-radius, f=data[i], p=data[center];
    let low=true, high=true;
    for (let k=center-radius;k<=i;k++) {
      if (k===center) continue;
      low=low && (k<center?p.low<=data[k].low:p.low<data[k].low);
      high=high && (k<center?p.high>=data[k].high:p.high>data[k].high);
    }
    // Outside bars have no observable intrabar ordering; skip ambiguous pivots.
    const pivot:Pivot|undefined=low!==high?{frame:p,kind:low?'low':'high',availableAt:closeTime(f.time,clock)}:undefined;
    if (active && !active.stopped) updateRange(active,f,data[i-1],pivot,side,clock,cfg);
    if (active?.stopped) {results.push(active.observation);active=undefined;seed=undefined;}
    if (!active && pivot) {
      if (pivot.kind==='low' && seedHasTrend(data,center)) {
        if (!seed || p.low<seed.frame.low || p.index-seed.frame.index>cfg.maxBars/2) seed=pivot;
      } else if (pivot.kind==='high' && seed && pivot.frame.index>seed.frame.index) {
        const next=createRange(seed,pivot,side,cfg);
        if (next) {
          active=next;
          // Geometry and evidence end at the last actually closed confirmation
          // candle, never the historical AR anchor alone.
          updateRange(active,f,data[i-1],undefined,side,clock,cfg);
        }
      }
    }
    if (seed && f.index-seed.frame.index>cfg.maxBars/2) seed=undefined;
  }
  if (active) {
    if (broken) {
      active.observation.dataWarning='后续 K 线缺失或异常；该区间止于连续有效数据，不跨缺口续接';
      active.observation.waitingFor=[];
    }
    results.push(active.observation);
  }
}

/** Only exchange-closed candles are evaluated. With no explicit closedLength,
 * the final candle is forming. Work is bounded by lookback + 64 warm-up bars. */
export function detectWyckoff(cols:ColumnView, params:ParamValues={}):AnalysisObservation[] {
  const cfg=settings(params), end=Math.max(0,Math.min(cols.length,
    cols.closedLength===undefined?cols.length-1:Math.floor(cols.closedLength)));
  if (end<24) return [];
  const t=cols.col('time'), o=cols.col('open'), h=cols.col('high'),
    l=cols.col('low'), c=cols.col('close'), v=cols.col('volume');
  const start=Math.max(0,end-cfg.lookback-64), visibleStart=Math.max(start,end-cfg.lookback);
  const intervals:number[]=[];
  for (let i=start+1;i<end&&intervals.length<32;i++) {
    const d=t[i]-t[i-1];if(Number.isFinite(d)&&d>0) intervals.push(d);
  }
  if (!intervals.length) return [];
  intervals.sort((a,b)=>a-b);
  const step=intervals[Math.floor((intervals.length-1)/2)];
  if (!(step>0)) return [];
  let firstTime:number|undefined;
  for(let i=start;i<end;i++)if(Number.isFinite(t[i])){firstTime=t[i];break;}
  const first=firstTime===undefined?undefined:new Date(firstTime);
  const clock:Clock={step,monthly:step>=27*86_400_000&&step<=32*86_400_000
    &&first?.getUTCDate()===1&&first.getUTCHours()===0&&first.getUTCMinutes()===0};
  const results:AnalysisObservation[]=[];
  let segment:Frame[]=[], trueRanges:number[]=[], volumes:number[]=[];
  const flush=(broken:boolean) => {
    if(segment.length>=24) {
      scanSegment(segment,1,clock,cfg,results,broken);
      scanSegment(segment,-1,clock,cfg,results,broken);
    }
    segment=[];trueRanges=[];volumes=[];
  };
  for (let i=start;i<end;i++) {
    const valid=[t[i],o[i],h[i],l[i],c[i]].every(Number.isFinite)
      && h[i]>=Math.max(o[i],c[i]) && l[i]<=Math.min(o[i],c[i]) && h[i]>=l[i];
    if (!valid) {flush(true);continue;}
    const previous=segment.at(-1);
    if (previous && Math.abs(t[i]-closeTime(previous.time,clock))>step*.05) flush(true);
    const prior=segment.at(-1);
    const tr=Math.max(h[i]-l[i],prior?Math.abs(h[i]-prior.close):0,prior?Math.abs(l[i]-prior.close):0);
    const avg=trueRanges.length?trueRanges.reduce((sum,n)=>sum+n,0)/trueRanges.length:tr;
    const atr=Math.max(avg,Number.EPSILON*Math.max(1,Math.abs(c[i])));
    const averageVolume=volumes.length>=10?volumes.reduce((sum,n)=>sum+n,0)/volumes.length:NaN;
    const validVolume=Number.isFinite(v[i])&&v[i]>=0;
    segment.push({index:i,time:t[i],open:o[i],high:h[i],low:l[i],close:c[i],volume:v[i],atr,
      relativeVolume:validVolume&&averageVolume>0?v[i]/averageVolume:NaN,spread:(h[i]-l[i])/atr});
    trueRanges.push(tr);if(trueRanges.length>14)trueRanges.shift();
    if(validVolume) {volumes.push(v[i]);if(volumes.length>20)volumes.shift();}
  }
  flush(false);
  return results.filter(item=>item.throughTime>=t[visibleStart])
    .sort((a,b)=>b.throughTime-a.throughTime||b.availableAt-a.availableAt).slice(0,cfg.limit);
}
