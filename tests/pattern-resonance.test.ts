import {describe,expect,it} from 'vitest';
import {translateCanonical} from '../src/lib/i18n';
import {computeResonance,resonanceKey,MAX_RESONANCE_TAGS,MULTI_TF_D_BARS,PRZ_OVERLAP_SHARE,TERMINAL_AFTER_BARS,TERMINAL_BEFORE_BARS,type ResonanceLayer} from '../src/lib/patterns/resonance';
import type {PatternMatch} from '../src/lib/patterns/types';

const han=/[㐀-鿿]/;
const H=3_600_000,T0=1_700_000_000_000;
const MS={'15m':900_000,'1h':H,'2h':2*H,'4h':4*H,'8h':8*H,'1d':24*H} as const;
type Tf=keyof typeof MS;

interface HarmonicSpec {id:string;family?:string;d:number;low?:number;high?:number;dir?:'bullish'|'bearish';confirmedAt?:number;id2?:string}
function harmonic(spec:HarmonicSpec):PatternMatch {
  const {id,family='Crab',d,low=100,high=110,dir='bullish'}=spec;
  return {id:`harmonic:${family}:${id}`,family,name:`${family} 形态`,direction:dir,ruleVersion:'harmonic/2.1-source-legs',
    points:[-4,-3,-2,-1,0].map((k,i)=>({label:'XABCD'[i],time:d+k*H,value:100+i})),confirmedAt:spec.confirmedAt??d+3*H,
    zone:{low,high},invalidation:90,targets:[120,130],ratios:[],description:'',status:'confirmed'};
}
interface StructureSpec {id:string;start:number;family?:string;name?:string;dir?:'bullish'|'bearish';confirmedAt?:number}
function structure(spec:StructureSpec):PatternMatch {
  const {id,start,family='huzi-triangle',name='对称三角形',dir='bullish'}=spec;
  return {id:`${family}:${id}`,family,name,direction:dir,points:[0,1,2,3,4].map(k=>({label:'ABCDE'[k],time:start+k*H/4,value:100+k})),
    confirmedAt:spec.confirmedAt??start+6*H,zone:{low:105,high:106},invalidation:95,targets:[115],ratios:[],description:'',status:'confirmed'};
}
const layer=(instanceId:string,definitionId:string,tf:Tf,matches:PatternMatch[]):ResonanceLayer=>({instanceId,definitionId,timeframeMs:MS[tf],timeframeLabel:tf,matches});
const harmonicLayer=(id:string,tf:Tf,matches:PatternMatch[])=>layer(id,'pattern-harmonic',tf,matches);
const huziLayer=(id:string,tf:Tf,matches:PatternMatch[])=>layer(id,'pattern-huzi',tf,matches);
const tagsOf=(map:ReturnType<typeof computeResonance>,instanceId:string,match:PatternMatch)=>map.get(resonanceKey(instanceId,match.id))??[];
const D=T0+100*H;

