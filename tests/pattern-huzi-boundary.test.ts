import {describe,expect,it} from 'vitest';
import {boundaryAt,boundaryEnvelopes,classifyBoundaries,type BoundaryContext} from '../src/lib/patterns/huzi-boundary';
import {confirmedPivotEvents,type Pivot} from '../src/lib/patterns/pivots';
import {detectHuzi,trendContext} from '../src/lib/patterns/huzi';
import {detectHuziCandidates} from '../src/lib/patterns/huzi-candidates';
import {plant,STEP_MS,withApproach,type PlantedKind} from './fixtures/huzi-synthetic';

const line=(slope:number,at0:number)=>({slope,intercept:at0});
/** A symmetrical triangle drawn through exact touches: highs on the upper line, lows on the lower, with optional wiggles inside. */
function triangleBars(wiggles:Array<{at:number;depth:number}>=[],length=110){
  const upper=(i:number)=>110-.08*i,lower=(i:number)=>90+.08*i;
  const touches:Array<[number,number,'high'|'low']>=[[10,upper(10),'high'],[30,lower(30),'low'],[50,upper(50),'high'],[70,lower(70),'low'],[90,upper(90),'high']];
  const close=new Float64Array(length),high=new Float64Array(length),low=new Float64Array(length),open=new Float64Array(length),time=new Float64Array(length),volume=new Float64Array(length).fill(100);
  for(let i=0;i<length;i++){
    let value:number;
    if(i<=touches[0][0])value=upper(i)-(touches[0][0]-i)*.9;// approach
    else if(i>=touches.at(-1)![0])value=upper(i)-.8-Math.min(i-touches.at(-1)![0],6)*.4+(i>touches.at(-1)![0]+7?(i-touches.at(-1)![0]-7)*1.1:0);
    else{const k=touches.findIndex((t,j)=>i>=t[0]&&i<=touches[j+1][0]);const [a,b]=[touches[k],touches[k+1]];value=a[1]+(b[1]-a[1])*(i-a[0])/(b[0]-a[0]);}
    const wiggle=wiggles.find(w=>Math.abs(w.at-i)<=3);if(wiggle)value-=wiggle.depth*(1-Math.abs(wiggle.at-i)/4);
    close[i]=value;time[i]=i*STEP_MS;
  }
  // A touch is a wick that reaches the boundary; its body and its neighbours stay clearly inside.
  for(const [i,v,kind] of touches)close[i]=kind==='high'?v-.8:v+.8;
  for(let i=0;i<length;i++){open[i]=i?close[i-1]:close[0];high[i]=Math.max(open[i],close[i])+.02;low[i]=Math.min(open[i],close[i])-.02;}
  for(const [i,v,kind] of touches){if(kind==='high')high[i]=v;else low[i]=v;}
  return {open,high,low,close,time,volume,length,upper,lower};
}
const colsOf=(bars:ReturnType<typeof triangleBars>)=>({length:bars.length,col:(name:string)=>(bars as never as Record<string,Float64Array>)[name]}) as never;
function context(bars:ReturnType<typeof triangleBars>,radius:number,end:Pivot,events:Pivot[],extra:Partial<BoundaryContext>={}):BoundaryContext {
  void end;void events;
  return {open:bars.open,high:bars.high,low:bars.low,close:bars.close,horizon:bars.length-2,tolerance:.04,radius,minTouches:5,minSpan:18,maxSpan:200,...extra};
}
function search(bars:ReturnType<typeof triangleBars>,radius:number,extra:Partial<BoundaryContext>={}){
  const events=confirmedPivotEvents(colsOf(bars),radius,1500,120),highs:Pivot[]=[],lows:Pivot[]=[],found=[];
  for(const event of events){
    (event.kind==='high'?highs:lows).push(event);
    found.push(...boundaryEnvelopes(highs,lows,event,context(bars,radius,event,events,{horizon:Math.min(bars.length-2,event.index+radius),...extra})));
  }
  return found;
}

