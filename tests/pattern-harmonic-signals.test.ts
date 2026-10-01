import {describe,expect,it} from 'vitest';
import {ClosedRangeIndex} from '../src/lib/analysis/closed-range-index';
import {buildConfluenceSeries} from '../src/lib/patterns/confluence';
import {detectHarmonics} from '../src/lib/patterns/harmonic';
import {harmonicSignals,wilderAtr} from '../src/lib/patterns/harmonic-signals';
import {refreshPatternKnowledge} from '../src/lib/patterns/knowledge-lifecycle';
import {patternChartLabel} from '../src/lib/patterns/presentation';
import type {PatternMatch} from '../src/lib/patterns/types';
import {translateCanonical} from '../src/lib/i18n';
import {untranslated} from './fixtures/huzi-english';
import {HOUR,plantHarmonic,referenceAtr,type PlantOptions} from './fixtures/harmonic-signals-planted';

const params={pivotStrength:2,tolerance:.04,showInvalidated:true,maxPatterns:100,family:'AB=CD'};
/** A→B fast then C→D a slow grind: DIF at D is weaker than at B although price is lower. */
const EXHAUSTED=[12,10,45];
/** A→B slow, C→D long and steady: DIF confirms the new low. */
const CONFIRMING=[45,10,20];
const AB_CD=[200,140,180,120];
const plant=(bars:number[],extra:Partial<PlantOptions>={})=>plantHarmonic({prices:AB_CD,bars,...extra});
const detect=(t:ReturnType<typeof plantHarmonic>,extra:Record<string,unknown>={})=>detectHarmonics(t.view,{...params,...extra});
/** The match whose D is the planted one (a stab below D can complete a second shape of its own). */
const one=(t:ReturnType<typeof plantHarmonic>,extra:Record<string,unknown> = {})=>{
  const dTime=t.store.col('time')[t.dIndex],matches=detect(t,extra).filter(match=>match.points.at(-1)!.time===dTime);
  expect(matches).toHaveLength(1);
  return matches[0];
};
const optionsOf={atrPeriod:14,atrMultiple:2,radius:2};
const seriesOf=(t:ReturnType<typeof plantHarmonic>)=>buildConfluenceSeries(t.view,50,{requireContinuousTime:true});
/** A hand-built match on chosen candles: shape rules are not under test here, the signals are. */
function manual(t:ReturnType<typeof plantHarmonic>,indices:number[],direction:'bullish'|'bearish'='bullish'):PatternMatch {
  const high=t.store.col('high'),low=t.store.col('low'),time=t.store.col('time');
  const points=indices.map((i,k)=>({label:'ABCDEF'[k],time:time[i],value:(direction==='bullish'?k%2===0:k%2===1)?high[i]:low[i]}));
  return {id:'manual',family:'AB=CD',name:'手工',direction,points,confirmedAt:time[indices.at(-1)!+3],zone:{low:0,high:1},invalidation:0,targets:[1],ratios:[],description:'',status:'confirmed'};
}
const truncated=(t:ReturnType<typeof plantHarmonic>,length:number)=>({length,closedLength:length-1,intervalMs:HOUR,col:(name:'time'|'open'|'high'|'low'|'close'|'volume')=>t.store.col(name)}) as never;

describe('Wilder ATR',()=>{
  it('matches a hand calculation: seed with the mean of the first true ranges, then smooth',()=>{
    // TR1..TR5 = 3, 3, 2, 3, 2 (see the arithmetic in the assertions).
    const high=Float64Array.from([10,12,13,12,14,15]),low=Float64Array.from([8,9,10,10,11,13]),close=Float64Array.from([9,11,12,11,13,14]);
    expect(wilderAtr(high,low,close,3,3,0)).toBeCloseTo((3+3+2)/3,12);
    expect(wilderAtr(high,low,close,4,3,0)).toBeCloseTo(((3+3+2)/3*2+3)/3,12);
    expect(wilderAtr(high,low,close,5,3,0)).toBeCloseTo((((3+3+2)/3*2+3)/3*2+2)/3,12);
    // Not enough candles for the first mean, or a degenerate period: no value rather than a guess.
    expect(wilderAtr(high,low,close,2,3,0)).toBeUndefined();
    expect(wilderAtr(high,low,close,5,0,0)).toBeUndefined();
  });
});