describe('terminal structure (末端对三 / 15min对三切入)',()=>{
  it('tags a same-timeframe structure that starts after D in the harmonic\'s direction',()=>{
    const h=harmonic({id:'a',d:D}),s=structure({id:'s',start:D+3*MS['2h']});
    const tags=tagsOf(computeResonance([harmonicLayer('h2',  '2h',[h]),huziLayer('c2','2h',[s])]),'h2',h);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({kind:'terminal',label:'末端 对称三角形',target:{instanceId:'c2',patternId:s.id},knownAt:Math.max(h.confirmedAt,s.confirmedAt)});
    expect(tags[0].detail).toContain('起于 D 点后 3 根 2h K 线');
  });

  it('tags a smaller-timeframe structure as an entry ("15m 对称三角形 切入")',()=>{
    const h=harmonic({id:'a',d:D}),s=structure({id:'s',start:D+5*MS['2h']});
    const tags=tagsOf(computeResonance([harmonicLayer('h2','2h',[h]),huziLayer('c15','15m',[s])]),'h2',h);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({kind:'lower-tf',label:'15m 对称三角形 切入',tone:'neutral'});
    expect(tags[0].detail).toContain('15m 周期的 对称三角形 起于 D 点后 5 根 2h K 线');
  });

  it('accepts a structure that began shortly before D and reports it as before',()=>{
    const h=harmonic({id:'a',d:D}),s=structure({id:'s',start:D-MS['2h']});
    expect(tagsOf(computeResonance([harmonicLayer('h2','2h',[h]),huziLayer('c2','2h',[s])]),'h2',h)[0].detail).toContain('起于 D 点前 1 根 2h K 线');
  });

  it('needs the direction the harmonic expects: a bullish D followed by a triangle that breaks down is not an entry',()=>{
    const h=harmonic({id:'a',d:D,dir:'bullish'}),s=structure({id:'s',start:D+MS['2h'],dir:'bearish'});
    expect(computeResonance([harmonicLayer('h2','2h',[h]),huziLayer('c2','2h',[s])]).size).toBe(0);
  });

  it('keeps to the window from 2 harmonic bars before D to 12 after, edges included',()=>{
    const own=MS['2h'],h=harmonic({id:'a',d:D});
    const at=(start:number)=>computeResonance([harmonicLayer('h2','2h',[h]),huziLayer('c2','2h',[structure({id:'s',start})])]).size;
    // The numbers are the documented rule (2 harmonic bars before D, 12 after), not the constants under test.
    expect([TERMINAL_BEFORE_BARS,TERMINAL_AFTER_BARS]).toEqual([2,12]);
    expect(at(D-2*own)).toBe(1);
    expect(at(D-2*own-1)).toBe(0);
    expect(at(D+12*own)).toBe(1);
    expect(at(D+12*own+1)).toBe(0);
  });

  it('never counts a structure on a larger timeframe as the end of a smaller one\'s leg',()=>{
    const h=harmonic({id:'a',d:D}),s=structure({id:'s',start:D+MS['2h']});
    expect(computeResonance([harmonicLayer('h1','1h',[h]),huziLayer('c4','4h',[s])]).size).toBe(0);
  });

  it('only considers triangles, wedges, channels and flags of the Huzi layer',()=>{
    const h=harmonic({id:'a',d:D});
    const others=[structure({id:'x',start:D+H,family:'huzi-double',name:'W 双底'}),structure({id:'y',start:D+H,family:'huzi-head-shoulders',name:'头肩底'})];
    expect(computeResonance([harmonicLayer('h2','2h',[h]),huziLayer('c2','2h',others)]).size).toBe(0);
    for(const family of ['huzi-wedge','huzi-channel','huzi-flag'])
      expect(computeResonance([harmonicLayer('h2','2h',[h]),huziLayer('c2','2h',[structure({id:family,start:D+H,family})])]).size,family).toBe(1);
  });

  it('is causal: a structure confirmed after the view\'s time is not there yet, and the tag records when it became known',()=>{
    const h=harmonic({id:'a',d:D,confirmedAt:D+3*H}),s=structure({id:'s',start:D+MS['2h'],confirmedAt:D+30*H});
    const layers=[harmonicLayer('h2','2h',[h]),huziLayer('c2','2h',[s])];
    expect(computeResonance(layers,{asOf:D+29*H}).size).toBe(0);
    const later=tagsOf(computeResonance(layers,{asOf:D+30*H}),'h2',h);
    expect(later).toHaveLength(1);expect(later[0].knownAt).toBe(D+30*H);
    // The harmonic itself must be known too.
    expect(computeResonance(layers,{asOf:D+2*H}).size).toBe(0);
  });

  it('picks the structure that starts closest to D, whatever the input order',()=>{
    const h=harmonic({id:'a',d:D}),near=structure({id:'near',start:D+MS['2h']}),far=structure({id:'far',start:D+6*MS['2h']});
    for(const order of [[near,far],[far,near]]){
      const tags=tagsOf(computeResonance([harmonicLayer('h2','2h',[h]),huziLayer('c2','2h',order)]),'h2',h);
      expect(tags).toHaveLength(1);expect(tags[0].target.patternId).toBe(near.id);
    }
  });
});

