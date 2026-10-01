import type {ColumnView} from '../core/types';
import type {ConfluenceSeries} from './confluence';
import type {PatternDivergenceEvidence, PatternMatch, PatternRatio, PatternSignals} from './types';

/**
 * Reading aids at a completed harmonic D.
 *
 * A harmonic completion is a price region, not a trigger: the usual practitioner reading (and the community
 * shorthand "…，30min 底背离，2atr 未扎") adds (1) momentum fading at D — a regular MACD divergence —, (2) a stop
 * measured in ATRs beyond D that has not been pierced, and (3) a rejection candle (pin bar) at D. Everything here
 * uses only candles that were closed when D became known, so the signals never repaint; the one dynamic fact,
 * whether a later wick pierced the ATR level ("扎"), is a lifecycle state (knowledge-lifecycle.ts).
 *
 * References for the rules: regular divergence = price makes a new (or, in the looser double-bottom / double-top
 * form, an equal) extreme while the oscillator does not — the same pair rule as `divergencePair` in confluence.ts;
 * momentum merely improving in the same direction as price is not a divergence. Stops "a buffer of ATR beyond D" are
 * common practice; the 2-ATR multiple is the community's, and is configurable.
 */
export interface HarmonicSignalOptions {
  /** ATR period (Wilder). */atrPeriod:number;
  /** ATR multiples beyond D for the reference stop. */atrMultiple:number;
  /** Half-width, in bars, of a confirmed swing for the fallback reference extreme. */radius:number;
}

/** |D − reference| within this share of the last (CD) leg counts as an equal extreme (double bottom / top). */
export const EQUAL_EXTREME_SHARE=.1;
/** DIF must differ by at least this share of the DIF range between the two extremes; smaller gaps are noise. */
export const MIN_DIF_SHARE=.03;
/** Pin bar: the rejecting wick covers at least this share of the candle, the body at most the second one. */
export const PIN_WICK_SHARE=.6, PIN_BODY_SHARE=.3;
/** Wilder smoothing is seeded this many periods back; older candles carry a negligible weight. */
const ATR_WARMUP_PERIODS=20;

/** Wilder ATR at `index`, seeded with the simple mean of the first `period` true ranges after `from`. */
export function wilderAtr(high:Float64Array,low:Float64Array,close:Float64Array,index:number,period:number,from:number):number|undefined {
  if(!Number.isInteger(period)||period<1||from<0||index-from<period)return;
  const tr=(i:number)=>Math.max(high[i]-low[i],Math.abs(high[i]-close[i-1]),Math.abs(low[i]-close[i-1]));
  let atr=0;
  for(let i=from+1;i<=from+period;i++)atr+=tr(i);
  atr/=period;
  for(let i=from+period+1;i<=index;i++)atr=(atr*(period-1)+tr(i))/period;
  return Number.isFinite(atr)&&atr>0?atr:undefined;
}

const num=(value:number)=>String(Number(value.toPrecision(6)));

/** Regular MACD(12,26,9) DIF divergence between D and the previous same-side extreme. */
function macdSignal(match:PatternMatch,view:ColumnView,series:ConfluenceSeries,dIndex:number,options:HarmonicSignalOptions):{macd:NonNullable<PatternSignals['macd']>;range:number}|undefined {
  const bull=match.direction==='bullish',price=bull?series.low:series.high,points=match.points;
  const last=points.length-1,cLeg=Math.abs(points[last-1].value-points[last].value);
  const cIndex=series.timeToIdx.get(points[last-1].time);
  const legBars=cIndex===undefined?0:dIndex-cIndex;
  const anchorIndices=new Set<number>();
  for(const point of points){const at=series.timeToIdx.get(point.time);if(at!==undefined)anchorIndices.add(at);}
  const dPrice=price[dIndex];
  if(!Number.isFinite(dPrice)||!(cLeg>0))return;

  const time=view.col('time');
  const r=Math.max(1,Math.round(options.radius));
  /** A same-side extreme over `r` candles on each side, all of them at or before `limit`. */
  const swingAt=(i:number,limit:number)=>{
    if(i-r<0||i+r>limit)return false;
    for(let k=1;k<=r;k++)if(bull?!(series.low[i]<=series.low[i-k]&&series.low[i]<series.low[i+k]):!(series.high[i]>=series.high[i-k]&&series.high[i]>series.high[i+k]))return false;
    return true;
  };
  const check=(ref:number,source:'anchors'|'swing'):{macd:NonNullable<PatternSignals['macd']>;range:number}|undefined=>{
    // Same reset segment, and far enough apart to be two separate swings.
    if(ref<0||ref>dIndex-3||series.segmentStart[ref]!==series.segmentStart[dIndex])return;
    const refPrice=price[ref],eps=Math.max(1e-12,Math.abs(refPrice)*1e-10);
    if(!Number.isFinite(refPrice))return;
    // The reference must be the swing D undercuts: a more extreme confirmed swing in between makes that one the
    // previous extreme instead. (Price passing through the reference level on the way to D is not a swing.)
    for(let i=ref+1;i<dIndex;i++)if((bull?series.low[i]<refPrice-eps:series.high[i]>refPrice+eps)&&swingAt(i,dIndex-1))return;
    const fresh=bull?dPrice<refPrice-eps:dPrice>refPrice+eps;
    const equal=!fresh&&Math.abs(dPrice-refPrice)<=EQUAL_EXTREME_SHARE*cLeg;
    if(!fresh&&!equal)return;
    const difRef=series.macd[ref],difD=series.macd[dIndex];
    if(!Number.isFinite(difRef)||!Number.isFinite(difD))return;
    let lo=Infinity,hi=-Infinity;
    for(let i=ref;i<=dIndex;i++){const v=series.macd[i];if(!Number.isFinite(v))return;if(v<lo)lo=v;if(v>hi)hi=v;}
    const minDelta=Math.max(1e-12,MIN_DIF_SHARE*(hi-lo));
    if(bull?!(difD>difRef+minDelta):!(difD<difRef-minDelta))return;
    return {range:hi-lo,macd:{kind:match.direction,source,...(equal?{equalExtreme:true}:{}),
      first:{time:time[ref],price:refPrice,dif:difRef},second:{time:time[dIndex],price:dPrice,dif:difD}}};
  };

  // 1. The shape's own earlier same-side anchors, nearest first (points alternate high / low, D is last).
  for(let k=last-2;k>=0;k-=2){
    const ref=series.timeToIdx.get(points[k].time);
    if(ref===undefined)continue;
    const hit=check(ref,'anchors');
    if(hit)return hit;
  }
  // 2. The nearest confirmed swing of the same side before D that is not one of the anchors.
  const from=Math.max(series.segmentStart[dIndex]+r,dIndex-Math.max(3*legBars,60));
  for(let i=dIndex-r-1;i>=from;i--){
    if(anchorIndices.has(i)||!swingAt(i,dIndex-1))continue;
    const hit=check(i,'swing');
    if(hit)return hit;
  }
}
function pinSignal(match:PatternMatch,view:ColumnView,dIndex:number):PatternSignals['pin'] {
  const o=view.col('open')[dIndex],h=view.col('high')[dIndex],l=view.col('low')[dIndex],c=view.col('close')[dIndex];
  const range=h-l;
  if(![o,h,l,c].every(Number.isFinite)||!(range>0))return;
  const bull=match.direction==='bullish',body=Math.abs(c-o)/range,wick=bull?(Math.min(o,c)-l)/range:(h-Math.max(o,c))/range;
  // The body sits at the far end from the rejected side: the top 40% for a bullish pin, the bottom 40% for a bearish one.
  const placed=bull?Math.min(o,c)>=l+.6*range-1e-12:Math.max(o,c)<=h-.6*range+1e-12;
  if(wick>=PIN_WICK_SHARE-1e-12&&body<=PIN_BODY_SHARE+1e-12&&placed)return {wickShare:wick,bodyShare:body};
}