describe('boundary classification',()=>{
  const h=20,first=0,last=100;
  it('names converging shapes by which side is flat, with no dead zone between "flat" and "steep"',()=>{
    const up=line(0,110),down=(slopeTotal:number)=>line(slopeTotal/last,90);
    expect(classifyBoundaries(up,down(.15*h),first,last,h,.04)?.name).toBe('上升三角形');
    expect(classifyBoundaries(up,down(.4*h),first,last,h,.04)?.name).toBe('上升三角形');
    expect(classifyBoundaries(up,down(.09*h),first,last,h,.04)?.name).toBe('水平通道');// too little convergence to be a triangle
    expect(classifyBoundaries(line(-.4*h/last,110),line(0,90),first,last,h,.04)?.name).toBe('下降三角形');
    expect(classifyBoundaries(line(-.3*h/last,110),line(.3*h/last,90),first,last,h,.04)?.name).toBe('对称三角形');
    expect(classifyBoundaries(line(.2*h/last,110),line(.9*h/last,90),first,last,h,.04)?.name).toBe('上升楔形');
    expect(classifyBoundaries(line(-.9*h/last,110),line(-.2*h/last,90),first,last,h,.04)?.name).toBe('下降楔形');
  });
  it('separates parallel channels from wedges and rejects crossed, exploding or unstructured shapes',()=>{
    expect(classifyBoundaries(line(.3*h/last,110),line(.3*h/last,90),first,last,h,.04)?.name).toBe('上升通道');
    expect(classifyBoundaries(line(0,110),line(0,90),first,last,h,.04)?.name).toBe('水平通道');
    expect(classifyBoundaries(line(-.3*h/last,110),line(-.3*h/last,90),first,last,h,.04)?.name).toBe('下降通道');
    expect(classifyBoundaries(line(-1.5*h/last,110),line(1.5*h/last,90),first,last,h,.04)).toBeUndefined();// lines cross before the end
    expect(classifyBoundaries(line(.6*h/last,110),line(-.6*h/last,90),first,last,h,.04)).toBeUndefined();// widening
    expect(classifyBoundaries(line(0,110),line(0,110),first,last,h,.04)).toBeUndefined();// zero width
    expect(boundaryAt(line(2,5),3)).toBe(11);
  });
});

