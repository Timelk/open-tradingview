import {describe,expect,it} from 'vitest';
import {detectHuzi} from '../src/lib/patterns/huzi';
import {accelSetups,ACCEL_MAX_TOUCHES,ACCEL_STEEPENING,type AccelContext} from '../src/lib/patterns/huzi-accel';
import {confirmedPivotEvents,type Pivot} from '../src/lib/patterns/pivots';
import type {PatternMatch} from '../src/lib/patterns/types';
import {STEP_MS,viewOf} from './fixtures/huzi-synthetic';
import {plantAccel,type AccelOptions,type PlantedAccel} from './fixtures/huzi-accel-planted';
import {untranslated} from './fixtures/huzi-english';

const params={pivotStrength:3,lookback:1500,tolerance:.04,maxPatterns:1000,showInvalidated:true,minStructureBars:0,family:'通道加速'};
const detect=(t:PlantedAccel,extra:Record<string,unknown>={},cut=t.breakout+6)=>detectHuzi(viewOf(t.bars,cut),{...params,...extra}).filter(m=>m.family==='huzi-accel');
const bar=(time:number)=>Math.round(time/STEP_MS);
const firstBar=(m:PatternMatch)=>bar(m.points[0].time),lastBar=(m:PatternMatch)=>bar(m.points.at(-1)!.time);
/** The planted structure is recognised when a match of the right direction ends on its last touch and covers most of it. */
const recognises=(t:PlantedAccel,m:PatternMatch)=>m.direction===t.direction&&Math.abs(lastBar(m)-t.last)<=6&&firstBar(m)<=t.first+.3*(t.last-t.first);
/** A match that lies wholly inside the planted region (the flat approach before it can form its own knee). */
const inside=(t:PlantedAccel,m:PatternMatch)=>firstBar(m)>=t.first-5;
const plant=(o:Partial<AccelOptions>&{seed:number})=>plantAccel({direction:'up',length:100,touches:5,...o});

describe('planted accelerating trends',()=>{
  it('recognises most of them, rising and falling, at every scale and noise level',()=>{
    let seen=0,hit=0;
    for(const direction of ['up','down'] as const)for(const length of [60,100,150])for(const noise of [.2,.5])for(let seed=1;seed<=8;seed++){
      const t=plantAccel({direction,length,seed,noise,touches:4+seed%4});seen++;
      const match=detect(t).find(m=>recognises(t,m));
      if(!match)continue;
      hit++;
      expect(match.name).toBe(direction==='up'?'通道加速 · 上行':'通道加速 · 下行');
      expect(match.direction).toBe(direction==='up'?'bullish':'bearish');
    }
    expect(seen).toBe(96);
    expect(hit/seen).toBeGreaterThanOrEqual(.85);
  });

  it('confirms only when the close passes the highest (lowest) swing since the first touch, and reports the steepening',()=>{
    let checked=0;
    for(const direction of ['up','down'] as const)for(let seed=1;seed<=10;seed++){
      const t=plant({direction,seed,noise:.3});
      const match=detect(t).find(m=>recognises(t,m));
      if(!match)continue;
      checked++;
      const breakout=match.events!.find(event=>event.kind==='breakout')!;
      // The breakout candle is the planted decisive close and its boundary is the neckline (the highest swing high).
      expect(bar(breakout.time)).toBeGreaterThanOrEqual(t.last);
      expect(direction==='up'?breakout.value>breakout.boundary:breakout.value<breakout.boundary).toBe(true);
      const neckline=match.guides!.find(g=>g.role==='neckline')!;
      expect(neckline.points[0].value).toBeCloseTo(neckline.points[1].value,9);
      expect(Math.abs(neckline.points[0].value-t.neckline)).toBeLessThan(t.rise*.05);
      const slopes=match.ratios.find(r=>r.label==='末 / 首触点曲线斜率比')!;
      expect(slopes.value).toBeGreaterThanOrEqual(ACCEL_STEEPENING);
      expect(match.ratios.find(r=>r.label==='曲线触点数')!.value).toBe(match.points.length);
      expect(match.points.length).toBeGreaterThanOrEqual(4);
      expect(match.points.length).toBeLessThanOrEqual(ACCEL_MAX_TOUCHES);
      // The touches are same-side pivots: lows for a rise, highs for a fall.
      const values=match.points.map(p=>p.value);
      for(let i=1;i<values.length;i++)expect(direction==='up'?values[i]>values[i-1]:values[i]<values[i-1]).toBe(true);
    }
    expect(checked).toBeGreaterThanOrEqual(12);
  });

  it('draws a neckline and a curve; the curve is sampled bar by bar, monotone and getting steeper',()=>{
    for(const direction of ['up','down'] as const){
      let match:PatternMatch|undefined,t!:PlantedAccel;
      for(let seed=1;seed<=20&&!match;seed++){t=plant({direction,seed,noise:.3});match=detect(t).find(m=>recognises(t,m));}
      expect(match).toBeDefined();
      const roles=match!.guides!.map(g=>g.role);
      expect(roles).toContain('neckline');expect(roles).toContain('curve');
      const curve=match!.guides!.find(g=>g.role==='curve')!;
      expect(curve.path!.length).toBeGreaterThan(2);
      expect(curve.points[0]).toEqual(curve.path![0]);expect(curve.points[1]).toEqual(curve.path!.at(-1));
      // From the first to the last touch and no further: a curve is never projected into unknown prices.
      expect(curve.path![0].time).toBe(match!.points[0].time);expect(curve.path!.at(-1)!.time).toBe(match!.points.at(-1)!.time);
      const sign=direction==='up'?1:-1,v=curve.path!.map(p=>sign*p.value);
      for(let i=1;i<v.length;i++)expect(v[i]).toBeGreaterThan(v[i-1]);
      const step=(i:number)=>(v[i+1]-v[i])/(curve.path![i+1].time-curve.path![i].time);
      expect(step(v.length-2)).toBeGreaterThan(step(0)*ACCEL_STEEPENING*.9);
      // The touches sit on it.
      const height=match!.targets[0]-match!.guides!.find(g=>g.role==='neckline')!.points[0].value;
      for(const p of match!.points){
        const near=curve.path!.reduce((best,q)=>Math.abs(q.time-p.time)<Math.abs(best.time-p.time)?q:best);
        expect(Math.abs(near.value-p.value)).toBeLessThan(Math.abs(height)*.2);
      }
    }
  });
});

