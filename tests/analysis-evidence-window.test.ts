import {describe,expect,it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import type {BarInput,ColumnView,DerivedSeries,ParamValues} from '../src/lib/core/types';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {IndicatorRuntime,type IndicatorReq} from '../src/lib/indicators/runtime';
import {gannPriceAt} from '../src/lib/analysis/gann';
import {detectMarketStructure} from '../src/lib/analysis/structure';

const minute=60_000,epoch=Date.UTC(2026,0,1),at=(i:number)=>epoch+i*minute;
const candle=(i:number,price=100):BarInput=>({time:at(i),open:price-.2,high:price+.4,low:price-.4,close:price,volume:100});
function store(bars:BarInput[]){const s=new ColumnStore(bars.length+16);bars.forEach(b=>s.appendBar(b));return s;}
const closed=(s:ColumnStore,n=s.length):ColumnView=>({length:s.length,closedLength:n,intervalMs:minute,col:k=>s.col(k)});
const observations=(series:DerivedSeries[])=>series.flatMap(s=>s.observations??[]);
function runtime(){const registry=new IndicatorRegistry();registerBuiltins(registry);return new IndicatorRuntime(registry);}
const req=(id:string,params:ParamValues={}):IndicatorReq=>({id,instanceId:`${id}:test`,params});
const window=(request:IndicatorReq,from:number,to:number)=>({...request,patternWindow:{fromTime:at(from),toTime:at(to)}});
function fvgBars(length=120,fill=90){
  const bars=Array.from({length},(_,i)=>candle(i,i<30?100:110));
  bars[29]={...candle(29,105),open:100,low:99.8,high:105.4};
  bars[30]={...candle(30,111),open:110,low:109,high:111.4};
  if(fill<length)bars[fill]={...candle(fill,100),low:99};return bars;
}
function wyckoffBars(){
  const anchors=[[0,145],[8,140],[16,130],[28,100],[38,114],[48,101],[58,112],[68,102],[78,104],[83,108],[87,101],[94,119],[99,123],[105,116],[114,129],[120,132]];
  const bars:BarInput[]=[];let leg=0;
  for(let i=0;i<=120;i++){while(leg<anchors.length-2&&i>anchors[leg+1][0])leg++;const a=anchors[leg],b=anchors[leg+1],price=a[1]+(b[1]-a[1])*(i-a[0])/(b[0]-a[0]);bars.push({...candle(i,price),open:price-.3,high:price+.3,low:price-1});}
  bars[28]={...bars[28],high:103,low:97,volume:450};bars[78]={...bars[78],low:95,close:100,open:101,high:105,volume:90};bars[87].volume=55;bars[93].volume=250;return bars;
}

describe('analysis evidence clock is independent of viewport zoom',()=>{
  it('does not resurrect a known filled FVG when its invalidation is outside the viewport',()=>{
    const s=store(fvgBars()),r=runtime(),request=req('analysis-zones',{family:'FVG',lookback:100});
    r.set([request]);const first=r.compute(closed(s),0)[0],match=first.observations!.find(o=>o.time===at(30))!;
    expect(match.state).toBe('invalidated');expect(match.invalidatedAt).toBe(at(91));
    const geometry=first.observations,values=first.values;
    for(const [from,to] of [[20,31],[27,30],[10,70],[0,119],[30,30]]){
      r.set([window(request,from,to)]);const next=r.compute(closed(s),s.length,true)[0];
      expect(next.observations).toBe(geometry);expect(next.values).toBe(values);
      expect(next.patternScan?.throughTime).toBe(at(119));
    }
  });

  it('keeps Wyckoff events and phase at the real known close while zooming before Spring/SOS',()=>{
    const s=store(wyckoffBars()),r=runtime(),request=req('analysis-wyckoff',{pivotStrength:2,minRangeBars:12,maxRangeBars:240});
    r.set([request]);const initial=r.compute(closed(s),0)[0].observations!;
    const phase=initial.find(o=>o.direction==='bullish')!;
    expect(phase.events.some(e=>e.kind==='SPRING')).toBe(true);expect(phase.events.some(e=>e.kind==='SOS')).toBe(true);
    r.set([window(request,25,55)]);expect(r.compute(closed(s),s.length,true)[0].observations).toBe(initial);
    // A real replay explicitly rewinds evidence instead of pretending that
    // hiding later candles changed what the live chart already knows.
    const replay=observations(r.compute(closed(s,56),0));
    expect(replay.flatMap(o=>o.events).some(e=>e.kind==='SPRING'||e.kind==='SOS')).toBe(false);
    expect(replay.every(o=>o.events.every(e=>e.availableAt<=at(56)))).toBe(true);
    const restored=observations(r.compute(closed(s),56));expect(restored).toEqual(initial);
  });

  it('does not erase an OB revisit or later failure when the visible window ends at its activation',()=>{
    const closes=[100,102,104,102,100,102,103,102,100,102,104,102,100,102,104,102,100,102,104,102,101,103,105,108,110,108,106,104,106,114,115,113,107,106,105];
    const bars=closes.map((price,i)=>candle(i,price));
    bars[28]={...bars[28],open:107,high:107.2,low:105.8,close:106};bars[29]={...bars[29],open:106,low:105.8,high:114.2,close:114};
    bars[30]={...bars[30],open:114,high:115.2,low:113.5,close:115};bars[32]={...bars[32],open:108,high:108.2,low:106.6,close:107};
    bars[33]={...bars[33],open:107,high:107.2,low:105.9,close:106};bars[34]={...bars[34],open:106,high:106.2,low:104.8,close:105};
    const s=store(bars),r=runtime(),request=req('analysis-order-blocks',{pivotStrength:2,breakoutAtr:0,displacementAtr:1});
    r.set([request]);const first=r.compute(closed(s),0)[0].observations!,block=first.find(o=>o.time===at(28))!;
    expect(block.state).toBe('invalidated');expect(block.events.map(e=>e.kind)).toEqual(expect.arrayContaining(['activation','revisit','mitigation','invalidation']));
    r.set([window(request,25,29)]);expect(r.compute(closed(s),s.length,true)[0].observations).toBe(first);
  });

  it('publishes a swing on its final confirmation close for both full-closed and same-prefix forming representations',()=>{
    const prices=[100,101,103,101,100,102,104,102,100,101,103,101,100,102,105,102,101];
    const s=store(prices.map((price,i)=>candle(i,price))),params={pivotStrength:2,showSwings:true,breakoutAtr:0};
    const allClosed=detectMarketStructure(closed(s),params),latest=allClosed.find(o=>o.time===at(14)&&o.name==='HH');
    expect(latest).toBeDefined();expect(latest!.availableAt).toBe(at(17));
    expect(detectMarketStructure(closed(s,16),params).some(o=>o.time===at(14)&&o.name==='HH')).toBe(false);
    s.appendBar({...candle(17,1000),low:1});
    expect(detectMarketStructure(closed(s,17),params)).toEqual(allClosed);
    expect(allClosed.every(o=>o.availableAt<=at(17))).toBe(true);
  });

  it('retains the current Hurst trailing fit rather than fitting whatever history happens to be visible',()=>{
    const s=store(Array.from({length:480},(_,i)=>candle(i,100+3*Math.sin(i*Math.PI*2/40)))),r=runtime();
    const request=req('analysis-hurst',{windowBars:240,minPeriod:10,maxPeriod:80,minFit:.1});
    r.set([request]);const models=r.compute(closed(s),0)[0].observations!;
    expect(models.length).toBeGreaterThan(0);expect(models[0].name).toContain('40 柱');expect(models[0].availableAt).toBe(at(480));
    for(const [from,to] of [[0,100],[160,200],[450,479]]){r.set([window(request,from,to)]);expect(r.compute(closed(s),s.length,true)[0].observations).toBe(models);}
    const replay=observations(r.compute(closed(s,240),0));expect(replay[0].availableAt).toBe(at(240));expect(replay[0].time).toBe(at(239));
  });

  it('does not lose an explicit old Gann anchor when zooming or silently change the price/time unit',()=>{
    const s=store(Array.from({length:12000},(_,i)=>candle(i,100+Math.sin(i/7)))),r=runtime();
    const request=req('analysis-gann',{anchorTime:at(20),anchorPrice:100,priceUnit:.001,timeUnitBars:2,direction:'up'});
    r.set([window(request,10,40)]);const first=r.compute(closed(s),0)[0],model=first.observations![0];
    expect(model).toBeDefined();expect(model.points[0]).toEqual({label:'手动锚点',time:at(20),value:100});
    expect(model.availableAt).toBe(at(12000));expect(model.dataWarning).toContain('缺口');
    expect(first.patternScan?.knowledgeThroughTime).toBe(at(12000));expect(first.patternScan?.evidenceRanges).toHaveLength(2);expect(first.patternScan?.scanTruncated).toBe(true);
    const point=model.lines!.find(l=>l.label?.includes('1×1'))!.points.at(-1)!;
    expect(point.value).toBeCloseTo(gannPriceAt(point.time,at(20),100,.001,minute*2));
    r.set([window(request,11900,11999)]);expect(r.compute(closed(s),s.length,true)[0].observations).toBe(first.observations);
    expect(observations(r.compute(closed(s,20),0))).toEqual([]);
  });

  it('recomputes corrections, removes revoked evidence, and does not resurrect it from a cached viewport',()=>{
    const bars=Array.from({length:80},(_,i)=>candle(i)),s=store(bars),r=runtime(),request=req('analysis-candles',{family:'Doji'});
    s.col('close')[30]=s.col('open')[30]+.01;r.set([window(request,25,35)]);
    const prior=r.compute(closed(s),0)[0].observations!;expect(prior.some(o=>o.time===at(30))).toBe(true);
    s.col('close')[30]=100;
    expect(observations(r.compute(closed(s),30)).some(o=>o.time===at(30))).toBe(false);
    r.set([window(request,0,50)]);expect(observations(r.compute(closed(s),s.length,true)).some(o=>o.time===at(30))).toBe(false);
    expect(prior.some(o=>o.time===at(30))).toBe(true);
    // Prepending changes the evidence origin/buffer and invalidates every tile.
    const prepended=store([...Array.from({length:30},(_,i)=>({...candle(i),time:at(i-30)})),...bars]);
    const actual=observations(r.compute(closed(prepended),0)),fresh=runtime();fresh.set([request]);
    expect(actual).toEqual(observations(fresh.compute(closed(prepended),0)));
  });

  it('keeps quote-only geometry by identity but applies a newly closed invalidation immediately',()=>{
    const s=store(fvgBars(91)),r=runtime(),request=req('analysis-zones',{family:'FVG'});r.set([window(request,20,35)]);
    const initial=r.compute(closed(s,90),0)[0].observations!;
    expect(initial.find(o=>o.time===at(30))?.state).toBe('confirmed');
    s.col('high')[90]=130;
    expect(r.compute(closed(s,90),90)[0].observations).toBe(initial);
    const done=observations(r.compute(closed(s,91),90));expect(done.find(o=>o.time===at(30))?.state).toBe('invalidated');
    expect(done.find(o=>o.time===at(30))?.invalidatedAt).toBe(at(91));
  });

  it('keeps higher-timeframe source evidence stable on zoom and never consumes an unfinished bucket',()=>{
    const source=Array.from({length:25},(_,i)=>({...candle(i),time:at(i*5)}));
    source[22]={...source[22],open:100,close:100.01,high:102,low:98};source[24]={...source[24],open:100,close:100.01,high:102,low:98};
    const bars:BarInput[]=[];for(let i=0;i<source.length;i++)for(let j=0;j<(i===24?1:5);j++)bars.push({...source[i],time:at(i*5+j),volume:20});
    const s=store(bars),r=runtime(),request={...req('analysis-candles',{family:'Doji'}),timeframe:'5m',baseIntervalMs:minute};
    r.set([window(request,0,40)]);const first=r.compute(closed(s,s.length-1),0)[0].observations!;
    expect(first.some(o=>o.time===at(110)&&o.availableAt===at(115))).toBe(true);expect(first.some(o=>o.time===at(120))).toBe(false);
    r.set([window(request,108,112)]);expect(r.compute(closed(s,s.length-1),s.length,true)[0].observations).toBe(first);
    for(let j=1;j<5;j++)s.appendBar({...source[24],time:at(120+j),volume:20});
    const next=observations(r.compute(closed(s),s.length-5));expect(next.some(o=>o.time===at(120)&&o.availableAt===at(125))).toBe(true);
    expect(next.every(o=>o.availableAt<=at(125)&&o.events.every(e=>e.availableAt<=at(125)))).toBe(true);
  });

  it('checks an old tile FVG through actual known history, then retracts that invalidation after a real correction',()=>{
    const s=store(fvgBars(12000,11500)),r=runtime(),request=req('analysis-zones',{family:'FVG'});r.set([window(request,20,35)]);
    const initial=r.compute(closed(s),0)[0],match=initial.observations!.find(o=>o.time===at(30))!;
    expect(match).toBeDefined();expect(match.state).toBe('invalidated');expect(match.invalidatedAt).toBe(at(11501));
    r.set([window(request,29,30)]);expect(r.compute(closed(s),s.length,true)[0].observations).toBe(initial.observations);
    // A known region crosses distant tile boundaries. Its retained source
    // record must still be re-evaluated, not kept forever as its old state.
    r.set([window(request,10800,11950)]);
    expect(observations(r.compute(closed(s),s.length,true)).find(o=>o.id===match.id)?.state).toBe('invalidated');
    const corrected=candle(11500,110);for(const key of ['open','high','low','close'] as const)s.col(key)[11500]=corrected[key];
    const updated=observations(r.compute(closed(s),11500)).find(o=>o.id===match.id)!;
    expect(updated.state).toBe('confirmed');expect(updated.invalidatedAt).toBeUndefined();expect(updated.throughTime).toBe(at(12000));
    expect(match.state).toBe('invalidated');
    // Revoke the formation itself. The source tile is dirty and cannot be
    // resurrected from the finite history archive while looking elsewhere.
    s.col('low')[30]=99;s.col('open')[30]=100;
    expect(observations(r.compute(closed(s),30)).some(o=>o.id===match.id)).toBe(false);
  });

  it('preserves a post-formation data gap instead of using later closes to invent zone validity',()=>{
    const s=store(fvgBars(12000,11500));for(let i=5000;i<s.length;i++)s.col('time')[i]+=minute;
    const r=runtime();r.set([window(req('analysis-zones',{family:'FVG'}),20,35)]);
    const match=observations(r.compute(closed(s),0)).find(o=>o.time===at(30))!;
    expect(match.state).toBe('confirmed');expect(match.invalidatedAt).toBeUndefined();
    expect(match.dataWarning).toContain('缺口');expect(match.throughTime).toBe(at(5000));
  });
});
