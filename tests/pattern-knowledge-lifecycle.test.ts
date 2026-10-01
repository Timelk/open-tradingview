import {describe,expect,it,vi} from 'vitest';
import type {ColumnName,ColumnView} from '../src/lib/core/types';
import {ClosedRangeIndex} from '../src/lib/analysis/closed-range-index';
import {refreshPatternKnowledge} from '../src/lib/patterns/knowledge-lifecycle';
import {detectHuzi} from '../src/lib/patterns/huzi';
import {selectPatterns} from '../src/lib/patterns/selection';
import type {PatternMatch} from '../src/lib/patterns/types';

const step=60_000;
type Candle=number|[number,number,number,number];
function view(values:Candle[],closedLength=values.length-1):ColumnView {
  const cols=Object.fromEntries(['time','open','high','low','close','volume'].map(key=>[key,new Float64Array(values.length)])) as Record<ColumnName,Float64Array>;
  values.forEach((bar,i)=>{const [open,high,low,close]=typeof bar==='number'?[bar,bar,bar,bar]:bar;for(const [key,value] of Object.entries({time:i*step,open,high,low,close,volume:1}))cols[key as ColumnName][i]=value;});
  return {length:values.length,closedLength,intervalMs:step,col:name=>cols[name]};
}
const harmonic=(extra:Partial<PatternMatch>={}):PatternMatch=>({id:'harmonic:AB=CD',family:'AB=CD',name:'AB=CD',direction:'bullish',
  points:[{label:'A',time:0,value:100},{label:'B',time:step,value:90},{label:'C',time:2*step,value:100},{label:'D',time:3*step,value:90}],
  confirmedAt:5*step,zone:{low:89,high:91},invalidation:85,targets:[100,110],ratios:[],description:'reference',status:'confirmed',...extra});
const huzi=(extra:Partial<PatternMatch>={}):PatternMatch=>({...harmonic(),id:'huzi-channel',family:'huzi-channel',name:'上升通道',confirmedAt:3*step,zone:{low:103,high:105},invalidation:90,targets:[112],
  events:[{kind:'breakout',time:2*step,knownAt:3*step,value:106,boundary:104}],stage:'breakout',
  guides:[{role:'upper',points:[{label:'upper',time:0,value:100},{label:'upper',time:2*step,value:104}]},
    {role:'lower',points:[{label:'lower',time:0,value:85},{label:'lower',time:2*step,value:89}]}],...extra});
const huziBars:Candle[]=[100,100,[106,107,106,106],[109,113,108,109],[109,110,108.5,109],[109,110,108,109],[110,111,108,109],[121,125,120,121],[88,89,87,88],89];
const indexOf=(cols:ColumnView,closed=cols.closedLength??cols.length-1)=>new ClosedRangeIndex(cols,closed);

