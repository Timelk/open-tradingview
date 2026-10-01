import {describe,expect,it} from 'vitest';
import {detectHuzi} from '../src/lib/patterns/huzi';
import {ZONE_BAND_SHARE,ZONE_DIP_SHARE,ZONE_MIN_SPAN} from '../src/lib/patterns/huzi-zone';
import type {PatternMatch} from '../src/lib/patterns/types';
import {plant,STEP_MS,viewOf} from './fixtures/huzi-synthetic';
import {foundZone,plantZone,randomWalk,type PlantedZone,type ZoneOptions} from './fixtures/huzi-zone-planted';
import {untranslated} from './fixtures/huzi-english';

const params={pivotStrength:3,lookback:1500,tolerance:.04,maxPatterns:1000,showInvalidated:true,minStructureBars:0};
const detect=(t:{bars:PlantedZone['bars']},cut:number,extra:Record<string,unknown>={})=>detectHuzi(viewOf(t.bars,cut),{...params,...extra});
const bar=(time:number)=>Math.round(time/STEP_MS);
const zones=(matches:readonly PatternMatch[])=>matches.filter(m=>m.family==='huzi-zone');
const sides=['ceiling','floor'] as const,outcomes=['through','held'] as const;

/** Every combination the planted structures come in, with a fixed seed budget. */
function* planted(seeds:number,lengths=[60,120,220],noise=.4){
  for(const side of sides)for(const outcome of outcomes)for(const length of lengths)for(let seed=1;seed<=seeds;seed++){
    const options:ZoneOptions={side,outcome,length,seed,noise,touches:3+(seed%3)};
    const t=plantZone(options);
    if(t.breakout>=0)yield {t,options};
  }
}

describe('画门 / horizontal band: recognition of planted structures',()=>{
  it('finds most planted doors, on both sides and with either outcome',()=>{
    let n=0,hit=0;
    for(const {t} of planted(10)){n++;if(foundZone(detect(t,t.breakout+5),t))hit++;}
    expect(n).toBeGreaterThan(100);
    expect(hit/n).toBeGreaterThan(.85);
  });

  it.each([
    ['ceiling','through','bullish','画门 · 压力带'],
    ['ceiling','held','bearish','画门 · 压力带'],
    ['floor','through','bearish','画门 · 支撑带'],
    ['floor','held','bullish','画门 · 支撑带'],
  ] as const)('%s + %s ends %s (%s)',(side,outcome,direction,name)=>{
    let seen=0;
    for(let seed=1;seed<=12;seed++){
      const t=plantZone({side,outcome,length:120,seed,noise:.3,touches:4});
      const match=foundZone(detect(t,t.breakout+5),t);
      if(!match)continue;
      seen++;
      expect(t.direction).toBe(direction);
      expect(match.direction).toBe(direction);
      expect(match.name).toBe(name);
      expect(match.family).toBe('huzi-zone');
      expect(match.id.endsWith(`:${direction}`)).toBe(true);
      expect(match.points[0].label).toBe(side==='ceiling'?'T1':'S1');
      expect(match.points.length%2).toBe(1);
    }
    expect(seen).toBeGreaterThanOrEqual(9);
  });

  it('calls the outcome with or against the approach: continuation when it goes on, reversal when the band holds',()=>{
    const kinds={continuation:0,reversal:0,wrong:0};
    for(const side of sides)for(let seed=1;seed<=12;seed++){
      for(const outcome of outcomes){
        const t=plantZone({side,outcome,length:120,seed,noise:.3,touches:4});
        const match=foundZone(detect(t,t.breakout+5),t);
        if(!match?.context)continue;
        // The planted approach climbs into a ceiling and falls into a floor.
        const approach=side==='ceiling'?'bullish':'bearish';
        const expected=match.direction===approach?'continuation':'reversal';
        if(match.context.kind===expected)kinds[expected]++;else kinds.wrong++;
      }
    }
    expect(kinds.wrong).toBe(0);
    expect(kinds.continuation).toBeGreaterThan(5);
    expect(kinds.reversal).toBeGreaterThan(5);
  });

  it('keeps the two outcomes of the same anchors apart (one id each)',()=>{
    const t=plantZone({side:'ceiling',outcome:'held',length:120,seed:2,noise:.3,touches:4});
    const held=foundZone(detect(t,t.breakout+5),t)!;
    const through=plantZone({side:'ceiling',outcome:'through',length:120,seed:2,noise:.3,touches:4});
    const up=foundZone(detect(through,through.breakout+5),through)!;
    expect(held.direction).toBe('bearish');expect(up.direction).toBe('bullish');
    // Same anchors before the outcome, so only the suffix separates the ids.
    expect(held.id.replace(/:bearish$/,'')).toBe(up.id.replace(/:bullish$/,''));
    expect(held.id).not.toBe(up.id);
  });
});