describe('boundary search',()=>{
  it('finds a five-touch triangle whose boundaries run through the touches and contain the price',()=>{
    const bars=triangleBars(),found=search(bars,3);
    const triangle=found.find(f=>f.name==='对称三角形'&&f.pivots.length===5);
    expect(triangle).toBeDefined();
    expect(triangle!.pivots.map(p=>p.index)).toEqual([10,30,50,70,90]);
    expect(triangle!.upperTouches).toBe(3);expect(triangle!.lowerTouches).toBe(2);
    for(const p of triangle!.pivots){
      const boundary=p.kind==='high'?boundaryAt(triangle!.upper,p.index):boundaryAt(triangle!.lower,p.index);
      expect(Math.abs(boundary-p.value)).toBeLessThan(triangle!.height*.03);
    }
    for(let i=10;i<=90;i++){expect(bars.close[i]).toBeLessThanOrEqual(boundaryAt(triangle!.upper,i)+triangle!.height*.04);expect(bars.close[i]).toBeGreaterThanOrEqual(boundaryAt(triangle!.lower,i)-triangle!.height*.04);}
  });

  it('ignores a shallow wiggle inside a leg instead of letting it break the structure',()=>{
    const bars=triangleBars([{at:40,depth:2.2},{at:60,depth:2}]);
    const wiggly=search(bars,3).find(f=>f.name==='对称三角形'&&f.pivots.length===5);
    expect(wiggly).toBeDefined();
    expect(wiggly!.pivots.map(p=>p.index)).toEqual([10,30,50,70,90]);
  });

  it('needs enough separate touches, sensible span, simultaneous boundaries and price inside the lines',()=>{
    const bars=triangleBars();
    // The tail dips back to the lower line once more, so a sixth touch exists; a seventh does not.
    expect(search(bars,3,{minTouches:6}).map(f=>f.pivots.map(p=>p.index))).toEqual([[10,30,50,70,90,98]]);
    expect(search(bars,3,{minTouches:7})).toHaveLength(0);
    expect(search(bars,3,{minSpan:150})).toHaveLength(0);
    expect(search(bars,3,{maxSpan:30}).every(f=>f.pivots.at(-1)!.index-f.pivots[0].index<=30)).toBe(true);
    // The price leaves the structure: no envelope may claim it once a close is far outside its lines.
    const broken=triangleBars();broken.close[55]+=9;broken.high[55]+=9;
    expect(search(broken,3).some(f=>f.pivots.some(p=>p.index===50)&&f.pivots.some(p=>p.index===70)&&f.pivots.length===5)).toBe(false);
  });

  it('never reads bars beyond its horizon',()=>{
    const bars=triangleBars(),radius=3;
    const events=confirmedPivotEvents(colsOf(bars),radius,1500,120),end=events.find(e=>e.index===90)!;
    const highs=events.filter(e=>e.kind==='high'&&e.index<=end.index),lows=events.filter(e=>e.kind==='low'&&e.index<=end.index);
    const horizon=end.index+radius,base=boundaryEnvelopes(highs,lows,end,context(bars,radius,end,events,{horizon}));
    const future=triangleBars();
    for(let i=horizon+1;i<future.length;i++){future.high[i]=999;future.low[i]=-999;future.close[i]=(i%2?1:-1)*500;}
    const other=boundaryEnvelopes(highs,lows,end,context(future,radius,end,events,{horizon}));
    expect(other.map(f=>f.pivots.map(p=>p.index))).toEqual(base.map(f=>f.pivots.map(p=>p.index)));
    expect(base.length).toBeGreaterThan(0);
  });
});

function detect(t:ReturnType<typeof plant>,extra:Record<string,unknown>={},cut=t.breakout+6){
  const rows=t.bars.slice(0,cut),n=rows.length,c:Record<string,Float64Array>={};
  ['time','open','high','low','close','volume'].forEach((name,j)=>{c[name]=Float64Array.from(rows.map(r=>r[j]));});
  return detectHuzi({length:n,closedLength:n-1,intervalMs:STEP_MS,col:(x:string)=>c[x]} as never,{pivotStrength:3,lookback:1500,tolerance:.04,maxPatterns:1000,showInvalidated:true,minStructureBars:0,...extra});
}