function atrSignal(match:PatternMatch,series:ConfluenceSeries,view:ColumnView,dIndex:number,options:HarmonicSignalOptions):PatternSignals['atr'] {
  const start=Math.max(series.segmentStart[dIndex],dIndex-options.atrPeriod*ATR_WARMUP_PERIODS);
  const value=wilderAtr(view.col('high'),view.col('low'),view.col('close'),dIndex,options.atrPeriod,start);
  if(value===undefined)return;
  const d=match.points.at(-1)!.value,side=match.direction==='bullish'?1:-1;
  return {period:options.atrPeriod,value,multiple:options.atrMultiple,level:d-side*options.atrMultiple*value};
}

export interface HarmonicSignalResult {signals:PatternSignals;divergences:PatternDivergenceEvidence[];ratios:PatternRatio[];sentences:string[]}

/** Signals for one confirmed match, or undefined when D cannot be located on the closed candles. */
export function harmonicSignals(match:PatternMatch,view:ColumnView,series:ConfluenceSeries,options:HarmonicSignalOptions):HarmonicSignalResult|undefined {
  const d=match.points.at(-1);
  if(!d||match.points.length<3)return;
  const dIndex=series.timeToIdx.get(d.time);
  if(dIndex===undefined||dIndex>=series.closedCount)return;
  const signals:PatternSignals={},divergences:PatternDivergenceEvidence[]=[],ratios:PatternRatio[]=[],sentences:string[]=[];

  const found=macdSignal(match,view,series,dIndex,options);
  if(found){
    const {macd,range}=found;
    signals.macd=macd;
    divergences.push({indicator:'macd',series:'dif',params:{fast:12,slow:26,signal:9},
      points:[{time:macd.first.time,value:macd.first.dif},{time:macd.second.time,value:macd.second.dif}]});
    const bull=macd.kind==='bullish',first=macd.first.dif,second=macd.second.dif;
    ratios.push({label:'DIF 差 / DIF 极差',value:Math.abs(second-first)/range,expected:`≥ ${MIN_DIF_SHARE.toFixed(3)}`});
    sentences.push(`D 点具备 MACD(12,26,9) DIF ${bull?'底背离':'顶背离'}${macd.equalExtreme?'（等高型）':''}：价格 ${num(macd.second.price)} 对 ${num(macd.first.price)}，DIF ${num(second)} 对 ${num(first)}。`);
    sentences.push(macd.source==='anchors'?'背离参照的前一极值取自形态自身的锚点。':'背离参照的前一极值是 D 之前最近的同侧摆动（不是形态锚点）。');
  }
  const atr=atrSignal(match,series,view,dIndex,options);
  if(atr){
    signals.atr=atr;
    sentences.push(`ATR(${atr.period}) = ${num(atr.value)}，D 外侧 ${num(atr.multiple)} ATR 的参考位为 ${num(atr.level)}；是否被影线刺穿以后续已收盘 K 线判断。`);
  }
  const pin=pinSignal(match,view,dIndex);
  if(pin){
    signals.pin=pin;
    sentences.push(`D 点 K 线为针形（影线占 ${(pin.wickShare*100).toFixed(0)}%，实体占 ${(pin.bodyShare*100).toFixed(0)}%）。`);
  }
  return {signals,divergences,ratios,sentences};
}
