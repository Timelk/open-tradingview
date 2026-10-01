import {describe,expect,it} from 'vitest';
import {HistoryQueryGate,advanceHistoryCursor,aggregateAtCursor,applyHistoryQuery,footprintPage,visibleHistory} from '../src/lib/flow/history-view';
import type {DepthHeatmap,HistoricalFlowAggregate,ReplaySnapshot} from '../src/lib/flow/persistence-client';
const draft={datasetId:'recording-1',from:1_000,to:11_000,tickSize:.01,timeframeMs:60_000,priceStepTicks:10,tpoBlockMs:1_800_000};
const scope=applyHistoryQuery(draft);
const aggregate=(to:number)=>({datasetId:scope.datasetId,fromTime:scope.from,toTime:to,snapshot:{totals:{volumeBase:99},footprint:[{time:0,endTime:60_000,volumeBase:99}]}} as HistoricalFlowAggregate);
const heatmap:DepthHeatmap={datasetId:scope.datasetId,fromTime:scope.from,toTime:scope.to,note:'recorded',samples:[1000,5000,10000].map(time=>({time,book:{status:'available',time,bids:[{price:100,quantity:1}],asks:[]}}))};

describe('historical flow replay boundaries',()=>{
  it('hides the entire future aggregate, including totals, until a prefix result arrives',()=>{
    expect(visibleHistory(scope,5000,{data:aggregate(11000)}).data).toBeUndefined();
    expect(visibleHistory(scope,5000,{balance:aggregate(11000)}).balance).toBeUndefined();
    const prefix=aggregate(5000),visible=visibleHistory(scope,5000,{data:prefix});
    expect(visible.data).toBe(prefix);
    // A partial time bucket can end after the cursor; its queried trades do not.
    expect(visible.data!.snapshot.footprint[0].endTime).toBeGreaterThan(5000);
  });
  it('uses the same cursor-limited payload for rendering and export, including cached heatmaps',()=>{
    const futureFrame={datasetId:scope.datasetId,at:10000,book:{status:'available',time:10000},trades:[]} as unknown as ReplaySnapshot;
    const result=visibleHistory(scope,5000,{frame:futureFrame,heatmap});
    expect(result.frame).toBeUndefined();
    expect(result.heatmap!.samples.map(sample=>sample.time)).toEqual([1000,5000]);
    expect(result.heatmap!.toTime).toBe(5000);
    expect(JSON.parse(JSON.stringify(result)).heatmap.samples).toHaveLength(2);
    expect(heatmap.samples).toHaveLength(3);
    const corrupt={...heatmap,samples:[{...heatmap.samples[0],book:{...heatmap.samples[0].book,time:5000}}]};
    expect(visibleHistory(scope,1000,{heatmap:corrupt}).heatmap!.samples[0].book.status).toBe('unavailable');
  });
  it('freezes applied settings and queries exactly the starting cursor rather than one millisecond ahead',()=>{
    const edit={...draft},applied=applyHistoryQuery(edit);edit.from=8000;edit.tickSize=1;
    expect(aggregateAtCursor(applied,1000)).toMatchObject({from:1000,to:1000,tickSize:.01});
    expect(aggregateAtCursor(applied,0).to).toBe(1000);
    expect(aggregateAtCursor(applied,20000).to).toBe(11000);
    expect(()=>applyHistoryQuery({...edit,to:1000})).toThrow();
    expect(applied.from).toBe(1000);
  });
  it('advances by elapsed wall time at the selected speed without a doubled 1x clock',()=>{
    let cursor=1000;for(let i=0;i<4;i++)cursor=advanceHistoryCursor(cursor,250,1,11000);
    expect(cursor).toBe(2000);expect(advanceHistoryCursor(cursor,500,5,11000)).toBe(4500);
    expect(advanceHistoryCursor(cursor,5000,5,11000)).toBe(11000);
  });
  it('keeps the shortened footprint visible when seek replaces a long, previously paged result',()=>{
    const older=footprintPage(240,200,6);expect(older).toEqual({offset:200,start:34,end:40});
    const small=[{time:1000}],page=footprintPage(small.length,older.offset,6);
    expect(small.slice(page.start,page.end)).toEqual(small);expect(page.offset).toBe(0);
    expect(footprintPage(0,200,6)).toEqual({offset:0,start:0,end:0});
  });
});

describe('independent historical query channels',()=>{
  it('rejects a late future result immediately on scrub while leaving initial heatmap in flight',async()=>{
    const gate=new HistoryQueryGate(),future=gate.begin('data','end')!,book=gate.begin('frame','end')!,heat=gate.begin('heatmap','range')!;
    let resolve!:(v:number)=>void,shown=0;
    const pending=new Promise<number>(r=>resolve=r).then(value=>{if(gate.current(future))shown=value;gate.finish(future);});
    gate.cancel('data','frame'); // Happens on input, before a debounce timer sends the next request.
    expect(book.signal.aborted).toBe(true);expect(gate.current(heat)).toBe(true);
    resolve(11_000);await pending;expect(shown).toBe(0);
    const prefix=gate.begin('data','cursor')!;expect(gate.current(prefix)).toBe(true);
    expect(gate.begin('heatmap','range')).toBeUndefined();expect(gate.current(heat)).toBe(true);
  });
  it('ignores stale completion after reapplying the range, and cannot clear its replacement request',()=>{
    const gate=new HistoryQueryGate(),old=gate.begin('data','rangeA')!,next=gate.begin('data','rangeB')!;
    gate.finish(old);expect(old.signal.aborted).toBe(true);expect(gate.current(next)).toBe(true);
    gate.cancel();expect(gate.current(next)).toBe(false);
  });
});