describe('trend context (continuation vs reversal)',()=>{
  it('compares the approach with the breakout using only candles before the first touch',()=>{
    const close=Float64Array.from({length:120},(_,i)=>i<60?100+i:160);
    expect(trendContext(close,60,40,10,'bullish')).toMatchObject({kind:'continuation',approach:'bullish'});
    expect(trendContext(close,60,40,10,'bearish')).toMatchObject({kind:'reversal',approach:'bullish'});
    const down=Float64Array.from({length:120},(_,i)=>i<60?160-i:100);
    expect(trendContext(down,60,40,10,'bullish')?.kind).toBe('reversal');
    expect(trendContext(down,60,40,10,'bearish')?.kind).toBe('continuation');
    // Too small an approach, too little history, or no height: no call is made.
    expect(trendContext(new Float64Array(120).fill(100),60,40,10,'bullish')).toBeUndefined();
    expect(trendContext(close,5,40,10,'bullish')).toBeUndefined();
    expect(trendContext(close,60,40,0,'bullish')).toBeUndefined();
    // Later candles cannot change the call.
    const later=Float64Array.from(close);later.fill(1,61);
    expect(trendContext(later,60,40,10,'bullish')).toEqual(trendContext(close,60,40,10,'bullish'));
  });

  const tagged=(kind:PlantedKind,approach:'up'|'down',breakout:'up'|'down',name:string)=>{
    const out:Array<NonNullable<ReturnType<typeof detect>[number]['context']>&{direction:string}>=[];
    for(let seed=1;seed<=14;seed++){
      const t=withApproach(kind,seed,approach,breakout);
      for(const m of detect(t))if(m.name===name&&m.context&&Math.abs(Math.round(m.points[0].time/STEP_MS)-t.first)<=30&&Math.abs(Math.round(m.points.at(-1)!.time/STEP_MS)-t.last)<=30)out.push({...m.context,direction:m.direction});
    }
    return out;
  };

  it('tags a rising wedge as reversal after an advance and continuation after a decline (same geometry)',()=>{
    const afterAdvance=tagged('rising-wedge','up','down','上升楔形'),afterDecline=tagged('rising-wedge','down','down','上升楔形');
    expect(afterAdvance.length).toBeGreaterThanOrEqual(2);expect(afterDecline.length).toBeGreaterThanOrEqual(2);
    for(const item of afterAdvance){expect(item.direction).toBe('bearish');expect(item.kind).toBe('reversal');}
    for(const item of afterDecline){expect(item.direction).toBe('bearish');expect(item.kind).toBe('continuation');}
    const sample=detect(withApproach('rising-wedge',3,'up','down')).find(m=>m.name==='上升楔形'&&m.context);
    if(sample){expect(sample.description).toContain('判为反转');expect(sample.ratios.some(r=>r.label==='先行走势 / 结构高度')).toBe(true);}
  });

  it('tags a symmetrical triangle by whether it breaks with or against the approach',()=>{
    const withTrend=tagged('sym-triangle','up','up','对称三角形'),against=tagged('sym-triangle','up','down','对称三角形');
    expect(withTrend.length).toBeGreaterThanOrEqual(2);expect(against.length).toBeGreaterThanOrEqual(2);
    for(const item of withTrend){expect(item.direction).toBe('bullish');expect(item.kind).toBe('continuation');}
    for(const item of against){expect(item.direction).toBe('bearish');expect(item.kind).toBe('reversal');}
  });
});

describe('scale controls',()=>{
  it('minStructureBars hides structures shorter than the given span and keeps longer ones',()=>{
    const t=plant({kind:'sym-triangle',length:150,seed:12,noise:.3});
    const all=detect(t,{minStructureBars:0}).filter(m=>m.family==='huzi-triangle');
    const big=detect(t,{minStructureBars:100}).filter(m=>m.family==='huzi-triangle');
    expect(all.length).toBeGreaterThan(big.length);
    const bars=(m:{points:Array<{time:number}>})=>(m.points.at(-1)!.time-m.points[0].time)/STEP_MS;
    expect(all.some(m=>bars(m)<100)).toBe(true);
    expect(big.every(m=>bars(m)>=100)).toBe(true);
    expect(big.length).toBeGreaterThan(0);
  });

  it('boundary search and large scales never lose recall on big structures compared with the zig-zag ladder alone',()=>{
    let withBoth=0,legacy=0;
    for(const seed of [1,2,3,4,5,6,7,8,9,10,11,12]){
      const t=plant({kind:'asc-triangle',length:300,seed:seed*31,noise:.5});
      const hit=(extra:Record<string,unknown>)=>detect(t,{minStructureBars:200,...extra}).some(m=>m.family==='huzi-triangle'&&m.direction===t.direction&&Math.abs(Math.round(m.points[0].time/STEP_MS)-t.first)<=70&&Math.abs(Math.round(m.points.at(-1)!.time/STEP_MS)-t.last)<=70);
      if(hit({}))withBoth++;
      if(hit({boundarySearch:false,largeScales:false}))legacy++;
    }
    expect(withBoth).toBeGreaterThanOrEqual(legacy);
    expect(withBoth).toBeGreaterThanOrEqual(5);
  });

  it('is deterministic and causal: a later, unrelated tail never moves an already published structure',()=>{
    const t=plant({kind:'sym-triangle',length:120,seed:9,noise:.4});
    const first=detect(t,{},t.breakout+6).filter(m=>m.family==='huzi-triangle');
    expect(first.length).toBeGreaterThan(0);
    const again=detect(t,{},t.breakout+6).filter(m=>m.family==='huzi-triangle');
    expect(again.map(m=>m.id)).toEqual(first.map(m=>m.id));
    const later=detect(t,{},t.bars.length);
    for(const match of first){
      const same=later.find(m=>m.id===match.id);
      if(same)expect(same.confirmedAt).toBe(match.confirmedAt);
    }
  });
});