describe('MACD divergence at D',()=>{
  it.each([false,true])('is found when price makes a new extreme on weaker momentum (mirrored=%s)',mirror=>{
    const t=plant(EXHAUSTED,{mirror}),match=one(t),macd=match.signals?.macd,bull=!mirror;
    expect(macd).toBeDefined();
    expect(macd).toMatchObject({kind:bull?'bullish':'bearish',source:'anchors'});
    expect(macd!.equalExtreme).toBeUndefined();
    // New extreme in price, weaker DIF.
    if(bull){expect(macd!.second.price).toBeLessThan(macd!.first.price);expect(macd!.second.dif).toBeGreaterThan(macd!.first.dif);}
    else{expect(macd!.second.price).toBeGreaterThan(macd!.first.price);expect(macd!.second.dif).toBeLessThan(macd!.first.dif);}
    // The pair is (B, D) on real candles, and the DIF values are the series' own.
    const series=seriesOf(t);
    expect(macd!.first.time).toBe(t.store.col('time')[t.anchor[1]]);expect(macd!.second.time).toBe(t.store.col('time')[t.dIndex]);
    expect(macd!.first.dif).toBeCloseTo(series.macd[t.anchor[1]],12);expect(macd!.second.dif).toBeCloseTo(series.macd[t.dIndex],12);
    // Evidence in the shared shape, the explanation in the description and the ratio table.
    expect(match.divergences).toEqual([{indicator:'macd',series:'dif',params:{fast:12,slow:26,signal:9},
      points:[{time:macd!.first.time,value:macd!.first.dif},{time:macd!.second.time,value:macd!.second.dif}]}]);
    expect(match.description).toContain(bull?'DIF 底背离':'DIF 顶背离');
    expect(match.ratios.at(-1)).toMatchObject({label:'DIF 差 / DIF 极差'});
    expect(patternChartLabel(match)).toContain(' · 背离');
  });

  it('is absent when momentum confirms the new extreme, and DIF improving on its own is not a divergence',()=>{
    const t=plant(CONFIRMING),match=one(t),series=seriesOf(t);
    expect(series.macd[t.dIndex]).toBeLessThan(series.macd[t.anchor[1]]);
    expect(match.signals?.macd).toBeUndefined();
    expect(match.divergences).toBeUndefined();
    expect(patternChartLabel(match)).not.toContain('背离');
    // A higher low with a higher DIF is trend agreement: outside the equal band there is nothing to report.
    const higher=plantHarmonic({prices:[200,140,190,156],bars:[10,10,60]}),hs=seriesOf(higher);
    expect(hs.macd[higher.anchor[3]]).toBeGreaterThan(hs.macd[higher.anchor[1]]);
    expect(harmonicSignals(manual(higher,higher.anchor),higher.view,hs,optionsOf)?.signals.macd).toBeUndefined();
  });

  it('needs a real DIF gap: identical legs leave no divergence',()=>{
    const t=plant([10,12,10]),match=one(t);
    expect(match.signals?.macd).toBeUndefined();
  });

  it('accepts the looser double-bottom form: price only matches the earlier extreme',()=>{
    const t=plantHarmonic({prices:[200,140,190,143.5],bars:[10,10,45]}),series=seriesOf(t);
    const result=harmonicSignals(manual(t,t.anchor),t.view,series,optionsOf)!;
    expect(result.signals.macd).toMatchObject({kind:'bullish',source:'anchors',equalExtreme:true});
    expect(result.signals.macd!.second.price).toBeGreaterThan(result.signals.macd!.first.price);
    expect(result.sentences[0]).toContain('（等高型）');
    // Mirrored: equal highs.
    const m=plantHarmonic({prices:[200,140,190,143.5],bars:[10,10,45],mirror:true});
    const bearish=harmonicSignals(manual(m,m.anchor,'bearish'),m.view,seriesOf(m),optionsOf)!;
    expect(bearish.signals.macd).toMatchObject({kind:'bearish',equalExtreme:true});
  });

  it('falls back to the nearest same-side swing when no anchor works, and never skips over a more extreme swing',()=>{
    // A, B, C, D with an extra swing low L1 (and a bounce) between C and D that is not part of the shape.
    const t=plantHarmonic({prices:[200,140,180,126,150,120],bars:[30,12,6,8,40]}),series=seriesOf(t);
    const shape=[t.anchor[0],t.anchor[1],t.anchor[2],t.anchor[5]];
    const via=harmonicSignals(manual(t,shape),t.view,series,optionsOf)!.signals.macd!;
    expect(via.source).toBe('swing');
    expect(via.first.time).toBe(t.store.col('time')[t.anchor[3]]);
    // B would also show a divergence against D, but L1 lies between them and undercuts B: L1 is the previous
    // extreme. When D is not weaker than L1 there is no divergence, not a silent fallback to B.
    const strong=plantHarmonic({prices:[200,140,180,126,150,120],bars:[40,10,5,8,45]}),ss=seriesOf(strong);
    expect(ss.macd[strong.anchor[5]]).toBeGreaterThan(ss.macd[strong.anchor[1]]);
    expect(ss.macd[strong.anchor[5]]).toBeLessThan(ss.macd[strong.anchor[3]]);
    expect(harmonicSignals(manual(strong,[strong.anchor[0],strong.anchor[1],strong.anchor[2],strong.anchor[5]]),strong.view,ss,optionsOf)?.signals.macd).toBeUndefined();
  });
});