describe('画门 / horizontal band: what is not a door',()=>{
  const found=(t:PlantedZone,cut=t.breakout+5,extra:Record<string,unknown>={})=>zones(detect(t,cut,extra)).filter(m=>bar(m.points[0].time)>=t.first-6&&bar(m.points.at(-1)!.time)<=t.last+6);

  it('does not report two tests as a door',()=>{
    let two=0;
    for(let seed=1;seed<=20;seed++){
      const t=plantZone({side:'ceiling',outcome:'through',length:120,seed,touches:2});
      if(t.breakout<0)continue;
      two++;
      expect(found(t)).toEqual([]);
    }
    expect(two).toBeGreaterThan(10);
  });

  it('does not report a band that is wide next to the structure',()=>{
    let checked=0;
    for(const side of sides)for(let seed=1;seed<=12;seed++){
      // Each test lands higher than the last, over a range a third of the structure: no three of them share a band.
      const t=plantZone({side,outcome:'through',length:160,seed,noise:0,touches:5,spread:.3,levels:[1,.75,.5,.25,0]});
      if(t.breakout<0)continue;
      checked++;
      // The pullbacks of a ceiling can by chance sit at one level and make a floor of their own; the band tested
      // here is the ceiling's (a floor's for the mirrored structure).
      expect(found(t).filter(m=>m.name===(side==='ceiling'?'画门 · 压力带':'画门 · 支撑带'))).toEqual([]);
    }
    expect(checked).toBeGreaterThan(15);
  });

  it('leaves a flat top over rising lows to the triangle family, and a rectangle to the channel',()=>{
    let rising=0,flat=0;
    for(const dips of ['rising','flat'] as const)for(let seed=1;seed<=16;seed++){
      const t=plantZone({side:'ceiling',outcome:'through',length:120,seed,noise:.2,touches:3,dips});
      if(t.breakout<0)continue;
      if(dips==='rising')rising++;else flat++;
      expect(found(t)).toEqual([]);
    }
    expect(rising).toBeGreaterThan(8);expect(flat).toBeGreaterThan(8);
  });

  it('never repeats the flat top of an ascending triangle as a door',()=>{
    let triangles=0;
    for(let seed=1;seed<=24;seed++){
      const t=plant({kind:'asc-triangle',length:120,seed,noise:.3,prefix:300,breakout:'up'});
      const all=detectHuzi(viewOf(t.bars,t.breakout+6),{...params});
      if(all.some(m=>m.family==='huzi-triangle'&&m.name==='上升三角形'&&Math.abs(bar(m.points[0].time)-t.first)<=6))triangles++;
      const near=zones(all).filter(m=>bar(m.points[0].time)>=t.first-6&&bar(m.points.at(-1)!.time)<=t.last+6);
      expect(near).toEqual([]);
    }
    expect(triangles).toBeGreaterThan(8);
  });

  it('is not fooled by a close through the band while it is being tested',()=>{
    let checked=0;
    for(const side of sides)for(let seed=1;seed<=12;seed++){
      const t=plantZone({side,outcome:'through',length:200,seed,noise:.2,touches:5});
      if(t.breakout<0)continue;
      // A decisive close beyond the band between the third and fourth test, then back inside.
      const at=Math.round((t.touches[2]+t.touches[3])/2),step=side==='ceiling'?1:-1;
      for(const i of [at,at+1]){
        const row=t.bars[i],c=t.bandHigh+step*(side==='ceiling'?.3:-.3)*t.depth;
        const beyond=side==='ceiling'?c:t.bandLow-.3*t.depth;
        row[4]=beyond;row[2]=Math.max(row[2],beyond);row[3]=Math.min(row[3],beyond);
      }
      checked++;
      // No reading may run from the first to the last test across the bar that went through.
      const whole=zones(detect(t,t.breakout+5)).filter(m=>bar(m.points[0].time)<=t.touches[1]&&bar(m.points.at(-1)!.time)>=t.touches[4]-4);
      expect(whole).toEqual([]);
    }
    expect(checked).toBeGreaterThan(15);
  });

  it('stays quiet on chance: a random walk gives only a handful of doors per 1500 bars',()=>{
    let total=0;const charts=12;
    for(let seed=1;seed<=charts;seed++)total+=zones(detectHuzi(viewOf(randomWalk(seed)),{...params,minStructureBars:20})).length;
    // Measured ~1.8 per chart with the shipped limits; the limits loosened to 10% of height give ~11.
    expect(total/charts).toBeLessThan(4);
  });

  it('can be switched off with the extended structures',()=>{
    let any=0;
    for(const {t} of planted(3,[120])){
      if(zones(detect(t,t.breakout+5)).length)any++;
      expect(zones(detect(t,t.breakout+5,{extraStructures:false}))).toEqual([]);
    }
    expect(any).toBeGreaterThan(5);
  });
});

