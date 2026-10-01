import {describe,it,expect} from 'vitest';
import {deduplicatePatternDisplay} from '../src/lib/patterns/display-dedup';
import type {PatternMatch,PatternPoint} from '../src/lib/patterns/types';
import realJson from '../docs/validation/pattern-display-dedup-2026-09-27/patterns.json?raw';

const step=3_600_000;
function pattern(patch:Partial<PatternMatch>={}):PatternMatch {
  return {id:'old',family:'huzi-double',name:'双背离共振 · W 双底',direction:'bullish',status:'confirmed',confirmedAt:20*step,
    points:[{label:'B1',time:0,value:100},{label:'N',time:5*step,value:110},{label:'B2',time:10*step,value:100}],
    zone:{low:109.6,high:110.4},invalidation:99.6,targets:[120,125],ratios:[],description:'display-only fixture',
    events:[{kind:'breakout',time:19*step,knownAt:20*step,value:111,boundary:110}],
    guides:[{role:'neckline',points:[{label:'N',time:0,value:110},{label:'N',time:20*step,value:110}]}],...patch};
}
function refinement(p=pattern(),patch:Partial<PatternMatch>={}):PatternMatch {
  return {...structuredClone(p),id:'new',points:[...p.points.slice(0,2),{...p.points[2],time:16*step,value:100.1}],...patch};
}

describe('per-instance display-only pattern equivalence',()=>{
  it('reproduces the two real current BTCUSDT 1h W bottoms and retains the later terminal',()=>{
    const raw=JSON.parse(realJson) as PatternMatch[],confirmedAt=1790467200000;
    const pair=raw.filter(p=>p.family==='huzi-double'&&p.confirmedAt===confirmedAt);
    expect(pair).toHaveLength(2);expect(pair.map(p=>p.points[2].value).sort()).toEqual([83778.4,83785.4]);
    const snapshot=JSON.stringify(raw),result=deduplicatePatternDisplay(raw);
    expect(result).toHaveLength(raw.length-1);
    expect(result.filter(p=>p.family==='huzi-double'&&p.confirmedAt===confirmedAt)).toEqual([pair.find(p=>p.points[2].time===1790452800000)]);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  it('preserves an explicitly selected earlier representative without changing raw geometry',()=>{
    const old=pattern(),newer=refinement(old),before=structuredClone([old,newer]);
    expect(deduplicatePatternDisplay([old,newer],old.id)).toEqual([old]);
    expect(deduplicatePatternDisplay([newer,old],old.id)[0]).toBe(old);
    expect([old,newer]).toEqual(before);
  });

  it('prefers a valid source over a later invalidated refinement, unless the latter is selected',()=>{
    const old=pattern(),newer=refinement(old,{status:'invalidated',invalidatedAt:25*step});
    expect(deduplicatePatternDisplay([newer,old])).toEqual([old]);
    expect(deduplicatePatternDisplay([newer,old],newer.id)).toEqual([newer]);
  });

  it('collapses exact anchor copies independently of id and chooses consistently across input order',()=>{
    const a=pattern({id:'b'}),b=pattern({id:'a'});
    expect(deduplicatePatternDisplay([a,b])).toEqual([b]);expect(deduplicatePatternDisplay([b,a])).toEqual([b]);
  });

  it.each(['family','direction','confirmedAt','breakout','name','price','risk','target','zone','neckline'] as const)('keeps genuinely different %s',field=>{
    const old=pattern(),other=refinement(old);
    if(field==='family')other.family='huzi-head-shoulders';
    if(field==='direction')other.direction='bearish';
    if(field==='confirmedAt')other.confirmedAt+=step;
    if(field==='breakout')other.events![0].time-=step;
    if(field==='name')other.name='Different branch';
    if(field==='price')other.points[2].value=101;
    if(field==='risk')other.invalidation=98;
    if(field==='target')other.targets[0]=121;
    if(field==='zone')other.zone.low=109;
    if(field==='neckline')other.points[1]={...other.points[1],time:6*step};
    expect(deduplicatePatternDisplay([old,other])).toHaveLength(2);
  });

  it('supports a small neckline plateau refinement between the same exact extrema',()=>{
    const old=pattern(),other=structuredClone(old);other.id='other';
    other.points[1]={...other.points[1],time:5.5*step,value:110.05};
    other.guides![0].points=other.guides![0].points.map(point=>({...point,value:110.05})) as [PatternPoint,PatternPoint];
    expect(deduplicatePatternDisplay([old,other])).toHaveLength(1);
    other.points[1].time=8*step;
    expect(deduplicatePatternDisplay([old,other])).toHaveLength(2);
  });

  it('does not generalize terminal refinement to harmonics or different internal shape legs',()=>{
    const old=pattern({family:'AB=CD',name:'AB=CD'}),other=refinement(old);
    expect(deduplicatePatternDisplay([old,other])).toHaveLength(2);
  });

  it('does not chain approximate pairs into a merged group with different extremes',()=>{
    const a=pattern(),b=refinement(a),c=refinement(a,{id:'latest'});
    b.points[2].value=100.15;c.points[2]={...c.points[2],time:17*step,value:100.3};
    expect(deduplicatePatternDisplay([a,b,c])).toHaveLength(2);
    expect(deduplicatePatternDisplay([c,b,a]).map(p=>p.id)).toEqual(deduplicatePatternDisplay([a,b,c]).map(p=>p.id));
  });

  it('never merges invalid geometry or terminal changes without a confirmed breakout',()=>{
    const a=pattern(),b=refinement(a);a.targets[0]=NaN;
    expect(deduplicatePatternDisplay([a,b])).toHaveLength(2);
    const c=pattern({events:undefined}),d=refinement(c);
    expect(deduplicatePatternDisplay([c,d])).toHaveLength(2);
  });
});
