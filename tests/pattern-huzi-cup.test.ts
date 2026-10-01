import {describe,expect,it} from 'vitest';
import {detectHuzi} from '../src/lib/patterns/huzi';
import type {PatternMatch} from '../src/lib/patterns/types';
import {cupSetups} from '../src/lib/patterns/huzi-cup';
import {fitQuadratic} from '../src/lib/patterns/huzi-fit';
import {STEP_MS,viewOf} from './fixtures/huzi-synthetic';
import {plantCup,type CupShape,type PlantedCup} from './fixtures/huzi-cup-planted';
import {untranslated} from './fixtures/huzi-english';

const params={pivotStrength:3,lookback:1500,tolerance:.04,maxPatterns:1000,showInvalidated:true,minStructureBars:0,family:'杯柄 / 圆弧'};
const run=(t:PlantedCup,extra:Record<string,unknown>={},cut=t.breakout+6)=>detectHuzi(viewOf(t.bars,cut),{...params,...extra});
const hour=(time:number)=>time/STEP_MS;
/** Matches anchored on the planted rims: same left rim, right rim within 15 % of the width. */
const anchored=(matches:PatternMatch[],t:PlantedCup)=>{
  const width=t.rightRim-t.leftRim;
  return matches.filter(m=>Math.abs(hour(m.points[0].time)-t.leftRim)<=.15*width&&Math.abs(hour(m.points[2].time)-t.rightRim)<=.15*width);
};
const WIDTHS=[60,100,160,240];