describe('multi-timeframe harmonic resonance (8h Shark + 4h Crab)',()=>{
  const a=(over:Partial<HarmonicSpec>={})=>harmonic({id:'a',family:'Shark',d:D,low:100,high:110,...over});
  const b=(over:Partial<HarmonicSpec>={})=>harmonic({id:'b',family:'Crab',d:D+H,low:104,high:114,...over});
  const run=(x:PatternMatch,y:PatternMatch,tfx:Tf='8h',tfy:Tf='4h')=>computeResonance([harmonicLayer('hx',tfx,[x]),harmonicLayer('hy',tfy,[y])]);

  it('links two harmonics of different timeframes and the same direction whose PRZs overlap, both ways',()=>{
    const x=a(),y=b(),map=run(x,y);
    const forX=tagsOf(map,'hx',x),forY=tagsOf(map,'hy',y);
    expect(forX).toHaveLength(1);expect(forY).toHaveLength(1);
    expect(forX[0]).toMatchObject({kind:'multi-tf',label:'4h Crab',tone:'good',target:{instanceId:'hy',patternId:y.id}});
    expect(forY[0]).toMatchObject({kind:'multi-tf',label:'8h Shark',target:{instanceId:'hx',patternId:x.id}});
    expect(forX[0].detail).toContain('4h 周期的 Crab 同向完成，PRZ 与本形态重叠 60%');
    expect(forX[0].detail).toContain('相隔 0.1 根 8h K 线');
  });

  it(`needs at least ${PRZ_OVERLAP_SHARE*100}% of the narrower PRZ in common`,()=>{
    // PRZ 100–110 vs 106–116: 4 of 10. 105–115: 5 of 10.
    expect(run(a(),b({low:106,high:116})).size).toBe(0);
    expect(run(a(),b({low:105,high:115})).size).toBe(2);
    // The share is of the NARROWER zone: a small PRZ inside a wide one is fully shared.
    expect(run(a({low:100,high:200}),b({low:120,high:130})).size).toBe(2);
    expect(run(a(),b({low:111,high:120})).size).toBe(0);
  });

  it('treats a zero-width PRZ as shared when it lies inside the other zone',()=>{
    expect(run(a(),b({low:105,high:105})).size).toBe(2);
    expect(run(a(),b({low:120,high:120})).size).toBe(0);
  });

  it(`needs the D points within ${MULTI_TF_D_BARS} bars of the larger timeframe`,()=>{
    expect([MULTI_TF_D_BARS,PRZ_OVERLAP_SHARE]).toEqual([3,.5]);
    const window=3*MS['8h'];
    expect(run(a(),b({d:D+window})).size).toBe(2);
    expect(run(a(),b({d:D+window+1})).size).toBe(0);
    expect(run(a(),b({d:D-window})).size).toBe(2);
  });

  it('does not link the same timeframe, or opposite directions',()=>{
    expect(run(a(),b(),'4h','4h').size).toBe(0);
    expect(run(a({dir:'bullish'}),b({dir:'bearish'})).size).toBe(0);
  });

  it('shows one tag per family per layer, the best-overlapping one',()=>{
    const x=a(),weak=harmonic({id:'w',family:'Crab',d:D,low:105,high:115}),strong=harmonic({id:'s',family:'Crab',d:D+H,low:100,high:110}),bat=harmonic({id:'t',family:'Bat',d:D,low:100,high:110});
    const tags=tagsOf(computeResonance([harmonicLayer('hx','8h',[x]),harmonicLayer('hy','4h',[weak,strong,bat])]),'hx',x);
    expect(tags.map(tag=>tag.label).sort()).toEqual(['4h Bat','4h Crab']);
    expect(tags.find(tag=>tag.label==='4h Crab')!.target.patternId).toBe(strong.id);
  });
});

describe('what is tagged, and how many tags',()=>{
  it('tags harmonic matches only; Huzi, HSCP and other definitions are neither tagged nor tag sources',()=>{
    const hscpWrapped={...harmonic({id:'w',d:D}),id:'hscp:harmonic:Crab:w'};
    const huziLike=structure({id:'s',start:D});
    const map=computeResonance([
      harmonicLayer('h2','2h',[harmonic({id:'a',d:D}),hscpWrapped]),
      layer('conf','pattern-confluence','4h',[harmonic({id:'c',d:D,low:100,high:110})]),
      huziLayer('c2','2h',[huziLike]),huziLayer('c4','4h',[{...structure({id:'q',start:D}),id:'huzi-triangle:q'}]),
    ]);
    // The wrapped HSCP match is not tagged, and the confluence layer neither tags nor is used for multi-timeframe.
    expect([...map.keys()]).toEqual([resonanceKey('h2',harmonic({id:'a',d:D}).id)]);
    expect(map.get(resonanceKey('h2',harmonic({id:'a',d:D}).id))!.every(tag=>tag.kind==='terminal')).toBe(true);
  });

  it(`keeps at most ${MAX_RESONANCE_TAGS} tags, other timeframes first, then same-timeframe structure, then smaller ones`,()=>{
    const h=harmonic({id:'a',d:D,low:100,high:110});
    const layers=[
      harmonicLayer('h2','2h',[h]),
      harmonicLayer('h4','4h',[harmonic({id:'b',family:'Bat',d:D,low:100,high:110})]),
      harmonicLayer('h8','8h',[harmonic({id:'c',family:'Shark',d:D,low:100,high:110})]),
      harmonicLayer('h1d','1d',[harmonic({id:'e',family:'Gartley',d:D,low:100,high:110})]),
      huziLayer('c15','15m',[structure({id:'s15',start:D+H})]),
      huziLayer('c2','2h',[structure({id:'s2',start:D+H})]),
    ];
    const tags=tagsOf(computeResonance(layers),'h2',h);
    expect(tags).toHaveLength(MAX_RESONANCE_TAGS);
    expect(tags.map(tag=>tag.kind)).toEqual(['multi-tf','multi-tf','multi-tf','terminal']);
    // Without the third other-timeframe harmonic there is room for the smaller-timeframe entry too.
    const fewer=tagsOf(computeResonance(layers.filter(l=>l.instanceId!=='h1d'&&l.instanceId!=='h8')),'h2',h);
    expect(fewer.map(tag=>tag.kind)).toEqual(['multi-tf','terminal','lower-tf']);
  });

  it('does not tag a match that has nothing around it',()=>{
    expect(computeResonance([harmonicLayer('h2','2h',[harmonic({id:'a',d:D})])]).size).toBe(0);
    expect(computeResonance([]).size).toBe(0);
  });
});

