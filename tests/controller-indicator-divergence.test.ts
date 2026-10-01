import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartController, initialState } from '../src/lib/chart/controller';
import { ColumnStore } from '../src/lib/core/datastore';
import { Pyramid } from '../src/lib/core/pyramid';
import { Viewport } from '../src/lib/core/viewport';
import { PaneLayout } from '../src/lib/core/pane-layout';
import { LiveBarMotion } from '../src/lib/interaction/live-bar-motion';
import { IndicatorRegistry, registerBuiltins } from '../src/lib/indicators/registry';
import { DrawingEngine } from '../src/lib/drawing/engine';
import { ToolRegistry } from '../src/lib/drawing/registry';
import { registerDrawingBuiltins } from '../src/lib/drawing/builtins';
import { emptyScene, layerOf, type SceneDocument } from '../src/lib/scene/types';
import { drawPatterns } from '../src/lib/render/patterns';
import {drawIndicatorDivergences,type IndicatorDivergencePaintOptions} from '../src/lib/render/indicator-divergences';
import type {IndicatorDivergenceMark} from '../src/lib/indicators/divergence-projection';
import type {OscillatorDivergence} from '../src/lib/indicators/divergence';
import type { DerivedSeries } from '../src/lib/core/types';
import type { PatternMatch } from '../src/lib/patterns/types';

vi.mock('../src/lib/render/axes', async original => ({...await original<typeof import('../src/lib/render/axes')>(), drawAxesBase: vi.fn()}));
vi.mock('../src/lib/render/patterns', async original => ({...await original<typeof import('../src/lib/render/patterns')>(), drawPatterns: vi.fn(() => [])}));
vi.mock('../src/lib/render/indicator-divergences', () => ({
  drawIndicatorDivergences: vi.fn((_ctx: CanvasRenderingContext2D, marks: readonly IndicatorDivergenceMark[], o: IndicatorDivergencePaintOptions) =>
    marks.map(mark => ({instanceId: o.instanceId, divergence: mark.divergence, bounds: o.bounds, clipBounds: o.bounds,
      segments: [[o.project(mark.points[0].time, mark.points[0].value), o.project(mark.points[1].time, mark.points[1].value)]]}))),
}));

const minute = 60_000, sourceId = 'hscp:mounted', rsiId = 'rsi:mounted', macdId = 'macd:mounted';
const cleanup: Array<() => void> = [];
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value)});
});
afterEach(() => { cleanup.splice(0).forEach(close => close()); vi.unstubAllGlobals(); });