describe('ATR reference beyond D',()=>{
  it.each([false,true])('is D ± multiple × Wilder ATR at D (mirrored=%s)',mirror=>{
    const t=plant(EXHAUSTED,{mirror}),high=t.store.col('high'),low=t.store.col('low'),close=t.store.col('close');
    const expected=referenceAtr(high,low,close,t.dIndex,14),match=one(t),atr=match.signals?.atr;
    expect(atr).toBeDefined();
    expect(atr!.value).toBeCloseTo(expected,9);
    expect(atr).toMatchObject({period:14,multiple:2});
    expect(atr!.level).toBeCloseTo(mirror?t.dPrice+2*expected:t.dPrice-2*expected,9);
    // The multiple and the period are parameters.
    const wide=one(t,{atrStopMultiple:3}).signals!.atr!,short=one(t,{atrPeriod:5}).signals!.atr!;
    expect(wide.level).toBeCloseTo(mirror?t.dPrice+3*expected:t.dPrice-3*expected,9);
    expect(short.value).toBeCloseTo(referenceAtr(high,low,close,t.dIndex,5),9);
    expect(short.value).not.toBeCloseTo(expected,3);
    expect(match.description).toContain('ATR(14)');
  });

  it('is not given when D sits too early in the data for a first mean',()=>{
    const t=plant(EXHAUSTED);
    expect(one(t).signals?.atr).toBeDefined();
    // A period longer than the candles before D has no first mean: no value rather than a guess.
    const none=harmonicSignals(manual(t,t.anchor),t.view,seriesOf(t),{...optionsOf,atrPeriod:t.dIndex+10});
    expect(none?.signals.atr).toBeUndefined();
  });

  it('is judged on later closed candles: a wick beyond the level is "扎" and changes nothing structural',()=>{
    const base=plant(EXHAUSTED),atr0=one(base,{atrStopMultiple:.5}).signals!.atr!;
    // The stab reaches 0.5 ATR beyond the reference level but stays clear of the structural invalidation.
    const depth=.5*atr0.value+.5*atr0.value;
    const pierced=plant(EXHAUSTED,{stab:{after:6,depth}});
    const refresh=(t:ReturnType<typeof plantHarmonic>,extra:Record<string,unknown>={})=>{
      const match=one(t,{atrStopMultiple:.5,...extra});
      return {match,refreshed:refreshPatternKnowledge(match,new ClosedRangeIndex(t.view,t.closedLength),{})};
    };
    const held=refresh(base),stab=refresh(pierced);
    expect(held.refreshed.atrPierced).toBeUndefined();
    expect(stab.refreshed.atrPierced).toEqual({time:pierced.store.col('time')[pierced.dIndex+6],knownAt:pierced.store.col('time')[pierced.dIndex+6]+HOUR,price:pierced.dPrice-depth});
    expect(stab.match.invalidation).toBeLessThan(pierced.dPrice-depth);
    // Same structure, same status, same stage: only the reading aid differs.
    const {atrPierced:_p,...rest}=stab.refreshed;
    expect(rest.status).toBe(held.refreshed.status);expect(rest.stage).toBe(held.refreshed.stage);expect(rest.invalidatedAt).toBe(held.refreshed.invalidatedAt);
    expect(rest.signals).toEqual(held.refreshed.signals);
    // A close beyond the level does not need to happen; a wick that stays inside the level is not "扎".
    const inside=plant(EXHAUSTED,{stab:{after:6,depth:.4*atr0.value}});
    expect(refresh(inside).refreshed.atrPierced).toBeUndefined();
    // Refreshing again is stable and never accumulates.
    expect(refreshPatternKnowledge(stab.refreshed,new ClosedRangeIndex(pierced.view,pierced.closedLength),{})).toEqual(stab.refreshed);
  });

  it('stops looking at the candle that invalidated the structure, and leaves matches without the reference untouched',()=>{
    const t=plant(EXHAUSTED),match=one(t,{atrStopMultiple:.5});
    // A later collapse through the risk level is a structural failure; the ATR fact records the first wick only.
    const collapse=plant(EXHAUSTED,{stab:{after:6,depth:30}}),invalid=one(collapse,{atrStopMultiple:.5});
    const refreshed=refreshPatternKnowledge(invalid,new ClosedRangeIndex(collapse.view,collapse.closedLength),{});
    expect(refreshed.status).toBe('invalidated');
    expect(refreshed.atrPierced).toBeDefined();
    // No signals (legacy cache, harmonicSignals off): nothing is added.
    const legacy=one(t,{harmonicSignals:false}),result=refreshPatternKnowledge(legacy,new ClosedRangeIndex(t.view,t.closedLength),{});
    expect('atrPierced' in result).toBe(false);
    expect(result.signals).toBeUndefined();
    void match;
  });
});