describe('purity and cost',()=>{
  function deepFreeze<T>(value:T):T {
    if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value as object))deepFreeze(child);}
    return value;
  }
  const scenario=()=>[
    harmonicLayer('h2','2h',[harmonic({id:'a',d:D}),harmonic({id:'a2',family:'Bat',d:D+10*H,low:102,high:108})]),
    harmonicLayer('h4','4h',[harmonic({id:'b',family:'Shark',d:D+H,low:104,high:114})]),
    huziLayer('c15','15m',[structure({id:'s',start:D+H}),structure({id:'s2',start:D+30*H})]),
  ];
  it('does not touch its inputs and gives the same answer for the same inputs, whatever their order',()=>{
    const layers=deepFreeze(scenario());
    const first=computeResonance(layers),second=computeResonance(layers);
    expect([...first]).toEqual([...second]);
    const shuffled=scenario().map(l=>({...l,matches:[...l.matches].reverse()})).reverse();
    expect([...computeResonance(shuffled)].sort(([x],[y])=>x.localeCompare(y))).toEqual([...first].sort(([x],[y])=>x.localeCompare(y)));
    expect(first.size).toBeGreaterThan(0);
  });

  it('joins three layers of a thousand matches each in tens of milliseconds',()=>{
    const many=(prefix:string,make:(i:number)=>PatternMatch)=>Array.from({length:1000},(_,i)=>make(i));
    const layers=[
      harmonicLayer('h2','2h',many('a',i=>harmonic({id:`a${i}`,d:T0+i*3*H,low:100+(i%7),high:110+(i%7),dir:i%2?'bullish':'bearish'}))),
      harmonicLayer('h4','4h',many('b',i=>harmonic({id:`b${i}`,family:'Shark',d:T0+i*3*H+H,low:102+(i%5),high:112+(i%5),dir:i%2?'bullish':'bearish'}))),
      huziLayer('c15','15m',many('c',i=>structure({id:`c${i}`,start:T0+i*3*H+H/2,dir:i%2?'bullish':'bearish'}))),
    ];
    computeResonance(layers); // warm up
    const started=performance.now(),map=computeResonance(layers),took=performance.now()-started;
    expect(map.size).toBeGreaterThan(500);
    expect(took).toBeLessThan(150);
  });
});

describe('English display of the resonance tags',()=>{
  it('translates every label and detail it can produce',()=>{
    const h=harmonic({id:'a',d:D}),x=harmonic({id:'x',family:'Shark',d:D+H,low:104,high:114});
    const before=structure({id:'before',start:D-H,name:'上升楔形',family:'huzi-wedge'});
    const layers=[harmonicLayer('h2','2h',[h]),harmonicLayer('h8','8h',[x]),huziLayer('c2','2h',[before]),huziLayer('c15','15m',[structure({id:'s15',start:D+H})])];
    const seen=new Set<string>();
    for(const tags of computeResonance(layers).values())for(const tag of tags){
      seen.add(tag.kind);
      expect(translateCanonical(tag.label,undefined,'en-US'),tag.label).not.toMatch(han);
      expect(translateCanonical(tag.detail,undefined,'en-US'),tag.detail).not.toMatch(han);
    }
    expect([...seen].sort()).toEqual(['lower-tf','multi-tf','terminal']);
    // The "after" variants of the two structure sentences.
    const after=computeResonance([harmonicLayer('h2','2h',[h]),huziLayer('c2','2h',[structure({id:'a',start:D+H})]),huziLayer('c15','15m',[structure({id:'b',start:D+H})])]);
    for(const tag of after.get(resonanceKey('h2',h.id))!)expect(translateCanonical(tag.detail,undefined,'en-US'),tag.detail).not.toMatch(han);
    expect(translateCanonical('15m 对称三角形 切入',undefined,'en-US')).toBe('15m Symmetrical triangle entry');
  });
});