describe('forming structures from boundary search',()=>{
  function candidatesAt(t:ReturnType<typeof plant>,cut:number,extra:Record<string,unknown>={}){
    const rows=t.bars.slice(0,cut),n=rows.length,c:Record<string,Float64Array>={};
    ['time','open','high','low','close','volume'].forEach((name,j)=>{c[name]=Float64Array.from(rows.map(r=>r[j]));});
    return detectHuziCandidates({length:n,closedLength:n-1,intervalMs:STEP_MS,col:(x:string)=>c[x]} as never,{pivotStrength:3,lookback:600,tolerance:.04,maxCandidates:4,...extra},[]);
  }
  it('shows a large unbroken framework as observing (neutral, no signal) and hides it once minStructureBars exceeds it',()=>{
    let seen=0;
    for(const seed of [2,3,4,5,6,7,8]){
      const t=plant({kind:'sym-triangle',length:140,seed:seed*13,noise:.3});
      const list=candidatesAt(t,t.last+3,{minStructureBars:60});
      const found=list.find(c=>c.family==='huzi-triangle'&&Math.abs(Math.round(c.points[0].time/STEP_MS)-t.first)<=35);
      if(!found)continue;
      seen++;
      expect(found.direction).toBe('neutral');
      expect(found.description).toContain('未确认突破');
      expect(found.points.length).toBeGreaterThanOrEqual(4);
      expect(candidatesAt(t,t.last+3,{minStructureBars:400}).some(c=>c.id===found.id)).toBe(false);
    }
    expect(seen).toBeGreaterThanOrEqual(3);
  });
  it('turns off with boundarySearch=false',()=>{
    const t=plant({kind:'sym-triangle',length:140,seed:26,noise:.3});
    const withSearch=candidatesAt(t,t.last+3,{minStructureBars:60}).filter(c=>c.description.includes('贴边触点'));
    const without=candidatesAt(t,t.last+3,{minStructureBars:60,boundarySearch:false}).filter(c=>c.description.includes('贴边触点'));
    expect(without).toHaveLength(0);
    expect(withSearch.length).toBeGreaterThanOrEqual(0);
  });
});

describe('planted-structure recall guard',()=>{
  it('recognizes most clean planted structures across kinds and scales (deterministic seeds)',()=>{
    const kinds:PlantedKind[]=['sym-triangle','asc-triangle','desc-triangle','rising-wedge','falling-wedge'];
    let n=0,hit=0;
    for(const kind of kinds)for(const length of [80,160])for(let seed=1;seed<=8;seed++){
      const t=plant({kind,length,seed:seed*7919+length,noise:.3});n++;
      const family=kind.includes('triangle')?'huzi-triangle':'huzi-wedge';
      if(detect(t,{},t.breakout+6).some(m=>m.family===family&&m.direction===t.direction&&Math.abs(Math.round(m.points[0].time/STEP_MS)-t.first)<=.22*length&&Math.abs(Math.round(m.points.at(-1)!.time/STEP_MS)-t.last)<=.22*length))hit++;
    }
    expect(hit/n).toBeGreaterThanOrEqual(.6);
  });
});