describe('pin bar at D',()=>{
  it.each([false,true])('recognises a long rejecting wick with a small body at the far end (mirrored=%s)',mirror=>{
    const pin=one(plant(EXHAUSTED,{pin:true,mirror})).signals?.pin;
    expect(pin).toBeDefined();
    expect(pin!.wickShare).toBeCloseTo(.78,9);expect(pin!.bodyShare).toBeCloseTo(.08,9);
    expect(one(plant(EXHAUSTED,{mirror})).signals?.pin).toBeUndefined();
  });

  it('needs both a long wick and a small body',()=>{
    const t=plant(EXHAUSTED,{pin:true}),open=t.store.col('open'),close=t.store.col('close');
    // Same wick geometry but a fat body: the candle is a hammer-ish bar, not a pin.
    const fat=plant(EXHAUSTED,{pin:true});
    fat.store.col('open')[fat.dIndex]=fat.dPrice+1;fat.store.col('close')[fat.dIndex]=fat.dPrice+7;
    expect(harmonicSignals(manual(fat,fat.anchor),fat.view,seriesOf(fat),optionsOf)?.signals.pin).toBeUndefined();
    void t;void open;void close;
  });
});

describe('what the reading aids may and may not change',()=>{
  const strip=(match:PatternMatch)=>{const {signals:_s,divergences:_d,ratios:_r,description:_t,...rest}=match;return rest;};
  it('leaves recognition, timing and risk untouched when switched off, and only adds evidence when on',()=>{
    for(const bars of [EXHAUSTED,CONFIRMING])for(const mirror of [false,true]){
      const t=plant(bars,{mirror,pin:true}),on=one(t),off=one(t,{harmonicSignals:false});
      expect(off.signals).toBeUndefined();expect(off.divergences).toBeUndefined();
      expect(strip(on)).toEqual(strip(off));
      expect(on.ratios.slice(0,off.ratios.length)).toEqual(off.ratios);
      expect(on.description.startsWith(off.description)).toBe(true);
    }
  });

  it('works for a layer saved before the inputs existed: defaults apply',()=>{
    const t=plant(EXHAUSTED),legacy=detectHarmonics(t.view,{pivotStrength:2,tolerance:.04,showInvalidated:true,maxPatterns:100,family:'AB=CD'});
    expect(legacy[0].signals?.atr).toMatchObject({period:14,multiple:2});
    expect(legacy[0].signals?.macd?.kind).toBe('bullish');
  });

  it('requireDivergence keeps only the harmonics that carry one',()=>{
    expect(detect(plant(EXHAUSTED),{requireDivergence:true})).toHaveLength(1);
    expect(detect(plant(CONFIRMING),{requireDivergence:true})).toHaveLength(0);
    expect(detect(plant(CONFIRMING))).toHaveLength(1);
    // Asking for divergence while the display of the signals is off still filters, but shows nothing extra.
    const filtered=detect(plant(EXHAUSTED),{requireDivergence:true,harmonicSignals:false});
    expect(filtered).toHaveLength(1);expect(filtered[0].signals).toBeUndefined();
    expect(detect(plant(CONFIRMING),{requireDivergence:true,harmonicSignals:false})).toHaveLength(0);
  });

  it('uses only candles closed when D became known',()=>{
    const t=plant(EXHAUSTED,{pin:true}),original=one(t);
    // Everything after the confirmation candle is rewritten: the signals do not move.
    const noisy=plant(EXHAUSTED,{pin:true});
    const first=t.dIndex+3;
    for(let i=first+1;i<noisy.store.length;i++){
      noisy.store.col('open')[i]=1000+i;noisy.store.col('high')[i]=2000+i;noisy.store.col('low')[i]=1+i%7;noisy.store.col('close')[i]=50+(i%13)*40;
    }
    const after=detect(noisy).find(match=>match.id===original.id)!;
    expect(after.signals).toEqual(original.signals);
    // Cutting the data right after the confirmation gives the same reading.
    const cut=detectHarmonics(truncated(t,t.dIndex+5),{...params}).find(match=>match.id===original.id)!;
    expect(cut.signals).toEqual(original.signals);
    // Before D is confirmed there is no match, hence no signal.
    expect(detectHarmonics(truncated(t,t.dIndex+3),{...params})).toEqual([]);
  });
});

