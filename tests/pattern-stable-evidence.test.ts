import {describe,expect,it,vi} from 'vitest';
import sol from './fixtures/solusdt-4h-zoom-2026-09.json';
import {ColumnStore} from '../src/lib/core/datastore';
import type {ColumnView,DerivedSeries,ParamValues} from '../src/lib/core/types';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {IndicatorRuntime} from '../src/lib/indicators/runtime';
import {selectPatterns} from '../src/lib/patterns/selection';
import {planEvidenceWindows} from '../src/lib/analysis/evidence-window';
import {ClosedRangeIndex} from '../src/lib/analysis/closed-range-index';
const step=4*3600000,epoch=sol.bars[0][0],at=(i:number)=>epoch+i*step;
const registry=()=>{const reg=new IndicatorRegistry();registerBuiltins(reg);return reg;};
const matches=(out:DerivedSeries[])=>out.flatMap(s=>s.patterns??[]);
const compact=(p:ReturnType<typeof matches>[number])=>({id:p.id,points:p.points,confirmedAt:p.confirmedAt,status:p.status,invalidatedAt:p.invalidatedAt});
function solStore(){const store=new ColumnStore(sol.bars.length);for(const [time,open,high,low,close,volume] of sol.bars)store.appendBar({time,open,high,low,close,volume});return store;}
function view(store:ColumnStore,n=store.length):ColumnView{return {length:n,closedLength:n,intervalMs:step,col:name=>store.col(name)};}
function largeStore(length=22000){const store=new ColumnStore(length+1),anchors=[[0,420],[700,400],[1400,460],[2100,420],[2800,480],[3850,380],[4900,440],[5950,400],[7000,460],[7700,420],[9100,410],[22000,410]];let leg=0;for(let i=0;i<=length;i++){while(leg+1<anchors.length-1&&i>anchors[leg+1][0])leg++;const a=anchors[leg],b=anchors[leg+1],v=a[1]+(b[1]-a[1])*(i-a[0])/(b[0]-a[0]);store.appendBar({time:at(i),open:v,high:v,low:v,close:v,volume:1});}return store;}
const request={id:'pattern-harmonic',instanceId:'probe',baseIntervalMs:step,params:sol.params as ParamValues};
const window=(from:number,to:number)=>({fromTime:at(from),toTime:at(to)});

