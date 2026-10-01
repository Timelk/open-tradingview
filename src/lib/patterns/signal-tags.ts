import type {PatternMatch} from './types';
import {formatMarketPrice} from '../core/market-format';

/**
 * Reading aids around a completed harmonic D, as short tags. Professionals read a harmonic completion together with
 * momentum (MACD divergence at D), an ATR-sized stop ("2ATR未扎": the wick has not gone two ATRs beyond D), the D candle
 * (a pin bar) and smaller structures at the end of the last leg. The first three come from the match itself
 * (`PatternMatch.signals`, computed by the worker from closed candles); the structure and multi-timeframe tags come from
 * `resonance.ts`. A tag is evidence for the reader, never an order, a fill or a win probability.
 */
export type SignalTagKind='macd'|'multi-tf'|'terminal'|'lower-tf'|'atr'|'pin';
export interface SignalTag {
  kind:SignalTagKind;
  /** Chinese source text; translate it with the canonical translator (templates match the filled-in numbers). */
  label:string;
  /** good: supports the reading; warn: has failed; neutral: context only. */
  tone:'good'|'warn'|'neutral';
  /** One sentence with the numbers behind the tag. */
  detail:string;
  /** The other match the tag is about (a tag from `resonance.ts`), so the panel can jump to it. */
  target?:{instanceId:string;patternId:string};
}

/** Most decisive first: divergence, then other timeframes, then structure at the end, then the stop and the candle. */
export const SIGNAL_TAG_ORDER:readonly SignalTagKind[]=['macd','multi-tf','terminal','lower-tf','atr','pin'];
export function orderSignalTags<T extends {kind:SignalTagKind}>(tags:readonly T[]):T[] {
  const rank=(kind:SignalTagKind)=>SIGNAL_TAG_ORDER.indexOf(kind);
  return tags.map((tag,index)=>({tag,index})).sort((a,b)=>rank(a.tag.kind)-rank(b.tag.kind)||a.index-b.index).map(item=>item.tag);
}

const compact=(value:number)=>Number.isFinite(value)?Number(value.toPrecision(3)).toString():'—';
const multipleText=(value:number)=>Number.isFinite(value)?String(Math.round(value*100)/100):'—';

/** Tags from the match's own signals. A match without `signals` (an older result, another family) has none. */
export function patternSignalTags(pattern:PatternMatch):SignalTag[] {
  const signals=pattern.signals;
  if(!signals)return [];
  const tags:SignalTag[]=[];
  const macd=signals.macd;
  if(macd){
    const bullish=macd.kind==='bullish',equal=macd.equalExtreme===true;
    const prev=formatMarketPrice(macd.first.price),now=formatMarketPrice(macd.second.price);
    const from=compact(macd.first.dif),to=compact(macd.second.dif);
    const label=`MACD ${equal?'等高':''}${bullish?'底背离':'顶背离'}`;
    const detail=bullish
      ?equal?`D 点与前一低点几乎等高（${prev} → ${now}），MACD 的 DIF 由 ${from} 升至 ${to}：等高底背离。`
        :`D 点低于前一低点（${prev} → ${now}），MACD 的 DIF 却由 ${from} 升至 ${to}：动能没有跟随价格创新低（底背离）。`
      :equal?`D 点与前一高点几乎等高（${prev} → ${now}），MACD 的 DIF 由 ${from} 降至 ${to}：等高顶背离。`
        :`D 点高于前一高点（${prev} → ${now}），MACD 的 DIF 却由 ${from} 降至 ${to}：动能没有跟随价格创新高（顶背离）。`;
    tags.push({kind:'macd',label,tone:'good',detail});
  }
  const atr=signals.atr;
  if(atr){
    const multiple=multipleText(atr.multiple),head=`ATR(${atr.period}) = ${compact(atr.value)}；D 点外侧 ${multiple} 倍 ATR 位于 ${formatMarketPrice(atr.level)}`;
    if(pattern.atrPierced)tags.push({kind:'atr',label:`${multiple}ATR已扎`,tone:'warn',detail:`${head}，已被影线刺穿（价格 ${formatMarketPrice(pattern.atrPierced.price)}）。`});
    else tags.push({kind:'atr',label:`${multiple}ATR未扎`,tone:'good',detail:`${head}，此后闭合 K 线的影线尚未刺穿它。`});
  }
  const pin=signals.pin;
  if(pin)tags.push({kind:'pin',label:'D 针形K',tone:'good',
    detail:`D 点 K 线的长影线占振幅 ${Math.round(pin.wickShare*100)}%，实体仅占 ${Math.round(pin.bodyShare*100)}%：向 PRZ 外侧拒绝价格的针形 K。`});
  return orderSignalTags(tags);
}

/** The panel's "共振" filter. Only harmonic matches carry these tags, so any filter other than "all" hides the rest. */
export type ResonanceFilter='all'|'macd'|'atr'|'terminal'|'multi';
export const RESONANCE_FILTERS:readonly ResonanceFilter[]=['all','macd','atr','terminal','multi'];
export function matchesResonanceFilter(filter:ResonanceFilter,tags:readonly SignalTag[]):boolean {
  switch(filter){
    case 'all':return true;
    case 'macd':return tags.some(tag=>tag.kind==='macd');
    // "未扎" only: a pierced stop is the opposite of what the filter asks for.
    case 'atr':return tags.some(tag=>tag.kind==='atr'&&tag.tone==='good');
    case 'terminal':return tags.some(tag=>tag.kind==='terminal'||tag.kind==='lower-tf');
    case 'multi':return tags.some(tag=>tag.kind==='multi-tf');
  }
}
