import {describe,expect,it} from 'vitest';
import {translateCanonical} from '../src/lib/i18n';
import {resonanceMessages} from '../src/lib/i18n/messages-resonance';
import {matchesResonanceFilter,orderSignalTags,patternSignalTags,RESONANCE_FILTERS,type SignalTag} from '../src/lib/patterns/signal-tags';
import type {PatternMatch,PatternSignals} from '../src/lib/patterns/types';

const han=/[㐀-鿿]/;
const base:PatternMatch={id:'harmonic:Crab:1',family:'Crab',name:'螃蟹 · Crab',direction:'bullish',
  points:['X','A','B','C','D'].map((label,i)=>({label,time:(i+1)*3_600_000,value:100+i})),confirmedAt:9*3_600_000,zone:{low:99,high:101},
  invalidation:90,targets:[110,115],ratios:[],description:'',status:'confirmed'};
const withSignals=(signals?:PatternSignals,extra:Partial<PatternMatch>={}):PatternMatch=>({...base,...(signals?{signals}:{}),...extra});
const macd=(over:Partial<NonNullable<PatternSignals['macd']>>={}):NonNullable<PatternSignals['macd']>=>({kind:'bullish',source:'anchors',
  first:{time:1,price:27000,dif:-320.5},second:{time:2,price:26900,dif:-180.25},...over});
const atr:NonNullable<PatternSignals['atr']>={period:14,value:212.4,multiple:2,level:26475.2};

describe('signal tags of a harmonic match',()=>{
  it('has none for an older match or another family without signals',()=>{
    expect(patternSignalTags(base)).toEqual([]);
    expect(patternSignalTags(withSignals({}))).toEqual([]);
  });

  it('names a MACD divergence by its side and by whether price only matched the earlier extreme',()=>{
    expect(patternSignalTags(withSignals({macd:macd()}))[0]).toMatchObject({kind:'macd',label:'MACD 底背离',tone:'good'});
    expect(patternSignalTags(withSignals({macd:macd({equalExtreme:true})}))[0].label).toBe('MACD 等高底背离');
    expect(patternSignalTags(withSignals({macd:macd({kind:'bearish'})}))[0].label).toBe('MACD 顶背离');
    expect(patternSignalTags(withSignals({macd:macd({kind:'bearish',equalExtreme:true})}))[0].label).toBe('MACD 等高顶背离');
  });

  it('puts the prices and the DIF values that make the divergence into the detail',()=>{
    const {detail}=patternSignalTags(withSignals({macd:macd()}))[0];
    expect(detail).toContain('27,000.00 → 26,900.00');
    expect(detail).toContain('由 -321 升至 -180');
    expect(detail).toContain('底背离');
    const equal=patternSignalTags(withSignals({macd:macd({equalExtreme:true})}))[0].detail;
    expect(equal).toContain('几乎等高');
    const top=patternSignalTags(withSignals({macd:macd({kind:'bearish',first:{time:1,price:30000,dif:400},second:{time:2,price:30100,dif:250}})}))[0].detail;
    expect(top).toContain('高于前一高点');expect(top).toContain('由 400 降至 250');
  });

  it('reports the ATR stop as held until a wick has pierced it, with the multiple from the signal',()=>{
    expect(patternSignalTags(withSignals({atr}))[0]).toMatchObject({kind:'atr',label:'2ATR未扎',tone:'good'});
    expect(patternSignalTags(withSignals({atr:{...atr,multiple:1.5}}))[0].label).toBe('1.5ATR未扎');
    const pierced=patternSignalTags(withSignals({atr},{atrPierced:{time:5,knownAt:6,price:26400}}))[0];
    expect(pierced).toMatchObject({label:'2ATR已扎',tone:'warn'});
    expect(pierced.detail).toContain('已被影线刺穿');expect(pierced.detail).toContain('26,400.00');
    expect(patternSignalTags(withSignals({atr}))[0].detail).toContain('ATR(14) = 212');
    // A pierce without a recorded ATR signal says nothing.
    expect(patternSignalTags(withSignals(undefined,{atrPierced:{time:5,knownAt:6,price:1}}))).toEqual([]);
  });

  it('marks a pin bar at D with its wick and body shares',()=>{
    const tag=patternSignalTags(withSignals({pin:{wickShare:.72,bodyShare:.18}}))[0];
    expect(tag).toMatchObject({kind:'pin',label:'D 针形K',tone:'good'});
    expect(tag.detail).toContain('72%');expect(tag.detail).toContain('18%');
  });

  it('orders the tags: divergence, then the stop, then the candle',()=>{
    const tags=patternSignalTags(withSignals({pin:{wickShare:.7,bodyShare:.2},atr,macd:macd()}));
    expect(tags.map(tag=>tag.kind)).toEqual(['macd','atr','pin']);
    const mixed=orderSignalTags([{kind:'pin'},{kind:'terminal'},{kind:'macd'},{kind:'multi-tf'},{kind:'atr'},{kind:'lower-tf'}] as SignalTag[]);
    expect(mixed.map(tag=>tag.kind)).toEqual(['macd','multi-tf','terminal','lower-tf','atr','pin']);
    // Stable within a kind, and the input is untouched.
    const input=[{kind:'terminal',label:'a'},{kind:'terminal',label:'b'}] as SignalTag[],copy=structuredClone(input);
    expect(orderSignalTags(input).map(tag=>tag.label)).toEqual(['a','b']);expect(input).toEqual(copy);
  });

  it('does not read a signal off the geometry alone or mutate the match',()=>{
    const match=withSignals({macd:macd(),atr,pin:{wickShare:.7,bodyShare:.2}}),before=structuredClone(match);
    patternSignalTags(match);expect(match).toEqual(before);
  });
});