describe('cups and rounded bases',()=>{
  it('recovers planted cups and rounded bases (both orientations) at every width',()=>{
    let total=0,found=0;
    for(const shape of ['cup','arc'] as CupShape[])for(const mirror of [false,true])for(const width of WIDTHS)for(let seed=1;seed<=8;seed++){
      const t=plantCup({shape,width,seed,mirror,noise:.4});total++;
      const hit=anchored(run(t),t).find(m=>m.direction===t.direction);
      if(hit){
        found++;
        expect(['huzi-cup','huzi-arc']).toContain(hit.family);
        expect(hit.name).toBe(mirror?(hit.family==='huzi-cup'?'倒杯柄':'圆弧顶'):(hit.family==='huzi-cup'?'杯柄':'圆弧底'));
        // the reference target is one cup depth beyond the neckline
        expect(Math.abs(hit.targets[0]-hit.events![0].boundary)).toBeGreaterThan(0);
      }
    }
    expect(total).toBe(128);
    expect(found/total).toBeGreaterThanOrEqual(.7);
  });

  it('calls a base with a real handle a cup and handle, and a bare one a rounded base',()=>{
    let cups=0,handled=0,arcs=0,bare=0;
    for(const mirror of [false,true])for(const width of [100,160])for(let seed=1;seed<=10;seed++){
      const withHandle=anchored(run(plantCup({shape:'cup',width,seed,mirror,noise:.4})),plantCup({shape:'cup',width,seed,mirror,noise:.4}));
      if(withHandle.length){cups++;if(withHandle.every(m=>m.family==='huzi-cup'))handled++;}
      const t=plantCup({shape:'arc',width,seed,mirror,noise:.15});
      const bareMatches=anchored(run(t),t);
      if(bareMatches.length){arcs++;if(bareMatches.some(m=>m.family==='huzi-arc'))bare++;}
    }
    expect(handled/cups).toBeGreaterThan(.9);
    expect(bare/arcs).toBeGreaterThan(.5);
  });

  it('does not read a V, a W, a low right rim or a straight fall as a cup',()=>{
    let checked=0;
    for(const shape of ['v','w','low-rim','fall'] as CupShape[])for(const mirror of [false,true])for(const width of WIDTHS)for(let seed=1;seed<=8;seed++){
      const t=plantCup({shape,width,seed,mirror,noise:.4});checked++;
      expect(anchored(run(t),t).map(m=>m.name)).toEqual([]);
    }
    expect(checked).toBe(256);
  });

  it('lists one move once: a base and the same base with a handle are not both shown',()=>{
    for(const shape of ['cup','arc'] as CupShape[])for(const mirror of [false,true])for(const noise of [.4,.9])for(const width of [80,150])for(let seed=1;seed<=15;seed++){
      const t=plantCup({shape,width,seed,mirror,noise});
      const byBreakout=new Map<number,Set<string>>();
      for(const m of anchored(run(t),t)){const set=byBreakout.get(m.confirmedAt)??new Set();set.add(m.family);byBreakout.set(m.confirmedAt,set);}
      for(const families of byBreakout.values())expect(families.size).toBe(1);
    }
  });

  it('is causal: a structure appears with its breakout candle and not before, and later data does not change it',()=>{
    let checked=0;
    for(const mirror of [false,true])for(let seed=1;seed<=8;seed++){
      const t=plantCup({shape:'cup',width:120,seed,mirror,noise:.4});
      const match=anchored(run(t),t)[0];if(!match)continue;
      checked++;
      const confirmedIndex=hour(match.confirmedAt);
      // cut = confirmedIndex + 1 bars: the breakout candle (confirmedIndex − 1) is the last closed one
      const at=run(t,{},confirmedIndex+1).find(m=>m.id===match.id);
      expect(at).toBeDefined();
      expect(at!.confirmedAt).toBe(match.confirmedAt);
      expect(at!.points).toEqual(match.points);
      expect(at!.guides![0].points[0]).toEqual(match.guides![0].points[0]);
      expect(run(t,{},confirmedIndex).some(m=>m.id===match.id)).toBe(false);
      // more data after the breakout only adds lifecycle; the anchors and the confirmation stay
      const later=run(t,{},t.bars.length).find(m=>m.id===match.id);
      expect(later?.confirmedAt).toBe(match.confirmedAt);
      expect(later?.points).toEqual(match.points);
    }
    expect(checked).toBeGreaterThan(8);
  });

  it('never looks at bars after the cut: scrambling the future changes nothing',()=>{
    const t=plantCup({shape:'cup',width:120,seed:3,noise:.4});
    const cut=t.breakout+6,base=run(t,{},cut);
    const scrambled=plantCup({shape:'cup',width:120,seed:3,noise:.4});
    for(let i=cut;i<scrambled.bars.length;i++){scrambled.bars[i][2]=1e6;scrambled.bars[i][3]=-1e6;scrambled.bars[i][4]=(i%2?1:-1)*5e5;}
    expect(run(scrambled,{},cut)).toEqual(base);
  });

  it('is deterministic',()=>{
    const t=plantCup({shape:'cup',width:150,seed:5,noise:.6});
    expect(JSON.stringify(run(t))).toBe(JSON.stringify(run(t)));
  });

  it('honours minStructureBars and the extraStructures switch',()=>{
    const t=plantCup({shape:'cup',width:100,seed:2,noise:.3});
    expect(anchored(run(t),t).length).toBeGreaterThan(0);
    // the structure runs from the left rim to the handle low (111 bars)
    expect(anchored(run(t,{minStructureBars:100}),t).length).toBeGreaterThan(0);
    expect(anchored(run(t,{minStructureBars:120}),t)).toEqual([]);
    expect(run(t,{extraStructures:false}).filter(m=>m.family==='huzi-cup'||m.family==='huzi-arc')).toEqual([]);
  });

  it('draws a neckline at the higher rim and the fitted curve between the rims',()=>{
    let checked=0;
    for(const mirror of [false,true])for(let seed=1;seed<=6;seed++){
      const t=plantCup({shape:'cup',width:140,seed,mirror,noise:.4});
      const match=anchored(run(t),t)[0];if(!match)continue;
      checked++;
      const neck=match.guides!.find(g=>g.role==='neckline')!,curve=match.guides!.find(g=>g.role==='curve')!;
      expect(neck).toBeDefined();expect(curve).toBeDefined();
      const rim=mirror?Math.min(match.points[0].value,match.points[2].value):Math.max(match.points[0].value,match.points[2].value);
      expect(neck.points[0].value).toBeCloseTo(rim,6);
      expect(curve.path!.length).toBeGreaterThanOrEqual(3);
      expect(curve.path![0].time).toBe(match.points[0].time);
      expect(curve.path!.at(-1)!.time).toBe(match.points[2].time);
      expect(curve.points[0]).toEqual(curve.path![0]);
      expect(curve.points[1]).toEqual(curve.path!.at(-1));
      expect(curve.path!.every(p=>Number.isFinite(p.time)&&Number.isFinite(p.value))).toBe(true);
      // the curve is a bowl: it dips (rises, inverted) between the rims
      const ends=(curve.path![0].value+curve.path!.at(-1)!.value)/2,middle=curve.path![Math.floor(curve.path!.length/2)].value;
      expect(mirror?middle>ends:middle<ends).toBe(true);
      expect(match.ratios.map(r=>r.label)).toEqual(expect.arrayContaining(['杯深 / 区间平均波幅','左右沿高差 / 杯深','抛物线拟合 R²','杯内低位收盘占比','柄回撤 / 杯深']));
      expect(match.description).toContain('杯形取自最近的三个交替拐点');
    }
    expect(checked).toBeGreaterThan(6);
  });

  it('has its stop under the handle (cup) or the base (bare), and a target one depth beyond the neckline',()=>{
    const t=plantCup({shape:'cup',width:140,seed:4,noise:.3});
    const match=anchored(run(t),t).find(m=>m.family==='huzi-cup')!;
    expect(match).toBeDefined();
    expect(match.invalidation).toBeLessThan(match.points[3].value);
    const depth=Math.min(match.points[0].value,match.points[2].value)-match.points[1].value;
    expect(match.targets[0]-Math.max(match.points[0].value,match.points[2].value)).toBeCloseTo(depth,6);
  });

  it('is fully translated',()=>{
    let cup=false,arc=false;
    for(const shape of ['cup','arc'] as CupShape[])for(const mirror of [false,true])for(let seed=1;seed<=12;seed++){
      const t=plantCup({shape,width:120,seed,mirror,noise:.3});
      for(const m of anchored(run(t),t)){
        expect(untranslated(m)).toEqual([]);
        if(m.family==='huzi-cup')cup=true;else arc=true;
      }
    }
    expect(cup&&arc).toBe(true);
  });
});