describe('shapes that are not acceleration',()=>{
  it.each(['line','decel','jump'] as const)('finds nothing in a %s structure',shape=>{
    // The flat approach before the structure can turn into a knee with the first bars of a straight rise, so
    // only structures that start where the planted one starts are counted.
    let found=0,seen=0;
    for(const direction of ['up','down'] as const)for(const length of [60,100,150])for(const noise of [.2,.6])for(let seed=1;seed<=6;seed++){
      const t=plantAccel({direction,length,seed,noise,touches:4+seed%4,shape});seen++;
      found+=detect(t).filter(m=>inside(t,m)).length;
    }
    expect(seen).toBe(72);
    expect(found).toBe(0);
  });

  it('never builds a structure across a price that falls through the curve, and later invalidates one that ended before it',()=>{
    let before=0;
    for(const direction of ['up','down'] as const)for(const length of [60,100,150])for(let seed=1;seed<=8;seed++){
      const t=plantAccel({direction,length,seed,noise:.3,touches:4+seed%4,shape:'broken'});
      expect(t.dip).toBeDefined();
      for(const m of detect(t).filter(x=>inside(t,x))){
        expect(lastBar(m)).toBeLessThan(t.dip!);
        // The structure was published on the breakout before the fall; the fall then breaks it.
        expect(m.status).toBe('invalidated');before++;
      }
    }
    expect(before).toBeGreaterThan(5);
  });

  it('abandons a structure that only breaks out after the price has lost the curve (tangent after the last touch)',()=>{
    // After the last touch the price idles just above that touch — clear of the structural stop, far below the
    // curve's tangent — and only then jumps through the neckline. Rising along the curve is confirmed; this is not.
    let tested=0;
    for(const direction of ['up','down'] as const)for(let seed=1;seed<=12;seed++){
      const t=plant({direction,seed,noise:.3,tail:60}),sign=direction==='up'?1:-1;
      if(!detect(t).some(m=>recognises(t,m)&&m.status==='confirmed'))continue;
      const idle=plant({direction,seed,noise:.3,tail:60});
      const touch=idle.bars[idle.last][sign>0?3:2],level=touch+(idle.neckline-touch)*.3;
      for(let i=idle.last+1;i<idle.bars.length;i++){
        const b=idle.bars[i],jump=i>=idle.last+40,c=jump?idle.neckline+sign*.4*idle.rise:level;
        b[1]=i===idle.last+1||i===idle.last+40?level:c;b[4]=c;b[2]=Math.max(b[1],c)+.3;b[3]=Math.min(b[1],c)-.3;
      }
      const cut=idle.last+52;
      expect(detect(idle,{},cut).some(m=>recognises(idle,m))).toBe(false);
      tested++;
    }
    expect(tested).toBeGreaterThanOrEqual(8);
  });
});