function pattern(id = 'hscp:test', first = 20, second = 40): PatternMatch {
  return {id, family: 'huzi-double', name: '双背离共振 · 双底', direction: 'bullish', status: 'confirmed',
    confirmedAt: (second + 5) * minute, points: [{label: 'B1', time: first * minute, value: 90}, {label: 'N', time: (first + second) / 2 * minute, value: 110}, {label: 'B2', time: second * minute, value: 85}],
    invalidation: 80, targets: [120, 130], zone: {low: 89, high: 91}, ratios: [], description: 'fixture',
    divergences: [
      {indicator: 'rsi', series: 'rsi', params: {period: 14}, minDelta: 1, points: [{time: first * minute, value: 25}, {time: second * minute, value: 35}]},
      {indicator: 'macd', series: 'dif', params: {fast: 12, slow: 26, signal: 9}, points: [{time: first * minute, value: -3}, {time: second * minute, value: -1}]},
    ]};
}
function divergence(indicator:string,first=20,second=40):OscillatorDivergence {
  return {id:'osc:'+indicator+':'+first+':'+second,indicator,seriesName:indicator==='rsi'?'RSI(7)':indicator==='macd'?'DIF':'K',plotIndex:0,direction:'bullish',
    points:[{time:first*minute,value:25,price:90},{time:second*minute,value:35,price:85}],confirmedAt:(second+5)*minute,ruleVersion:'fixture'};
}
function scene(): SceneDocument {
  const doc = emptyScene();
  doc.layers = [layerOf('series:candles', 'series', 'K线'),     layerOf(rsiId, 'indicator', 'RSI', 'rsi', {opacity: .5}), layerOf(macdId, 'indicator', 'MACD', 'macd', {opacity: .9})];
  doc.indicators = [
    {instanceId: rsiId, id: 'rsi', params: {period: 7}, timeframe: 'chart', hiddenPlots: []},
    {instanceId: macdId, id: 'macd', params: {fast: 5, slow: 12, signal: 4}, timeframe: 'chart', hiddenPlots: []},
  ];
  return doc;
}
function harness(doc = scene()) {
  const store = new ColumnStore();
  for (let i = 0; i < 100; i++) store.appendBar({time: i * minute, open: 100, high: 110, low: 80, close: 100, volume: 100});
  const registry = new IndicatorRegistry(); registerBuiltins(registry);
  const tools = new ToolRegistry(); registerDrawingBuiltins(tools);
  const context = {globalAlpha: 1, measureText: (text: string) => ({width: text.length * 7})} as unknown as CanvasRenderingContext2D;
  const renderer = {begin: vi.fn(), setOpacity: vi.fn(), canvasLayer: vi.fn((paint: (ctx: CanvasRenderingContext2D) => void) => paint(context)),
    clip: vi.fn(), rect: vi.fn(), seg: vi.fn(), marker: vi.fn(), flush: vi.fn()};
  const rsiValues = Float64Array.from({length: 100}, (_, i) => 20 + i * .5), macdValues = Float64Array.from({length: 100}, (_, i) => -5 + i * .1);
  const derived: DerivedSeries[] = [
    {name: 'RSI', indicatorId: rsiId, plotIndex: 0, values: rsiValues, color: '#88aaff', pane: 'sub', plot: 'line', divergences:[divergence('rsi') ]},
    {name: 'DIF', indicatorId: macdId, plotIndex: 0, values: macdValues, color: '#ffaa88', pane: 'sub', plot: 'line', divergences:[divergence('macd') ]},
    {name: 'DEA', indicatorId: macdId, plotIndex: 1, values: Float64Array.from(macdValues, value => value - .2), color: '#ddee88', pane: 'sub', plot: 'line'},
    {name: 'Histogram', indicatorId: macdId, plotIndex: 2, values: new Float64Array(100).fill(.4), color: '#abcdef', pane: 'sub', plot: 'hist'},
  ];
  const calculations = {derived, setReqs: vi.fn(), pending: false};
  const controller = Object.assign(Object.create(ChartController.prototype), {
    registry, store, pyramid: new Pyramid(store), viewport: new Viewport(100, {from: 0, to: 100, plotW: 1000, plotH: 600}), paneLayout: new PaneLayout(),
    renderer, engine: calculations, state: {...initialState, interval: '1m', loading: false, smoothMotion: false}, width: 1088, height: 626,
    panes: [], manualScales: new Map(), emptyPaneRanges: new Map(), fitEmptyPanes: new Set(), autoRanges: new Map(), projectionCache: new Map(),
    maximizedPane: null, drag: null, liveBarMotion: new LiveBarMotion(), generation: 0, overlays: [], markerIndices: new Map(), studyMarkers: new Map(),
    externalOverlays: [], dataRevision: 0,
    ctx: context, axisContext: {clearRect: vi.fn()}, syncPaneControls: vi.fn(), publish: vi.fn(), loadPatternHistory: vi.fn(async () => {}),
    reqs: [], syncedDocument: null, syncedInterval: '', calculationSignature: '', drawingRevision: 0,
    sceneLookupDocument: null, layerLookup: new Map(), instanceLookup: new Map(),
  });
  const drawing = new DrawingEngine(tools, {paneAt: point => controller.panes.find((pane: {top: number; height: number}) => point.y >= pane.top && point.y < pane.top + pane.height)?.id ?? null,
    projection: id => controller.drawingProjection(id), anchorAt: (point, id, snap) => controller.drawingAnchor(point, id, snap), zoomTo: () => {}}, () => {controller.dirty = true;}, () => doc);
  controller.drawing = drawing; drawing.setMarket('mock:DIVERGENCE');
  const unsubscribe = drawing.subscribe(() => controller.syncScene()); calculations.setReqs.mockClear();
  const draw = () => {vi.mocked(drawIndicatorDivergences).mockClear(); vi.mocked(drawPatterns).mockClear(); renderer.begin.mockClear(); controller.draw();};
  const calls = () => vi.mocked(drawIndicatorDivergences).mock.calls;
  cleanup.push(() => {unsubscribe(); drawing.destroy();});
  return {controller, drawing, calculations, renderer, draw, calls};
}