describe('画门 / horizontal band: geometry, causality and lifecycle',()=>{
  const sample=(side:'ceiling'|'floor',outcome:'through'|'held')=>{
    for(let seed=1;seed<=20;seed++){
      const t=plantZone({side,outcome,length:140,seed,noise:.3,touches:4});
      const match=t.breakout>=0?foundZone(detect(t,t.breakout+5),t):undefined;
      if(match)return {t,match};
    }
    throw new Error(`no ${side} ${outcome} door found`);
  };

  it.each([['ceiling','through'],['ceiling','held'],['floor','through'],['floor','held']] as const)('draws the band and the level it is judged by (%s, %s)',(side,outcome)=>{
    const {t,match}=sample(side,outcome);
    const role=(name:string)=>match.guides!.find(g=>g.role===name)!;
    expect(match.guides!.map(g=>g.role).sort()).toEqual(['lower','neckline','upper']);
    // The band edges are the extreme touches; every guide is a horizontal line.
    const tol=t.depth*.02;
    expect(role('upper').points[0].value).toBeCloseTo(role('upper').points[1].value,6);
    expect(Math.abs(role('upper').points[0].value-t.bandHigh)).toBeLessThan(tol);
    expect(Math.abs(role('lower').points[0].value-t.bandLow)).toBeLessThan(tol);
    // through: the band's own edge; held: the deepest pullback.
    const neck=role('neckline').points[0].value;
    const expected=outcome==='held'?t.deepest:side==='ceiling'?t.bandHigh:t.bandLow;
    expect(Math.abs(neck-expected)).toBeLessThan(t.depth*.05);
    expect(match.points[0].time).toBe(t.bars[t.touches[0]][0]);
    expect(match.status).toBe('confirmed');
    expect(match.events?.[0]).toMatchObject({kind:'breakout'});
    expect(match.ratios.slice(0,3).map(r=>r.label)).toEqual(['触点数','带宽 / 结构高度','最浅回撤 / 结构高度']);
    const [touches,width,dip]=match.ratios;
    expect(touches.value).toBeGreaterThanOrEqual(3);
    expect(match.description).toContain(`水平带由 ${touches.value} 个触点组成`);
    expect(width.value).toBeLessThanOrEqual(ZONE_BAND_SHARE+params.tolerance);
    expect(dip.value).toBeGreaterThanOrEqual(ZONE_DIP_SHARE);
  });

  it('projects the target by the structure height and puts the risk level on the far side',()=>{
    const {match}=sample('ceiling','through');
    const boundary=match.events![0].boundary,height=match.targets[0]-boundary;
    expect(height).toBeGreaterThan(0);
    expect(match.invalidation).toBeLessThan(boundary);
    const held=sample('ceiling','held').match;
    expect(held.targets[0]).toBeLessThan(held.events![0].boundary);
    expect(held.invalidation).toBeGreaterThan(held.events![0].boundary);
  });

  it('is deterministic',()=>{
    const {t}=sample('ceiling','held');
    expect(detect(t,t.breakout+5)).toEqual(detect(t,t.breakout+5));
  });

  it('knows a door only when its outcome candle has closed, and ignores everything after that',()=>{
    let checked=0;
    for(const {t} of planted(3,[100,200])){
      const match=foundZone(detect(t,t.breakout+5),t);
      if(!match)continue;
      checked++;
      const c=bar(match.confirmedAt);
      // Closed data through the breakout candle: known. One candle less: not yet.
      const known=zones(detect(t,c+1)).find(m=>m.id===match.id);
      expect(known).toMatchObject({id:match.id,confirmedAt:match.confirmedAt,direction:match.direction,points:match.points,targets:match.targets,invalidation:match.invalidation});
      expect(zones(detect(t,c)).some(m=>m.id===match.id)).toBe(false);
      // Poison every candle after the breakout: with closedLength fixed they must not matter.
      const bars=t.bars.map(row=>row.slice()) as PlantedZone['bars'];
      for(let i=c;i<bars.length;i++){bars[i][2]=1e6;bars[i][3]=1e-6;bars[i][4]=i%2?1e6/2:1;bars[i][1]=bars[i][4];}
      const cols:Record<string,Float64Array>={};
      ['time','open','high','low','close','volume'].forEach((name,j)=>{cols[name]=Float64Array.from(bars.map(r=>r[j]));});
      const view={length:bars.length,closedLength:c,intervalMs:STEP_MS,col:(name:string)=>cols[name]} as never;
      const hidden=zones(detectHuzi(view,params)).find(m=>m.id===match.id);
      expect(hidden).toMatchObject({id:match.id,confirmedAt:match.confirmedAt,points:match.points,targets:match.targets});
    }
    expect(checked).toBeGreaterThan(8);
  });

  it('replays candle by candle to the same structures and never revises a confirmation',()=>{
    const t=plantZone({side:'floor',outcome:'held',length:120,seed:4,noise:.3,touches:4,tail:60});
    const final=zones(detect(t,t.bars.length));
    expect(final.length).toBeGreaterThan(0);
    const firstSeen=new Map<string,PatternMatch>();
    for(let cut=t.last-10;cut<=t.bars.length;cut++)for(const m of zones(detect(t,cut)))if(!firstSeen.has(m.id))firstSeen.set(m.id,m);
    for(const m of final){
      const early=firstSeen.get(m.id);
      expect(early).toBeDefined();
      // What was known at the first replay step is what the full run reports for the anchors and the confirmation.
      expect({points:early!.points,confirmedAt:early!.confirmedAt,direction:early!.direction}).toEqual({points:m.points,confirmedAt:m.confirmedAt,direction:m.direction});
    }
  });

  it('honours the minimum structure length',()=>{
    const {t,match}=sample('ceiling','through');
    const span=bar(match.points.at(-1)!.time)-bar(match.points[0].time);
    expect(span).toBeGreaterThanOrEqual(ZONE_MIN_SPAN);
    expect(zones(detect(t,t.breakout+5,{minStructureBars:span})).some(m=>m.id===match.id)).toBe(true);
    expect(zones(detect(t,t.breakout+5,{minStructureBars:span+1})).some(m=>m.id===match.id)).toBe(false);
    expect(zones(detect(t,t.breakout+5,{minStructureBars:10000}))).toEqual([]);
  });

  it('is limited to its own family when asked',()=>{
    const {t}=sample('ceiling','through');
    expect(zones(detect(t,t.breakout+5,{family:'画门 / 水平带'})).length).toBeGreaterThan(0);
    expect(zones(detect(t,t.breakout+5,{family:'三角形'}))).toEqual([]);
  });
});

describe('画门 / horizontal band: English display',()=>{
  it.each([['ceiling','through'],['ceiling','held'],['floor','through'],['floor','held']] as const)('leaves nothing in Chinese (%s, %s)',(side,outcome)=>{
    for(let seed=1;seed<=20;seed++){
      const t=plantZone({side,outcome,length:140,seed,noise:.3,touches:4});
      const match=t.breakout>=0?foundZone(detect(t,t.breakout+5),t):undefined;
      if(!match)continue;
      expect(match.description).toContain(`水平带由 ${match.ratios[0].value} 个触点组成`);
      expect(untranslated(match)).toEqual([]);
      return;
    }
    throw new Error('no door found');
  });
});