describe('cupSetups guards',()=>{
  const flat={open:new Float64Array(10),high:new Float64Array(10),low:new Float64Array(10),close:new Float64Array(10)};
  it('needs an alternating high-low-high run in time order',()=>{
    const pivot=(index:number,value:number,kind:'high'|'low')=>({index,time:index,value,kind,confirmedAt:index+3});
    expect(cupSetups([],3,.04,flat)).toEqual([]);
    expect(cupSetups([pivot(0,10,'high'),pivot(5,5,'low')],3,.04,flat)).toEqual([]);
    // two highs in a row, and too narrow to be a base
    expect(cupSetups([pivot(0,10,'high'),pivot(3,11,'high'),pivot(6,10,'high')],3,.04,flat)).toEqual([]);
    expect(cupSetups([pivot(0,10,'high'),pivot(5,5,'low'),pivot(9,10,'high')],3,.04,flat)).toEqual([]);
  });
  it('fits a parabola exactly and refuses too few points',()=>{
    const xs=[0,1,2,3,4,5,6],ys=xs.map(x=>2*(x-3)**2+1);
    const fit=fitQuadratic(xs,ys)!;
    expect(fit.a).toBeCloseTo(2,9);expect(fit.r2).toBeCloseTo(1,9);expect(fit.at(3)).toBeCloseTo(1,9);expect(fit.slopeAt(3)).toBeCloseTo(0,9);
    expect(fitQuadratic([1,2],[1,2])).toBeUndefined();
  });
});