describe('resonance filter',()=>{
  const tag=(kind:SignalTag['kind'],tone:SignalTag['tone']='good'):SignalTag=>({kind,label:kind,tone,detail:''});
  it('shows everything for "all" and only matches that carry the asked-for tag otherwise',()=>{
    expect(matchesResonanceFilter('all',[])).toBe(true);
    expect(matchesResonanceFilter('macd',[tag('macd'),tag('pin')])).toBe(true);
    expect(matchesResonanceFilter('macd',[tag('pin')])).toBe(false);
    expect(matchesResonanceFilter('terminal',[tag('terminal','neutral')])).toBe(true);
    expect(matchesResonanceFilter('terminal',[tag('lower-tf','neutral')])).toBe(true);
    expect(matchesResonanceFilter('terminal',[tag('multi-tf')])).toBe(false);
    expect(matchesResonanceFilter('multi',[tag('multi-tf')])).toBe(true);
  });
  it('asks for a stop that HELD: a pierced one does not pass the "2ATR 未扎" filter',()=>{
    expect(matchesResonanceFilter('atr',[tag('atr','good')])).toBe(true);
    expect(matchesResonanceFilter('atr',[tag('atr','warn')])).toBe(false);
  });
  it('hides matches without any tag (other families, older results) once a filter is chosen',()=>{
    for(const filter of RESONANCE_FILTERS.filter(value=>value!=='all'))expect(matchesResonanceFilter(filter,[]),filter).toBe(false);
  });
});

describe('English display of the tags',()=>{
  const english=(text:string)=>translateCanonical(text,undefined,'en-US');
  it('translates every label and detail without leaving Chinese',()=>{
    const all=[
      ...patternSignalTags(withSignals({macd:macd(),atr,pin:{wickShare:.7,bodyShare:.2}})),
      ...patternSignalTags(withSignals({macd:macd({equalExtreme:true})})),
      ...patternSignalTags(withSignals({macd:macd({kind:'bearish'})})),
      ...patternSignalTags(withSignals({macd:macd({kind:'bearish',equalExtreme:true})})),
      ...patternSignalTags(withSignals({atr:{...atr,multiple:1.5}},{atrPierced:{time:5,knownAt:6,price:26400}})),
    ];
    expect(all.length).toBe(7);
    for(const tag of all){expect(english(tag.label),tag.label).not.toMatch(han);expect(english(tag.detail),tag.detail).not.toMatch(han);}
    expect(english('2ATR未扎')).toBe('2 ATR held');expect(english('MACD 等高底背离')).toBe('MACD equal-low divergence');
  });
  it('keeps every placeholder of a template in its English text',()=>{
    for(const [source,target] of Object.entries(resonanceMessages)){
      expect(target,source).not.toMatch(han);
      expect([...target.matchAll(/\{(\d+)\}/g)].map(m=>m[1]).sort(),source).toEqual([...source.matchAll(/\{(\d+)\}/g)].map(m=>m[1]).sort());
    }
  });
});