describe('controller independent indicator divergence overlays',()=>{
  it('renders custom RSI and MACD evidence without mounting a price-pattern layer',()=>{
    const h=harness();h.draw();expect(h.calls()).toHaveLength(2);
    expect(h.calls().map(([,marks])=>marks[0].divergence.indicator)).toEqual(['rsi','macd']);
    expect(vi.mocked(drawPatterns)).not.toHaveBeenCalled();expect(h.controller.patternHits).toEqual([]);
    expect(h.controller.divergenceHits.map((hit:{instanceId:string})=>hit.instanceId)).toEqual([rsiId,macdId]);
    for(const [,marks,options] of h.calls()){
      const id=marks[0].divergence.indicator,pane=h.controller.panes.find((pane:{id:string})=>pane.id===id);
      expect(options.instanceId).toBe(id+':mounted');expect(options.bounds.top).toBe(pane.top);expect(options.bounds.bottom).toBe(pane.top+pane.height);
      expect(options.opacity).toBe(id==='rsi'?.5:.9);
    }
    expect(h.calls()[0][1][0].points.map(point=>point.value)).toEqual([30,40]);
    expect(h.drawing.document.indicators.find(instance=>instance.id==='rsi')?.params.period).toBe(7);
    expect(h.drawing.document.indicators.find(instance=>instance.id==='macd')?.params.fast).toBe(5);
  });
  it('extends the same independent pipeline to a custom KDJ primary line',()=>{
    const doc=scene(),id='kdj:mounted';doc.layers.push(layerOf(id,'indicator','KDJ','kdj'));
    doc.indicators.push({instanceId:id,id:'kdj',params:{n:5,m1:3,m2:3},timeframe:'chart',hiddenPlots:[]});
    const h=harness(doc);h.calculations.derived.push({...h.calculations.derived[0],indicatorId:id,name:'K',divergences:[divergence('kdj')]});
    h.draw();expect(h.calls()).toHaveLength(3);expect(h.calls().find(([,marks])=>marks[0].divergence.indicator==='kdj')![2].instanceId).toBe(id);
  });
  it('ignores added, hidden or removed confluence layers and their duplicate legacy evidence',()=>{
    const h=harness();h.draw();const initial=h.calls().map(([,marks])=>marks.map(mark=>mark.divergence.id));
    h.drawing.transact(doc=>({...doc,layers:[...doc.layers,layerOf(sourceId,'indicator','Confluence')],indicators:[...doc.indicators,
      {instanceId:sourceId,id:'pattern-confluence',params:{historyDisplay:'all'},timeframe:'chart',hiddenPlots:[]}]}));
    h.calculations.derived.push({name:'Shapes',indicatorId:sourceId,plotIndex:0,values:new Float64Array(100).fill(NaN),pane:'main',plot:'patterns',color:'#aaa',patterns:[pattern(),pattern('legacy:two')]});
    h.draw();expect(h.calls().map(([,marks])=>marks.map(mark=>mark.divergence.id))).toEqual(initial);
    h.controller.toggleIndicator('pattern-confluence',false);h.draw();expect(h.calls()).toHaveLength(2);
    h.drawing.removeLayers([sourceId]);h.draw();expect(h.calls()).toHaveLength(2);
    for(const line of h.calculations.derived)delete line.divergences;
    h.draw();expect(h.calls()).toEqual([]);expect(h.controller.divergenceHits).toEqual([]);
  });
  it('removes annotations for hidden or removed owning indicators and hidden primary plots',()=>{
    const h=harness();h.draw();expect(h.calls()).toHaveLength(2);
    h.controller.toggleIndicator('rsi',false);h.draw();expect(h.calls().map(([,marks])=>marks[0].divergence.indicator)).toEqual(['macd']);
    h.controller.toggleIndicator('rsi',true);h.controller.toggleIndicatorPlot(rsiId,0);h.draw();expect(h.calls()).toHaveLength(1);
    h.controller.toggleIndicatorPlot(rsiId,0);h.drawing.removeLayers([rsiId]);h.draw();expect(h.calls()).toHaveLength(1);
    h.drawing.removeLayers([macdId]);h.draw();expect(h.calls()).toHaveLength(0);expect(h.controller.divergenceHits).toEqual([]);
  });
  it('keeps visibility and labels display-only while retaining cached evidence',()=>{
    const h=harness(),cached=h.calculations.derived[0].divergences;
    h.controller.setParam(rsiId,'showDivergences',false);h.draw();expect(h.calls()).toHaveLength(1);
    h.controller.setParam(rsiId,'showDivergences',true);h.controller.setParam(rsiId,'showDivergenceLabels',false);h.draw();
    expect(h.calls()).toHaveLength(2);expect(h.calls().find(([,marks])=>marks[0].divergence.indicator==='rsi')![2].labels).toBe(false);
    expect(h.calls().find(([,marks])=>marks[0].divergence.indicator==='macd')![2].labels).toBe(true);
    expect(h.calculations.derived[0].divergences).toBe(cached);expect(h.calculations.setReqs).not.toHaveBeenCalled();
    const request=h.controller.workerRequests().find((value:{instanceId:string})=>value.instanceId===rsiId);
    expect(request.params).not.toHaveProperty('showDivergences');expect(request.params).not.toHaveProperty('showDivergenceLabels');
    h.controller.setParam(rsiId,'divergenceStrength',5);expect(h.calculations.setReqs).toHaveBeenCalledTimes(1);
  });
  it('uses bounded overview evidence while keeping selection and restoring all close-view pairs',()=>{
    const h=harness();
    for(const line of h.calculations.derived)if(line.divergences)
      line.divergences=Array.from({length:400},(_,i)=>divergence(line.indicatorId===rsiId?'rsi':'macd',1+Math.floor(i/20),50+i%20));
    const rsi=h.calculations.derived[0],archive=rsi.divergences!,selected=archive[7];
    h.controller.selectedDivergenceKey=`${rsiId}:${selected.id}`;h.controller.viewport.plotW=10;h.draw();
    expect(h.controller.divergenceRendering).toMatchObject({mode:'pixel-density',archive:800,budgetPerSeries:32});
    expect(h.controller.divergenceRendering.projected).toBeLessThanOrEqual(70);
    expect(h.calls().find(([,marks])=>marks[0].divergence.indicator==='rsi')![1].some(mark=>mark.divergence===selected)).toBe(true);
    expect(rsi.divergences).toBe(archive);expect(archive).toHaveLength(400);
    h.controller.viewport.plotW=1000;h.draw();
    expect(h.controller.divergenceRendering).toMatchObject({mode:'full',archive:800,projected:800,budgetPerSeries:null});
    expect(h.calls().flatMap(([,marks])=>marks)).toHaveLength(800);
  });
  it('deduplicates an identical pair in one pane while retaining a separate-pane copy',()=>{
    const doc=scene(),copy='rsi:copy';doc.indicators.push({...doc.indicators[0],instanceId:copy});doc.layers.push(layerOf(copy,'indicator','RSI copy','rsi'));
    const h=harness(doc),original=h.calculations.derived[0];original.divergences!.push(structuredClone(original.divergences![0]));
    h.calculations.derived.push({...original,indicatorId:copy});h.draw();expect(h.calls()).toHaveLength(2);
    expect(h.calls().filter(([,marks])=>marks[0].divergence.indicator==='rsi').flatMap(([,marks])=>marks)).toHaveLength(1);
    h.drawing.transact(doc=>({...doc,layers:doc.layers.map(layer=>layer.id===copy?{...layer,paneId:'rsi-copy'}:layer)}));
    h.draw();expect(h.calls()).toHaveLength(3);expect(h.controller.divergenceHits.filter((hit:{divergence:OscillatorDivergence})=>hit.divergence.indicator==='rsi')).toHaveLength(2);
  });
  it('prefers the independently selected duplicate instance without using pattern selection',()=>{
    const doc=scene(),copy='rsi:copy';doc.indicators.push({...doc.indicators[0],instanceId:copy});doc.layers.push(layerOf(copy,'indicator','RSI copy','rsi'));
    const h=harness(doc),source=h.calculations.derived[0];h.calculations.derived.push({...source,indicatorId:copy});
    h.controller.selectedPatternKey='unrelated:price-pattern';h.controller.selectedDivergenceKey=copy+':'+source.divergences![0].id;h.draw();
    const selected=h.calls().find(([,marks])=>marks[0].divergence.indicator==='rsi')!;
    expect(selected[2].instanceId).toBe(copy);expect(selected[2].selectedId).toBe(source.divergences![0].id);
    expect(h.calls().find(([,marks])=>marks[0].divergence.indicator==='macd')![2].selectedId).toBeUndefined();
  });
  it('enables the Canvas composition when only a maximized oscillator pane is visible',()=>{
    const h=harness();h.controller.maximizedPane='rsi';h.draw();
    expect(h.controller.panes.map((pane:{id:string})=>pane.id)).toEqual(['rsi']);expect(h.calls()).toHaveLength(1);
    expect(h.renderer.begin.mock.lastCall?.[2]).toBe(true);expect(h.controller.divergenceHits).toHaveLength(1);expect(vi.mocked(drawPatterns)).not.toHaveBeenCalled();
  });
  it('retains unsampled divergence endpoints on the actual oscillator curve and its auto-range',()=>{
    const h=harness();h.controller.viewport.plotW=10;
    for(const series of h.calculations.derived)if(series.divergences)series.divergences=[divergence(series.indicatorId===rsiId?'rsi':'macd',21,41)];
    const dif=h.calculations.derived.find(line=>line.indicatorId===macdId&&line.plotIndex===0)!;dif.values[21]=-10;dif.values[41]=-8;
    h.draw();const pane=h.controller.panes.find((entry:{id:string})=>entry.id==='macd');expect(pane.min).toBeLessThan(-10);
    const options=h.calls().find(([,marks])=>marks[0].divergence.indicator==='macd')![2];
    for(const [index,value] of [[21,-10],[41,-8]]){
      const point=options.project(index*minute,value);
      expect(h.renderer.seg.mock.calls.some(call=>Math.abs(call[0]-point.x)<1e-8&&Math.abs(call[1]-point.y)<1e-8||Math.abs(call[2]-point.x)<1e-8&&Math.abs(call[3]-point.y)<1e-8)).toBe(true);
    }
  });
  it('maps higher-timeframe anchors to the existing next-bucket display samples',()=>{
    const doc=scene();doc.indicators.find(instance=>instance.instanceId===macdId)!.timeframe='5m';
    const h=harness(doc);h.draw();const mark=h.calls().find(([,marks])=>marks[0].divergence.indicator==='macd')![1][0];
    expect(mark.points.map(point=>point.time)).toEqual([25*minute,45*minute]);expect(mark.points.map(point=>point.value)).toEqual([-2.5,-.5]);
  });
  it('selects an independent hit with real pointer handling and selects its owning indicator',()=>{
    const h=harness();h.draw();
    class Shell extends EventTarget {focus=vi.fn();closest=()=>null;style={cursor:''};classList={add:vi.fn(),remove:vi.fn()};getBoundingClientRect=()=>({left:0,top:0});}
    vi.stubGlobal('Element',Shell);vi.stubGlobal('Node',Shell);vi.stubGlobal('window',new EventTarget());
    const host=new Shell(),events=new AbortController();
    Object.assign(h.controller,{host,events,flushPointer:vi.fn(),cancelViewportMotion:vi.fn(),markInput:vi.fn(),onDrawingSelection:vi.fn()});
    h.controller.bindEvents();const hit=h.controller.divergenceHits.find((hit:{instanceId:string})=>hit.instanceId===rsiId),point=hit.segments[0][1];
    host.dispatchEvent(Object.assign(new Event('pointerdown',{cancelable:true}),{button:0,pointerType:'mouse',pointerId:1,clientX:point.x,clientY:point.y}));
    expect(h.controller.selectedDivergenceKey).toBe(rsiId+':'+hit.divergence.id);expect(h.drawing.state.scene.selectedIds).toContain(rsiId);expect(host.focus).toHaveBeenCalled();events.abort();
    h.draw();expect(h.calls().find(([,marks])=>marks[0].divergence.indicator==='rsi')![2].selectedId).toBe(hit.divergence.id);
  });
});