const FAMILIES:Array<[string,number[]]>=[
  ['AB=CD',[200,140,180,120]],['Gartley',[100,200,138.2,183.2,121.4]],['Bat',[100,200,150,180,111.4]],['Butterfly',[100,200,121.4,173,73]],
  ['Crab',[100,200,140,190,38.2]],['Deep Crab',[100,200,110,180,38.2]],['Alternate Bat',[100,200,161.8,190,87]],['5-0',[250,100,200,70,330,200]],
  ['Shark',[100,200,160,220,111.4]],['Cypher',[100,200,150,230,127.82]],['Three Drives',[200,160,184.72,153.3256,172.7273392,148.087130416]],
];
describe('reading aids on every harmonic family',()=>{
  it.each(FAMILIES.flatMap(([family,prices])=>[[family,prices,false],[family,prices,true]] as const))('%s (mirrored=%s) gets its signals and reads fully in English',(family,prices,mirror)=>{
    const t=plantHarmonic({prices:[...prices],bars:prices.slice(1).map(()=>10),mirror});
    const dTime=t.store.col('time')[t.dIndex],matches=detectHarmonics(t.view,{pivotStrength:2,tolerance:.04,showInvalidated:true,maxPatterns:100,family}).filter(m=>m.points.at(-1)!.time===dTime);
    expect(matches.length).toBeGreaterThan(0);
    for(const match of matches){
      expect(match.family).toBe(family);
      // Every family gets the ATR reference; the divergence and the pin depend on the price path.
      expect(match.signals?.atr?.level).toBeDefined();
      expect(match.description).toContain('ATR(14)');
      expect(untranslated(match)).toEqual([]);
    }
  });
});

describe('English display',()=>{
  it('is complete for every sentence, ratio, input label and chart label the reading aids add',()=>{
    const seen:string[]=[];
    for(const mirror of [false,true])for(const pin of [false,true]){
      const match=one(plant(EXHAUSTED,{mirror,pin}));
      seen.push(...untranslated(match));
    }
    // The looser form comes from the function directly.
    const t=plantHarmonic({prices:[200,140,190,143.5],bars:[10,10,45]}),result=harmonicSignals(manual(t,t.anchor),t.view,seriesOf(t),optionsOf)!;
    for(const sentence of result.sentences)if(/[㐀-鿿]/.test(translateCanonical(sentence,undefined,'en-US')))seen.push(sentence);
    expect(seen).toEqual([]);
    expect(translateCanonical('背离',undefined,'en-US')).toBe('Divergence');
    expect(translateCanonical('仅保留带 MACD 背离的谐波',undefined,'en-US')).toBe('Keep only harmonics with a MACD divergence');
  });
});