describe('stable evidence is independent from ordinary zoom',()=>{
  it('keeps the two actual SOL same-D shapes stable over full and 7-bar windows; a failure ~950 bars later no longer judges them',()=>{
    const store=solStore(),runtime=new IndicatorRuntime(registry()),prefix=view(store,730),col=vi.fn(prefix.col);prefix.col=col;
    runtime.set([{...request,patternWindow:window(450,900)}]);const wide=runtime.compute(prefix,0),pair=matches(wide).filter(p=>p.family==='AB=CD'&&p.points.at(-1)!.time===at(694));
    expect(pair).toHaveLength(2);expect(pair.every(p=>p.status==='confirmed')).toBe(true);
    const initial=pair.map(compact),arrays=wide.map(s=>s.patterns);col.mockClear();
    for(const range of [[580,720],[662,698],[690,697],[693,694]]){runtime.set([{...request,patternWindow:window(...range as [number,number])}]);const zoom=runtime.compute(prefix,730,true);expect(matches(zoom).filter(p=>p.points.at(-1)!.time===at(694)).map(compact)).toEqual(initial);expect(zoom.map(s=>s.patterns)).toEqual(arrays);expect(zoom[0].patterns).toBe(arrays[0]);}
    expect(col.mock.calls.length).toBeLessThan(100); // No rescan of the fixed evidence window.
    const current=runtime.compute(view(store),730),now=matches(current).filter(p=>initial.some(past=>past.id===p.id));
    expect(now).toHaveLength(2);expect(now.every(p=>p.status==='confirmed'&&p.invalidatedAt===undefined&&(p.resolution!==undefined||p.observationEndedAt!==undefined))).toBe(true);
    expect(selectPatterns(now,{historyDisplay:'active'},window(580,720))).toHaveLength(2);
    // An explicitly unbounded window still finds the real later failure through the index.
    runtime.set([{...request,params:{...request.params,observationRatio:1e6},patternWindow:window(580,720)}]);
    const unbounded=matches(runtime.compute(view(store),0)).filter(p=>initial.some(past=>past.id===p.id)&&!p.resolution);
    expect(unbounded.every(p=>p.status==='invalidated'&&p.invalidatedAt===at(1645))).toBe(true);
  });
  it('uses the actual closed prefix rather than backing future columns or the display end',()=>{
    const store=solStore(),runtime=new IndicatorRuntime(registry());runtime.set([{...request,patternWindow:window(0,1800)}]);
    const before=matches(runtime.compute(view(store,697),0)).filter(p=>p.points.at(-1)!.time===at(694));expect(before).toHaveLength(0);
    const one=matches(runtime.compute(view(store,698),697)).filter(p=>p.points.at(-1)!.time===at(694));expect(one).toHaveLength(1);
    expect(matches(runtime.compute(view(store,707),698)).filter(p=>p.points.at(-1)!.time===at(694))).toHaveLength(2);
    expect(matches(runtime.compute(view(store,697),0)).filter(p=>p.points.at(-1)!.time===at(694))).toHaveLength(0);
  });
  it('retains a long partially visible structure across fixed tiles and judges its lifecycle beyond every recognition tile',()=>{
    const store=largeStore(),runtime=new IndicatorRuntime(registry()),params:ParamValues={family:'AB=CD',pivotStrength:2,multiScale:false,structuralSwings:false,lookback:1500};
    const run=(a:number,b:number,from:number)=>{runtime.set([{...request,params,patternWindow:window(a,b)}]);return runtime.compute(view(store),from,true);};
    const first=run(0,8500,0),match=matches(first).find(p=>p.points.at(-1)!.time===at(7000))!;expect(match).toBeDefined();expect(match.status).toBe('confirmed');
    expect(compact(matches(run(6750,7030,store.length)).find(p=>p.id===match.id)!)).toEqual(compact(match));
    expect(compact(matches(run(7000,7007,store.length)).find(p=>p.id===match.id)!)).toEqual(compact(match));
    for(const name of ['open','high','low','close'] as const)store.col(name)[16000]=600;
    // 9,000 bars after confirmation is far outside the default observation window.
    expect(matches(run(6750,7030,16000)).find(p=>p.id===match.id)?.invalidatedAt).toBeUndefined();
    // Unbounded, the index still reaches past every tile: the reference target
    // (about 650 bars later) completes the structure before the remote spike.
    params.observationRatio=1e6;
    const completed=matches(run(6750,7030,16000)).find(p=>p.id===match.id)!;
    expect(completed.status).toBe('confirmed');expect(completed.invalidatedAt).toBeUndefined();
    expect(completed.resolution?.time).toBeGreaterThan(at(7030+64));expect(completed.resolution!.time).toBeLessThan(at(16000));
    expect(selectPatterns([completed],{historyDisplay:'active'},window(6750,7030))).toHaveLength(1);
    for(const name of ['open','high','low','close'] as const)store.col(name)[16000]=410;
    expect(matches(run(6750,7030,16000)).find(p=>p.id===match.id)?.status).toBe('confirmed');
  });
  it('bounds tile inputs and cache size and does no raw-history scan on repeated zooms',()=>{
    const store=largeStore(70000),reg=registry(),def=reg.get('pattern-harmonic'),runner=def.createIncremental!({...request.params,structuralSwings:false}),source={...view(store),patternWindow:window(0,70000)};
    const plan=planEvidenceWindows(source,store.length);expect(plan.windows.length).toBe(8);expect(plan.truncated).toBe(true);expect(plan.windows.every(w=>w.end-w.start<=10000)).toBe(true);
    runner.update(source,0);const index=(runner as any).index as ClosedRangeIndex,update=vi.spyOn(index,'update');
    for(let i=0;i<40;i++)runner.update({...source,patternWindow:window(i*1700,i*1700+50)},store.length);
    expect((runner as any).cache.size).toBe(16);expect(update).not.toHaveBeenCalled();
    const last=runner.update({...source,patternWindow:window(7000,7010)},store.length),again=runner.update({...source,patternWindow:window(7001,7008)},store.length);
    expect(again[0].patterns).toBe(last[0].patterns);
  });
});
