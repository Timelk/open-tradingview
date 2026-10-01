import { describe, expect, it, vi } from 'vitest';
import { ChartController, initialState } from '../src/lib/chart/controller';
import { ColumnStore } from '../src/lib/core/datastore';
import { Pyramid } from '../src/lib/core/pyramid';
import { Viewport } from '../src/lib/core/viewport';
import { LiveBarMotion } from '../src/lib/interaction/live-bar-motion';
import { RangeMotion } from '../src/lib/interaction/range-motion';
import { IndicatorRegistry } from '../src/lib/indicators/registry';
import type { BarInput } from '../src/lib/core/types';
import { emptyScene } from '../src/lib/scene/types';

const minute=60_000;
const bar=(i:number,close=100):BarInput=>({time:i*minute,open:100,high:Math.max(110,close),low:Math.min(90,close),close,volume:10});
function deferred(){let resolve!:(bars:BarInput[])=>void,reject!:(error:Error)=>void;const promise=new Promise<BarInput[]>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function harness(length=100){
  const response=deferred(),store=new ColumnStore(128);for(let i=100;i<100+length;i++)store.appendBar(bar(i));
  const registry=new IndicatorRegistry();registry.register({id:'pattern-test',name:'Pattern',category:'pattern',kind:'strategy',target:'main',inputs:[],calc:()=>[]});
  const doc=emptyScene();doc.indicators=[{id:'pattern-test',instanceId:'mounted',params:{lookback:100,pivotStrength:1,multiScale:false},timeframe:'chart',hiddenPlots:[]}];
  const feed={loadBefore:vi.fn(()=>response.promise),disconnect:vi.fn()};
  const engine={init:vi.fn(),pushBar:vi.fn(),destroy:vi.fn(),derived:[]};
  const renderer={resize:vi.fn(),destroy:vi.fn()};
  const controller=Object.assign(Object.create(ChartController.prototype),{
    registry,store,pyramid:new Pyramid(store),viewport:new Viewport(length,{from:length-20,to:length,plotW:800,plotH:500}),
    dead:false,historicalSnapshot:false,generation:1,patternHistoryExhausted:'',feed,engine,renderer,drawing:{document:doc,setInterval:vi.fn(),setMarket:vi.fn()},
    state:{...initialState,source:'binance',symbol:'BTCUSDT',interval:'1m',loading:false,status:'ok',following:false,smoothMotion:false,patternHistoryLoading:false,patternHistoryError:''},
    lastBarConfirmed:false,marketRevision:0,dataRevision:0,tickTimes:[],liveBarMotion:new LiveBarMotion(),viewportMotion:new RangeMotion({min:length-20,max:length}),liveFollowing:false,
    autoRanges:new Map(),manualScales:new Map(),emptyPaneRanges:new Map(),fitEmptyPanes:new Set(),projectionCache:new Map([['old',{}]]),markerIndices:new Map([['old',[]]]),studyMarkers:new Map([['old',{}]]),drag:null,
    host:{style:{},classList:{remove:vi.fn()}},paneControls:{querySelector:()=>null},
    publish:vi.fn(),refreshOverlays:vi.fn(),workerRequests:vi.fn(()=>[{id:'pattern-test',instanceId:'mounted',params:{}}]),setMarket:vi.fn(),
  });
  return {controller,store,engine,feed,renderer,response};
}

describe('controller pattern history backfill lifecycle',()=>{
  it('preserves websocket ticks/new candles during REST and rebases the viewport without recreating canvases',async()=>{
    const h=harness(),beforeX=h.controller.viewport.xOf(99),renderer=h.controller.renderer;
    const loading=h.controller.loadPatternHistory();
    expect(h.feed.loadBefore).toHaveBeenCalledWith(100*minute,4);expect(h.controller.state.patternHistoryLoading).toBe(true);
    h.controller.acceptBar({...bar(199,108),isNew:false});
    h.controller.acceptBar({...bar(200,109),isNew:true});
    h.controller.acceptBar({...bar(200,111),isNew:false,confirmed:true});
    expect(h.engine.pushBar.mock.calls).toEqual([[false,false],[true,false],[false,true]]);
    h.response.resolve([96,97,98,99].map(i=>bar(i)));await loading;await flush();
    expect(h.controller.store).toBe(h.store);expect(h.store.length).toBe(105);
    expect(h.store.timeAt(0)).toBe(96*minute);expect(h.store.timeAt(104)).toBe(200*minute);
    expect(h.store.col('close')[103]).toBe(108);expect(h.store.col('close')[104]).toBe(111);
    expect(h.controller.viewport.xOf(103)).toBe(beforeX);expect(h.controller.viewport.span).toBe(20);
    expect(h.controller.renderer).toBe(renderer);expect(h.renderer.resize).not.toHaveBeenCalled();expect(h.renderer.destroy).not.toHaveBeenCalled();expect(h.controller.setMarket).not.toHaveBeenCalled();
    expect(h.engine.init).toHaveBeenCalledTimes(1);expect(h.engine.init.mock.calls[0][2]).toBe(true);
    expect(h.controller.projectionCache.size).toBe(0);expect(h.controller.state.patternHistoryLoading).toBe(false);expect(h.feed.loadBefore).toHaveBeenCalledTimes(1);
  });

  it('rejects old-market replies and does not clear a newer generation’s active loader',async()=>{
    const h=harness(),oldLoad=h.controller.loadPatternHistory(),next=deferred(),newStore=new ColumnStore();
    for(let i=300;i<400;i++)newStore.appendBar(bar(i));
    h.controller.generation++;h.controller.store=newStore;h.controller.feed={loadBefore:vi.fn(()=>next.promise)};
    h.controller.state={...h.controller.state,symbol:'ETHUSDT',patternHistoryLoading:false};
    const currentLoad=h.controller.loadPatternHistory();expect(h.controller.state.patternHistoryLoading).toBe(true);
    h.response.resolve([96,97,98,99].map(i=>bar(i)));await oldLoad;
    expect(h.store.length).toBe(100);expect(newStore.length).toBe(100);expect(h.engine.init).not.toHaveBeenCalled();expect(h.controller.state.patternHistoryLoading).toBe(true);
    next.resolve([]);await currentLoad;expect(h.controller.state.patternHistoryLoading).toBe(false);
    expect(h.controller.store).toBe(newStore);expect(h.controller.state.patternHistoryError).toBe('');
    const frozen=harness(),pending=frozen.controller.loadPatternHistory();
    frozen.controller.showHistoricalDataset({source:'binance',symbol:'BTCUSDT',marketType:'usdm-perpetual',interval:'1m',bars:[10,11,12,13,14,15].map(i=>bar(i))});
    expect(frozen.controller.state.patternHistoryLoading).toBe(false);
    frozen.response.resolve([96,97,98,99].map(i=>bar(i)));await pending;
    expect(frozen.controller.store.length).toBe(6);expect(frozen.controller.store.timeAt(0)).toBe(10*minute);expect(frozen.engine.init).toHaveBeenCalledTimes(1);
  });

  it('clears failed-load busy state, leaves mounted calculations live, and permits an explicit retry',async()=>{
    const h=harness(),loading=h.controller.loadPatternHistory();
    h.response.reject(new Error('network unavailable'));await loading;
    expect(h.controller.state.patternHistoryLoading).toBe(false);expect(h.controller.state.patternHistoryError).toContain('network unavailable');
    h.controller.acceptBar({...bar(200,123),isNew:true});expect(h.engine.pushBar).toHaveBeenLastCalledWith(true,false);expect(h.store.col('close')[100]).toBe(123);
    expect(h.engine.destroy).not.toHaveBeenCalled();expect(h.feed.disconnect).not.toHaveBeenCalled();
    h.feed.loadBefore.mockImplementation(async()=>[]);await h.controller.loadPatternHistory();expect(h.feed.loadBefore).toHaveBeenCalledTimes(2);
    expect(h.controller.state.patternHistoryLoading).toBe(false);expect(h.controller.state.patternHistoryError).toBe('');
  });

  it('does not repeat requests when coverage is sufficient, loading is active, or the available history is exhausted',async()=>{
    const enough=harness(104);await enough.controller.loadPatternHistory();expect(enough.feed.loadBefore).not.toHaveBeenCalled();
    const h=harness(),loading=h.controller.loadPatternHistory();await h.controller.loadPatternHistory();expect(h.feed.loadBefore).toHaveBeenCalledTimes(1);
    h.response.resolve([98,99].map(i=>bar(i)));await loading;await flush();
    expect(h.store.length).toBe(102);expect(h.controller.patternHistoryExhausted).toBe(`BTCUSDT:1m:${98*minute}`);
    await h.controller.loadPatternHistory();await flush();expect(h.feed.loadBefore).toHaveBeenCalledTimes(1);expect(h.controller.state.patternHistoryLoading).toBe(false);
  });
});