describe('full-knowledge pattern lifecycle independent of discovery viewport',()=>{
  it.each([false,true])('completes a harmonic at its reference target; a later move through the risk level is not a retroactive failure (bearish=%s)',bearish=>{
    const prices=[100,100,100,100,100,95,101,109,111,100,84,90];
    const cols=view(bearish?prices.map(p=>200-p):prices),match=harmonic(bearish?{direction:'bearish',invalidation:115,targets:[100,90]}:{}),snapshot=JSON.stringify(match);
    const found=refreshPatternKnowledge(match,indexOf(cols,6));expect(found.status).toBe('confirmed');expect(found.resolution).toBeUndefined();
    const full=refreshPatternKnowledge(found,indexOf(cols));
    expect(full.status).toBe('confirmed');expect(full.invalidatedAt).toBeUndefined();
    expect(full.resolution).toMatchObject({time:8*step,knownAt:9*step,price:bearish?90:110,targetIndex:1});
    expect(full.points).toBe(match.points);expect(full.confirmedAt).toBe(match.confirmedAt);expect(full.ratios).toBe(match.ratios);expect(full.zone).toBe(match.zone);
    expect(selectPatterns([full],{})).toEqual([full]);expect(JSON.stringify(match)).toBe(snapshot);
    // Without the touch, the same later move is a real failure inside the window.
    const unreached=refreshPatternKnowledge(harmonic(bearish?{direction:'bearish',invalidation:115,targets:[100,80]}:{targets:[100,120]}),indexOf(cols));
    expect(unreached.status).toBe('invalidated');expect(unreached.invalidatedAt).toBe(11*step);expect(unreached.resolution).toBeUndefined();
    for(const patternWindow of [{fromTime:0,toTime:6*step},{fromTime:7*step,toTime:9*step}]){
      expect(refreshPatternKnowledge(found,indexOf({...cols,patternWindow}))).toEqual(full);
    }
  });

  it('removes cached future failure/reference on explicit replay, then recovers them when the prefix advances',()=>{
    const cols=view([100,100,100,100,100,95,101,109,111,100,84,90]),fresh=harmonic(),full=refreshPatternKnowledge(fresh,indexOf(cols));
    const replay=refreshPatternKnowledge(full,indexOf(cols,7));expect(replay.status).toBe('confirmed');expect(replay.invalidatedAt).toBeUndefined();expect(replay.resolution).toBeUndefined();
    expect(refreshPatternKnowledge(replay,indexOf(cols))).toEqual(full);
    for(let closed=5;closed<=cols.length;closed++){
      const result=refreshPatternKnowledge(full,indexOf(cols,closed));
      expect(result.invalidatedAt===undefined||result.invalidatedAt<=closed*step).toBe(true);
      expect(result.resolution===undefined||result.resolution.knownAt<=closed*step).toBe(true);
    }
  });

  it('keeps Huzi breakout → retest → failed breakout → real invalidation, with the original sloped boundary',()=>{
    const cols=view(huziBars),original=huzi({targets:[130]}),full=refreshPatternKnowledge(original,indexOf(cols));
    expect(full.events?.map(event=>[event.kind,event.time/step,event.boundary])).toEqual([
      ['breakout',2,104],['retest',4,108],['failed-breakout',6,112],['invalidation',8,90],
    ]);
    expect(full.stage).toBe('invalidated');expect(full.invalidatedAt).toBe(9*step);expect(full.status).toBe('invalidated');
    expect(full.resolution).toBeUndefined();
    expect(full.guides?.[0].points[1]).toEqual({label:'upper',time:6*step,value:112});
    expect(full.guides?.[1].points[1]).toEqual({label:'lower',time:6*step,value:97});
    expect(selectPatterns([full],{})).toEqual([]);
    const replay=refreshPatternKnowledge(full,indexOf(cols,4));expect(replay.stage).toBe('breakout');expect(replay.events).toEqual(original.events);
    expect(replay.guides).toEqual(original.guides);expect(replay.resolution).toBeUndefined();
    expect(refreshPatternKnowledge(full,indexOf(cols,5)).stage).toBe('retest');
    expect(refreshPatternKnowledge(full,indexOf(cols,7)).stage).toBe('failed-breakout');
    expect(refreshPatternKnowledge(replay,indexOf(cols))).toEqual(full);
  });

  it('ends the Huzi lifecycle at its reference target instead of tracking later returns and failures',()=>{
    const cols=view(huziBars),original=huzi(),full=refreshPatternKnowledge(original,indexOf(cols));
    expect(full.resolution).toMatchObject({time:3*step,knownAt:4*step,price:112});
    expect(full.status).toBe('confirmed');expect(full.invalidatedAt).toBeUndefined();
    expect(full.events).toEqual(original.events);expect(full.stage).toBe('breakout');expect(full.guides).toEqual(original.guides);
    expect(selectPatterns([full],{})).toEqual([full]);
    expect(refreshPatternKnowledge(full,indexOf(cols,3)).resolution).toBeUndefined();
  });

  it('respects explicit retest limits while still checking risk inside the observation window',()=>{
    const cols=view(huziBars),match=huzi({targets:[130]}),full=refreshPatternKnowledge(match,indexOf(cols),{retestWindow:1});
    expect(full.events?.map(event=>event.kind)).toEqual(['breakout','invalidation']);expect(full.status).toBe('invalidated');
    expect(full.guides).toEqual(match.guides);expect(full.resolution).toBeUndefined();
    const later=refreshPatternKnowledge(match,indexOf(cols,8),{retestWindow:3});expect(later.stage).toBe('retest');expect(later.resolution).toBeUndefined();
    expect(later.events?.some(event=>event.kind==='failed-breakout')).toBe(false);
  });

  it('stops triangle inside/outside observation at its apex but preserves the fixed later risk',()=>{
    const cols=view([100,100,106,109,110,99,99,88,90]);
    const match=huzi({family:'huzi-triangle',guides:[
      {role:'upper',points:[{label:'upper',time:0,value:104},{label:'upper',time:2*step,value:104}]},
      {role:'lower',points:[{label:'lower',time:0,value:99},{label:'lower',time:2*step,value:101}]},
    ]});
    const result=refreshPatternKnowledge(match,indexOf(cols));
    expect(result.events?.map(e=>e.kind)).toEqual(['breakout','invalidation']);expect(result.invalidatedAt).toBe(8*step);
  });

  it('uses the head continuation line for retests and retains the original neck risk',()=>{
    const cols=view([100,100,126,128,[126,127,125,126],110,101,98,100]);
    const match=huzi({id:'huzi-head-shoulders:x:continuation',family:'huzi-head-shoulders',zone:{low:124,high:126},invalidation:99,targets:[150],
      events:[{kind:'breakout',time:2*step,knownAt:3*step,value:126,boundary:125}],guides:[
        {role:'neckline',points:[{label:'neckline',time:0,value:100},{label:'neckline',time:2*step,value:100}]},
        {role:'upper',points:[{label:'head',time:0,value:125},{label:'head',time:2*step,value:125}]},
      ]});
    const result=refreshPatternKnowledge(match,indexOf(cols));
    expect(result.events?.map(e=>[e.kind,e.boundary])).toEqual([['breakout',125],['retest',125],['failed-breakout',125],['invalidation',99]]);
    expect(result.invalidatedAt).toBe(8*step);
  });

  it('never measures a touch after an earlier or same-bar risk wick, failure, or already exceeded target',()=>{
    for(const tail of [[95,84,111],[95,[105,112,85,105] as Candle],[111,95,111]]){
      const result=refreshPatternKnowledge(harmonic(),indexOf(view([100,100,100,100,100,...tail,100])));expect(result.resolution).toBeUndefined();
    }
    const prices=[...huziBars];prices[3]=109;
    expect(refreshPatternKnowledge(huzi({targets:[120]}),indexOf(view(prices))).resolution).toBeUndefined();
  });

  it('keeps a first completed candle before a later data gap, blocks post-gap claims, and recovers after repair',()=>{
    const cols=view([100,100,100,100,100,95,111,100,84,90]);
    for(let i=7;i<cols.length;i++)cols.col('time')[i]+=step;
    const match=refreshPatternKnowledge(harmonic(),indexOf(cols));
    // Completed before the gap: the later hole cannot change a finished story.
    expect(match.status).toBe('confirmed');expect(match.dataWarning).toBeUndefined();
    expect(match.resolution).toMatchObject({time:6*step,knownAt:7*step});
    const open=refreshPatternKnowledge(harmonic({targets:[100,120]}),indexOf(cols));expect(open.dataWarning).toMatch(/缺口/);expect(open.invalidatedAt).toBeUndefined();
    const firstGap=view([100,100,100,100,100,95,111,100,84,90]);firstGap.col('close')[5]=NaN;
    const blocked=refreshPatternKnowledge(harmonic(),indexOf(firstGap));expect(blocked.resolution).toBeUndefined();expect(blocked.invalidatedAt).toBeUndefined();expect(blocked.dataWarning).toBeTruthy();
    firstGap.col('close')[5]=95;expect(refreshPatternKnowledge(blocked,indexOf(firstGap)).resolution).toMatchObject({time:6*step});
    expect(refreshPatternKnowledge(harmonic({targets:[100,120]}),indexOf(firstGap)).status).toBe('invalidated');
    expect(refreshPatternKnowledge(blocked,indexOf(firstGap)).dataWarning).toBeUndefined();
  });

  it('does not bridge missing confirmation evidence or derive events from a forming tail/sentinel',()=>{
    const cols=view([100,100,100,100,100,95,105,84]);
    const first=refreshPatternKnowledge(harmonic(),indexOf(cols));expect(first.status).toBe('confirmed');
    expect(refreshPatternKnowledge(first,indexOf(cols,cols.length)).status).toBe('invalidated');
    const sentinel=view([100,100,100,100,100,95,111,[NaN,NaN,NaN,NaN]]);
    expect(refreshPatternKnowledge(harmonic(),indexOf(sentinel)).resolution?.knownAt).toBe(7*step);
    expect(refreshPatternKnowledge(harmonic(),indexOf(sentinel)).dataWarning).toBeUndefined();
    const absent=view([100,100,100,100,100,95,111,84]);for(let i=5;i<absent.length;i++)absent.col('time')[i]+=step;
    const interrupted=refreshPatternKnowledge(harmonic(),indexOf(absent));expect(interrupted.dataWarning).toBeTruthy();expect(interrupted.resolution).toBeUndefined();expect(interrupted.invalidatedAt).toBeUndefined();
  });

  it('uses calendar closes and index-space guide slopes instead of assuming equal month milliseconds',()=>{
    const cols=view(huziBars);cols.intervalMs=undefined;
    for(let i=0;i<cols.length;i++)cols.col('time')[i]=Date.UTC(2026,i,1);
    const original=huzi(),remap=(time:number)=>Date.UTC(2026,time/step,1),match={...original,confirmedAt:remap(original.confirmedAt),points:original.points.map(p=>({...p,time:remap(p.time)})),
      events:original.events!.map(e=>({...e,time:remap(e.time),knownAt:remap(e.knownAt)})),guides:original.guides!.map(g=>({...g,points:g.points.map(p=>({...p,time:remap(p.time)})) as typeof g.points}))};
    const full=refreshPatternKnowledge(match,indexOf(cols));expect(full.resolution?.knownAt).toBe(Date.UTC(2026,4,1));expect(full.invalidatedAt).toBeUndefined();
    expect(refreshPatternKnowledge({...match,targets:[130]},indexOf(cols)).invalidatedAt).toBe(Date.UTC(2026,9,1));
    const replay=refreshPatternKnowledge(full,indexOf(cols,4));expect(replay.guides).toEqual(match.guides);expect(replay.stage).toBe('breakout');
  });

  it('matches direct Huzi lifecycle on each known prefix without moving actual geometry or confirmation',()=>{
    const knots=[[0,100],[10,110],[20,90],[30,110],[40,98],[50,110],[55,106],[63,115],[70,115],[74,109],[80,80],[84,80]];
    const prices:number[]=[];let segment=0;
    for(let i=0;i<=84;i++){while(segment+1<knots.length-1&&i>knots[segment+1][0])segment++;const [a,pa]=knots[segment],[b,pb]=knots[segment+1];prices.push(pa+(pb-pa)*(i-a)/(b-a));}
    const cols=view(prices.map(p=>[p,p+.1,p-.1,p] as Candle)),params={pivotStrength:2,lookback:1500,tolerance:.04,maxPatterns:100,showInvalidated:true,retestWindow:30};
    const match=detectHuzi(cols,params).find(p=>p.name==='上升三角形')!;expect(match).toBeDefined();
    for(let closed=match.confirmedAt/step;closed<=84;closed++){
      const direct=detectHuzi({...cols,length:closed+1,closedLength:closed},params).find(p=>p.id===match.id)!;expect(direct).toBeDefined();
      const actual=refreshPatternKnowledge(match,indexOf(cols,closed),params);
      expect(actual.status).toBe(direct.status);expect(actual.invalidatedAt).toBe(direct.invalidatedAt);expect(actual.stage).toBe(direct.stage);expect(actual.events).toEqual(direct.events);
      expect(actual.points).toBe(match.points);expect(actual.confirmedAt).toBe(match.confirmedAt);
    }
  });

  it('finds remote post-10k touches/failures with a bounded number of indexed queries',()=>{
    const count=300_000,cols=view(Array<number>(count).fill(95),count);cols.col('low')[240_000]=84;cols.col('high')[290_000]=112;
    const index=indexOf(cols),cross=vi.spyOn(index,'firstCross'),invalid=vi.spyOn(index,'firstInvalid');
    let reads=0;const observed=new Map<ColumnName,Float64Array>();
    index.cols={...cols,col(name){if(!observed.has(name))observed.set(name,new Proxy(cols.col(name),{get(target,key){if(typeof key==='string'&&/^\d+$/.test(key))reads++;return Reflect.get(target,key,target);}}));return observed.get(name)!;}};
    const result=refreshPatternKnowledge(harmonic(),index,{observationRatio:1e6});
    expect(result.resolution).toBeUndefined();expect(result.invalidatedAt).toBe(240_001*step);expect(result.status).toBe('invalidated');
    expect(cross).toHaveBeenCalledTimes(3);expect(invalid).toHaveBeenCalledTimes(1);
    // Tree lookup plus at most a few 256-row boundary blocks, never 300k rows.
    expect(reads).toBeLessThan(2500);
  });

  it('ends observation after max(24, 2 × span) bars; later prices no longer judge the structure',()=>{
    const prices=Array<number>(60).fill(100);prices[5]=95;prices[40]=84;
    const cols=view(prices),result=refreshPatternKnowledge(harmonic({targets:[100,120]}),indexOf(cols));
    // span A→D is 3 bars → window max(24, 6) = 24 bars from confirmation (bar 5).
    expect(result.status).toBe('confirmed');expect(result.invalidatedAt).toBeUndefined();expect(result.observationEndedAt).toBe(29*step);
    expect(selectPatterns([result],{})).toEqual([result]);
    const early=[...prices];early[40]=100;early[20]=84;
    expect(refreshPatternKnowledge(harmonic({targets:[100,120]}),indexOf(view(early))).invalidatedAt).toBe(21*step);
    expect(refreshPatternKnowledge(harmonic({targets:[100,120]}),indexOf(cols,20)).observationEndedAt).toBeUndefined();
    expect(refreshPatternKnowledge(harmonic({targets:[100,120]}),indexOf(cols),{observationRatio:20}).invalidatedAt).toBe(41*step);
  });
});