describe('scale and switches',()=>{
  it('minStructureBars hides structures shorter than the given span',()=>{
    const t=plant({length:150,seed:3,noise:.3});
    const all=detect(t,{minStructureBars:0}),long=detect(t,{minStructureBars:100}),none=detect(t,{minStructureBars:400});
    expect(all.length).toBeGreaterThan(0);
    expect(none).toEqual([]);
    const span=(m:PatternMatch)=>(m.points.at(-1)!.time-m.points[0].time)/STEP_MS;
    expect(long.every(m=>span(m)>=100)).toBe(true);
    expect(all.some(m=>span(m)<100)||all.length===long.length).toBe(true);
    expect(long.length).toBeLessThanOrEqual(all.length);
  });

  it('is off with extraStructures:false and confined to its own family',()=>{
    const t=plant({seed:4,noise:.3});
    expect(detect(t,{extraStructures:false})).toEqual([]);
    const everything=detectHuzi(viewOf(t.bars,t.breakout+6),{...params,family:'全部'});
    expect(everything.some(m=>m.family==='huzi-accel')).toBe(true);
    for(const m of detectHuzi(viewOf(t.bars,t.breakout+6),{...params,family:'三角形'}))expect(m.family).not.toBe('huzi-accel');
    for(const m of detectHuzi(viewOf(t.bars,t.breakout+6),params))expect(m.family).toBe('huzi-accel');
  });
});

describe('causality and determinism',()=>{
  const pivotsOf=(t:PlantedAccel,radius:number,cut=t.bars.length)=>{
    const events=confirmedPivotEvents(viewOf(t.bars,cut),radius,1500,120);
    return events;
  };
  const context=(t:PlantedAccel,radius:number,horizon:number):AccelContext=>{
    const col=(j:number)=>Float64Array.from(t.bars.map(r=>r[j]));
    return {open:col(1),high:col(2),low:col(3),close:col(4),horizon,tolerance:.04,radius,minSpan:18,maxSpan:200};
  };
  const summary=(setups:ReturnType<typeof accelSetups>)=>setups.map(s=>({pivots:s.pivots.map(p=>p.index),ratios:s.ratios,height:s.height,level:s.neckline!.intercept,name:s.name,floor:[s.floorAt!(s.pivots[0].index),s.floorAt!(s.pivots.at(-1)!.index),s.floorAt!(s.pivots.at(-1)!.index+20)]}));

  it('never reads a bar beyond its horizon',()=>{
    let compared=0;
    for(const direction of ['up','down'] as const)for(let seed=1;seed<=8;seed++){
      const t=plant({direction,seed,noise:.3}),events=pivotsOf(t,3);
      const highs:Pivot[]=[],lows:Pivot[]=[];
      for(const event of events){
        (event.kind==='high'?highs:lows).push(event);
        const horizon=event.index+3,base=accelSetups(highs,lows,event,context(t,3,horizon));
        if(!base.length)continue;
        const future=plantAccel({direction,length:100,seed,noise:.3,touches:5});
        for(let i=horizon+1;i<future.bars.length;i++){const row=future.bars[i];row[2]=1e6;row[3]=-1e6;row[4]=(i%2?1:-1)*1e5;row[1]=row[4];}
        expect(summary(accelSetups(highs,lows,event,context(future,3,horizon)))).toEqual(summary(base));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(5);
  });

  it('gives at most two structures per pivot',()=>{
    let calls=0,max=0;
    for(let seed=1;seed<=12;seed++){
      const t=plant({direction:seed%2?'up':'down',seed,noise:.4,touches:7,length:150}),highs:Pivot[]=[],lows:Pivot[]=[];
      for(const event of pivotsOf(t,3)){
        (event.kind==='high'?highs:lows).push(event);
        const setups=accelSetups(highs,lows,event,context(t,3,event.index+3));calls++;max=Math.max(max,setups.length);
        for(const s of setups)expect(s.pivots.at(-1)!.index).toBe(event.index);
      }
    }
    expect(calls).toBeGreaterThan(50);
    expect(max).toBeLessThanOrEqual(2);
  });

  it('a later, unrelated tail never moves an already published structure (bar-by-bar replay)',()=>{
    let compared=0;
    for(const direction of ['up','down'] as const)for(let seed=1;seed<=6;seed++){
      const t=plant({direction,seed,noise:.3,tail:60});
      const full=detectHuzi(viewOf(t.bars),{...params,showInvalidated:true}).filter(m=>m.family==='huzi-accel');
      for(const cut of [t.breakout+2,t.breakout+8,t.breakout+30]){
        const early=detect(t,{},cut);
        for(const match of early){
          const same=full.find(m=>m.id===match.id);
          expect(same,`missing ${match.id} at cut ${cut}`).toBeDefined();
          expect(same!.confirmedAt).toBe(match.confirmedAt);
          expect(same!.points).toEqual(match.points);
          expect(same!.guides![0].points[0]).toEqual(match.guides![0].points[0]);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('is deterministic',()=>{
    const t=plant({seed:5,noise:.4});
    const a=detect(t),b=detect(t);
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // Same for a freshly planted copy (the generator is seeded).
    expect(JSON.stringify(detect(plant({seed:5,noise:.4})))).toBe(JSON.stringify(a));
  });
});

describe('English display',()=>{
  it.each(['up','down'] as const)('leaves no Chinese in a %s structure',direction=>{
    let checked=0;
    for(let seed=1;seed<=12&&checked<3;seed++){
      const t=plant({direction,seed,noise:.3}),match=detect(t).find(m=>recognises(t,m));
      if(!match)continue;
      expect(untranslated(match)).toEqual([]);checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
