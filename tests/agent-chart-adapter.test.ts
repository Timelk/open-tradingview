import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import {Viewport} from '../src/lib/core/viewport';
import {DrawingEngine} from '../src/lib/drawing/engine';
import {ToolRegistry} from '../src/lib/drawing/registry';
import {registerDrawingBuiltins} from '../src/lib/drawing/builtins';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {initialState,type ChartState} from '../src/lib/chart/controller';
import {DEFAULT_APPEARANCE} from '../src/lib/chart/appearance';
import {emptyScene,layerOf,type SceneLayer} from '../src/lib/scene/types';
import type {DerivedSeries,OverlayPlot} from '../src/lib/core/types';
import type {ChartEvent} from '../src/lib/agent/protocol';
import {ChartAgentAdapter} from '../src/lib/agent/chart-adapter';
import {indexForTime} from '../src/lib/drawing/coordinates';
import {toBridgeError} from '../src/lib/agent/errors';
import type {ChartAgentTarget} from '../src/lib/agent/target';

const MINUTE=60_000,T0=Date.UTC(2026,8,30,0,0);
beforeEach(()=>{const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});});
afterEach(()=>vi.unstubAllGlobals());

function harness(){
  const tools=new ToolRegistry();registerDrawingBuiltins(tools);
  const registry=new IndicatorRegistry();registerBuiltins(registry);
  let data=new ColumnStore(256);
  for(let i=0;i<120;i++)data.appendBar({time:T0+i*MINUTE,open:100+i,high:103+i,low:98+i,close:101+i,volume:5+i});
  const defaults=()=>{const doc=emptyScene();doc.layers.push(layerOf('series:candles','series','K 线','main'),layerOf('series:volume','series','成交量柱','volume'),layerOf('ma','indicator','MA','main'));
    doc.indicators.push({instanceId:'ma',id:'ma',params:registry.defaults('ma'),timeframe:'chart',hiddenPlots:[]});return doc;};
  const drawing=new DrawingEngine(tools,{paneAt:()=>'main',projection:()=>null,anchorAt:()=>null,zoomTo:()=>{}},()=>{},defaults);
  drawing.setMarket('mock:BTCUSDT');
  const ma=new Float64Array(256).fill(Number.NaN);for(let i=19;i<120;i++)ma[i]=90+i;
  const derived:DerivedSeries[]=[{name:'MA20',values:ma,color:'#f0b429',pane:'main',plot:'line',indicatorId:'ma',plotIndex:0}];
  const state:ChartState={...initialState,loading:false,status:'ok',source:'mock',symbol:'BTCUSDT',interval:'1m',confirmedBarTime:T0+118*MINUTE,visible:60,
    readings:[{id:'ma',name:'MA',paneId:'main',timeframe:'chart',visible:true,status:'实时 · 当前周期',values:[{name:'MA20',value:209,plotIndex:0,plot:'line'}]}]};
  const groups:OverlayPlot[][]=[];let overlays:OverlayPlot[]=[];
  const panes=[{id:'main',name:'主图',top:0,height:380,min:90,max:230,manual:false},{id:'volume',name:'成交量',top:380,height:120,min:0,max:130,manual:false}];
  const viewport=new Viewport(120,{from:60,to:120,plotW:800,plotH:500});
  const target:ChartAgentTarget={
    drawing,registry,viewport,
    get data(){return data;},derivedSeries:derived,get overlayPlots(){return overlays;},get chartState(){return state;},
    chartSize:{width:888,height:526,plotWidth:800,axisWidth:88,axisHeight:26,dpr:2},maximizedPaneId:null,paneGeometry:()=>panes,
    layerStatus:id=>({...drawing.effective(id),dataReason:''}),layerName:(layer:SceneLayer)=>layer.name,
    // A real linear projection, like the controller's: bar index → x, pane price range → y.
    anchorToPixel:(paneId,anchor)=>{const pane=panes.find(item=>item.id===paneId);return pane?{x:viewport.xOf(indexForTime(data,anchor.time,MINUTE)),y:pane.top+(pane.max-anchor.value)/(pane.max-pane.min)*pane.height}:null;},
    pixelToAnchor:()=>({paneId:'main',anchor:{time:T0+MINUTE,value:150}}),
    captureImage:()=>{throw Error('no canvas in unit tests');},
    // Mirrors ChartController.setOverlayGroup: plots plus their scene layer metadata.
    setOverlayGroup:vi.fn((owner:string,plots:OverlayPlot[])=>{
      groups.push(plots);overlays=plots;const ids=new Set(plots.map(plot=>plot.id));
      drawing.transact(doc=>{doc.layers=doc.layers.filter(l=>l.kind!=='overlay'||ids.has(l.id));for(const plot of plots)if(!doc.layers.some(l=>l.id===plot.id))doc.layers.push(layerOf(plot.id!,'overlay',plot.name??plot.kind,plot.paneId??'main'));return doc;});
    }),
    getPatternRows:()=>[],getAnalysisRows:()=>[],getPatternCandidates:()=>[],getAppearance:()=>({...DEFAULT_APPEARANCE}),
    addIndicator:(id,timeframe='chart',paneId,options={})=>{
      const instanceId=crypto.randomUUID(),def=registry.get(id);
      drawing.transact(doc=>{doc.indicators.push({instanceId,id,params:{...registry.defaults(id),...options.params},timeframe,hiddenPlots:[]});doc.layers.push(layerOf(instanceId,'indicator',options.name||def.name,paneId??(def.target==='main'?'main':id)));return doc;});
      return instanceId;
    },
    setMarket:vi.fn(async()=>{}),focusTimeRange:vi.fn(),followLatest:vi.fn(),showAll:vi.fn(),zoom:vi.fn(),toggleMaximize:vi.fn(),resetPaneScale:vi.fn(),
  };
  const adapter=new ChartAgentAdapter(target,{chartId:'chart-test'});
  const call=(method:string,params:Record<string,unknown>={},writable=true)=>adapter.handle(method,params,writable) as Promise<any>;
  const reject=async(method:string,params:Record<string,unknown>,writable=true)=>{try{await adapter.handle(method,params,writable);}catch(error){return toBridgeError(error);}throw Error(`${method} did not fail`);};
  return {adapter,target,drawing,state,groups,call,reject,prepend:(count:number)=>{
    const next=new ColumnStore(512);
    for(let i=count;i>0;i--)next.appendBar({time:T0-i*MINUTE,open:90,high:91,low:89,close:90,volume:1});
    for(let i=0;i<data.length;i++)next.appendBar({time:data.col('time')[i],open:data.col('open')[i],high:data.col('high')[i],low:data.col('low')[i],close:data.col('close')[i],volume:data.col('volume')[i]});
    data=next;
  }};
}

describe('chart agent adapter · reading',()=>{
  it('returns the global state of the chart in plain, compact sections',async()=>{
    const {call,reject,drawing}=harness();
    drawing.transact(doc=>({...doc,drawings:[...doc.drawings,{id:'user-line',toolId:'horizontal-line',paneId:'main',points:[{time:T0,value:150}],style:{color:'#4d91ff',width:2,dash:'solid',fillOpacity:.1},props:{},locked:false,hidden:false}],layers:[...doc.layers,layerOf('user-line','drawing','水平线','main')]}));
    const state=await call('state',{recentBars:3,timeFormat:'ms'});
    expect(state.chartId).toBe('chart-test');
    expect(state.market).toMatchObject({source:'mock',symbol:'BTCUSDT',interval:'1m',bars:{total:120,first:T0,last:T0+119*MINUTE,lastBarForming:true},latest:{close:220}});
    expect(state.viewport.panes.map((p:{id:string})=>p.id)).toEqual(['main','volume']);
    expect(state.drawings).toMatchObject({total:1,agent:0,items:[{id:'user-line',tool:'horizontal-line',author:'user',points:[{time:T0,value:150}]}]});
    expect(state.indicators.items[0]).toMatchObject({id:'ma',type:'ma',params:{period:20},outputs:[{name:'MA20',value:209}]});
    expect(state.recentBars.rows).toHaveLength(3);
    expect(state.tools).toMatchObject({activeTool:'cursor',canUndo:true});
    expect(Object.keys(await call('state',{include:['market']}))).toEqual(['chartId','market']);
    expect((await reject('state',{include:['bogus']})).message).toMatch(/unknown section/);
  });
  it('exposes analysis and drawing without accepting the removed script API or state section',async()=>{
    const {call,reject,drawing}=harness(),before=structuredClone(drawing.document);
    expect(await call('state')).not.toHaveProperty('scripts');
    for(const method of ['script.list','script.run','script.detach'])
      expect(await reject(method,{})).toMatchObject({code:'UNKNOWN_METHOD'});
    expect(await reject('state',{include:['scripts']})).toMatchObject({code:'BAD_REQUEST'});
    expect(drawing.document).toEqual(before);
  });
  it('hides retired execution layers in read-only output without deleting saved drawings or scene data',async()=>{
    const {call,drawing}=harness();
    drawing.transact(doc=>{doc.layers.push(layerOf('pine:retired:line','overlay','Old output','main'));
      doc.layers.push(layerOf('user-on-old-pane','drawing','My note','pine-pane:retired'));
      doc.drawings.push({id:'user-on-old-pane',toolId:'text',paneId:'pine-pane:retired',points:[{time:T0,value:150}],style:{color:'#ffffff',width:1,dash:'solid',fillOpacity:0},props:{text:'Keep my note'},locked:false,hidden:false});return doc;});
    const before=structuredClone(drawing.document),state=await call('state',{include:['layers','overlays','drawings']});
    expect(state.layers.items.some((layer:{id:string})=>layer.id==='pine:retired:line')).toBe(false);
    expect(state.overlays).toEqual([]);
    expect(state.drawings.items.some((item:{id:string})=>item.id==='user-on-old-pane')).toBe(true);
    expect(drawing.document).toEqual(before);
  });
  it('pages bars and indicator series with bucketing',async()=>{
    const {call}=harness();
    const bars=await call('bars',{range:{last:10},timeFormat:'ms'});
    expect(bars.rows).toHaveLength(10);expect(bars.rows[9]).toEqual([T0+119*MINUTE,219,222,217,220,124]);
    const coarse=await call('bars',{range:'all',maxPoints:40});
    expect(coarse.aggregation).toMatchObject({barsPerRow:3});expect(coarse.rows).toHaveLength(40);
    const series=await call('series',{range:{last:4},timeFormat:'ms'});
    expect(series.time).toEqual([T0+116*MINUTE,T0+117*MINUTE,T0+118*MINUTE,T0+119*MINUTE]);
    expect(series.series).toEqual([expect.objectContaining({id:'ma',output:'MA20',values:[206,207,208,209]})]);
  });
  it('lists drawable tools only, with point counts and text props',async()=>{
    const catalog=await harness().call('catalog',{kind:'tools'});
    const ids=catalog.tools.map((tool:{id:string})=>tool.id);
    expect(ids).toContain('fib-retracement');expect(ids).not.toContain('eraser');expect(ids).not.toContain('zoom-region');
    expect(catalog.tools.find((tool:{id:string})=>tool.id==='text')).toMatchObject({points:1,textProp:'text'});
  });
});

describe('chart agent adapter · drawing',()=>{
  it('creates a grouped batch as one undo step, tagged as agent work',async()=>{
    const {call,drawing}=harness();
    const result=await call('draw',{group:'AI · 支撑阻力',drawings:[
      {tool:'trend-line',points:[{barsAgo:40,price:'low'},{barsAgo:5,price:'low'}],style:{color:'#26A69A',width:2}},
      {tool:'horizontal-line',points:[{barsAgo:0,value:215}],name:'阻力 215'},
      {tool:'text',points:[{time:T0+100*MINUTE,value:222}],text:'突破观察'},
    ]});
    expect(result.created).toHaveLength(3);expect(result.groups).toEqual([expect.objectContaining({name:'AI · 支撑阻力',paneId:'main',reused:false})]);
    const doc=drawing.document;
    const created=doc.drawings.filter(d=>result.created.some((c:{id:string})=>c.id===d.id));
    expect(created.every(d=>d.props.author==='agent')).toBe(true);
    expect(created[0]).toMatchObject({points:[{time:T0+79*MINUTE,value:177},{time:T0+114*MINUTE,value:212}],style:{color:'#26a69a',width:2}});
    expect(created[2].props.text).toBe('突破观察');
    expect(doc.layers.find(l=>l.id===created[1].id)).toMatchObject({name:'阻力 215',parentId:result.groups[0].id});
    const again=await call('draw',{group:'AI · 支撑阻力',drawings:[{tool:'vertical-line',points:[{barsAgo:1,value:0}]}]});
    expect(again.groups[0]).toMatchObject({id:result.groups[0].id,reused:true});
    await call('history',{action:'undo'});await call('history',{action:'undo'});
    expect(drawing.document.drawings).toHaveLength(0);
  });
  it('rejects invalid requests without touching the scene or the UI error state',async()=>{
    const {reject,drawing}=harness(),before=JSON.stringify(drawing.document);
    expect(await reject('draw',{drawings:[{tool:'trend-line',points:[{barsAgo:1,value:1}]}]})).toMatchObject({code:'BAD_REQUEST',message:expect.stringMatching(/exactly 2 point/)});
    expect((await reject('draw',{drawings:[{tool:'laser',points:[]}]})).message).toMatch(/not a drawing tool/);
    expect((await reject('draw',{drawings:[{tool:'zoom-region',points:[{barsAgo:1,value:1},{barsAgo:0,value:2}]}]})).message).toMatch(/interaction tool/);
    expect((await reject('draw',{drawings:[{tool:'rectangle',points:[{barsAgo:9,value:1},{barsAgo:0,value:2}],style:{color:'red'}}]})).message).toMatch(/hex color/);
    expect((await reject('draw',{drawings:[{tool:'horizontal-line',paneId:'rsi',points:[{barsAgo:0,value:50}]}]})).message).toMatch(/not a pane/);
    expect((await reject('draw',{drawings:[{tool:'rectangle',text:'x',points:[{barsAgo:9,value:1},{barsAgo:0,value:2}]}]})).message).toMatch(/no text field/);
    expect(JSON.stringify(drawing.document)).toBe(before);expect(drawing.state.error).toBe('');
  });
  it('respects the write switch, global locks and an open property dialog',async()=>{
    const {reject,drawing,call}=harness(),line={drawings:[{tool:'horizontal-line',points:[{barsAgo:0,value:200}]}]};
    expect((await reject('draw',line,false)).code).toBe('WRITE_DISABLED');
    expect(await call('state',{include:['market']},false)).toHaveProperty('market');
    drawing.setOption('locked',true);expect((await reject('draw',line)).code).toBe('LOCKED');drawing.setOption('locked',false);
    const edit=drawing.beginPropertyEdit([]);expect((await reject('draw',line)).code).toBe('BUSY');edit.cancel();
    expect((await call('draw',line)).created).toHaveLength(1);
  });
  it('updates, locks and deletes only what it is asked to',async()=>{
    const {call,reject,drawing}=harness();
    drawing.transact(doc=>({...doc,drawings:[...doc.drawings,{id:'user-box',toolId:'rectangle',paneId:'main',points:[{time:T0,value:100},{time:T0+9*MINUTE,value:110}],style:{color:'#4d91ff',width:1,dash:'solid',fillOpacity:.1},props:{},locked:false,hidden:false}],layers:[...doc.layers,layerOf('user-box','drawing','矩形','main')]}));
    const {created:[zone]}=await call('draw',{drawings:[{tool:'rectangle',points:[{barsAgo:30,value:190},{barsAgo:0,value:200}]}]});
    const updated=await call('update',{updates:[{id:zone.id,points:[{barsAgo:20,value:195},{barsAgo:0,value:205}],style:{dash:'dashed'},name:'AI 区域',locked:true}]});
    expect(updated.objects[0]).toMatchObject({style:{dash:'dashed'},name:'AI 区域',locked:true});
    expect((await reject('update',{updates:[{id:zone.id,name:'x'}]})).code).toBe('LOCKED');
    expect((await call('update',{updates:[{id:zone.id,locked:false}]})).changed).toBe(true);
    expect((await reject('delete',{ids:['series:candles']})).message).toMatch(/hide it/);
    const removed=await call('delete',{author:'agent'});
    expect(removed.deleted).toEqual([zone.id]);
    expect(drawing.document.drawings.map(d=>d.id)).toEqual(['user-box']);
  });
});

describe('chart agent adapter · overlays and indicators',()=>{
  it('materializes time-space overlays and re-aligns them when history is prepended',async()=>{
    const {call,groups,adapter,prepend}=harness();
    const result=await call('overlay.set',{id:'trend',kind:'line',points:[{barsAgo:20,value:200},{barsAgo:10,value:210}],color:'#ff9800'});
    expect(result.overlays[0]).toMatchObject({id:'agent:trend',kind:'line',items:2});
    const plot=groups.at(-1)![0];
    expect(plot).toMatchObject({id:'agent:trend',paneId:'main',kind:'line',offset:99});
    expect([...plot.values]).toEqual([200,201,202,203,204,205,206,207,208,209,210]);
    await call('overlay.set',{id:'notes',kind:'objects',objects:[{kind:'label',at:{barsAgo:5,value:215},text:'关注'},{kind:'box',from:{barsAgo:30,value:180},to:{barsAgo:25,value:170},text:'区间'}]});
    const objects=groups.at(-1)!.find(p=>p.id==='agent:notes')!;
    expect(objects.drawings).toEqual([expect.objectContaining({kind:'label',text:'关注',index1:114,y1:215}),expect.objectContaining({kind:'box',index1:89,index2:94,y2:170})]);
    prepend(10);adapter.sync();
    expect(groups.at(-1)!.find(p=>p.id==='agent:trend')!.offset).toBe(109);
    expect((await call('overlay.remove',{all:true})).removed).toEqual(['agent:trend','agent:notes']);
    expect(groups.at(-1)).toEqual([]);
  });
  it('lets a user deletion of an agent overlay stick',async()=>{
    const {call,groups,adapter,drawing}=harness();
    await call('overlay.set',{id:'keep',kind:'line',points:[{barsAgo:5,value:200},{barsAgo:0,value:205}]});
    await call('overlay.set',{id:'drop',kind:'line',points:[{barsAgo:5,value:210},{barsAgo:0,value:215}]});
    drawing.removeLayers(['agent:drop']);adapter.sync();
    expect(groups.at(-1)!.map(plot=>plot.id)).toEqual(['agent:keep']);
    expect((await call('state',{include:['overlays']})).overlays.map((o:{id:string})=>o.id)).toEqual(['agent:keep']);
  });
  it('keeps GPU series overlays on hex colors and can give an overlay its own pane',async()=>{
    const {call,reject,groups}=harness();
    expect((await reject('overlay.set',{id:'x',kind:'line',color:'rgba(1,2,3,.5)',points:[{barsAgo:1,value:1},{barsAgo:0,value:2}]})).message).toMatch(/#rrggbb/);
    await call('overlay.set',{id:'osc',kind:'hist',paneId:'new',color:'#0f0',points:[{barsAgo:2,value:-1},{barsAgo:1,value:2}]});
    expect(groups.at(-1)![0]).toMatchObject({id:'agent:osc',paneId:'agent-pane:osc',pane:'sub',color:'#00ff00',offset:117});
    await call('overlay.set',{id:'osc-signal',kind:'line',paneId:'agent-pane:osc',points:[{barsAgo:2,value:0},{barsAgo:0,value:1}]});
    expect(groups.at(-1)!.map(plot=>plot.paneId)).toEqual(['agent-pane:osc','agent-pane:osc']);
    expect((await reject('overlay.set',{id:'y',kind:'line',paneId:'nowhere',points:[{barsAgo:0,value:1}]})).message).toMatch(/use "new"/);
  });
  it('adds and updates indicators through validated params in single steps',async()=>{
    const {call,reject}=harness();
    const added=await call('indicator.add',{type:'rsi',params:{period:9999},plotStyles:{0:{color:'#FF9800'}}});
    expect(added).toMatchObject({type:'rsi',paneId:'rsi',params:{period:200},plotStyles:{0:{color:'#ff9800'}}});
    const updated=await call('indicator.update',{id:added.id,params:{period:7},timeframe:'5m',hiddenPlots:[0],visible:false});
    expect(updated.indicator).toMatchObject({params:{period:7},timeframe:'5m',hiddenPlots:[0],visible:false});
    expect((await reject('indicator.update',{id:added.id,params:{length:3}})).message).toMatch(/unknown param "length"/);
    expect((await reject('indicator.add',{type:'nope'})).message).toMatch(/unknown indicator/);
  });
});

describe('chart agent adapter · events',()=>{
  it('reports selection and scene changes and who made them',async()=>{
    const {adapter,call,drawing}=harness(),events:ChartEvent[]=[];
    adapter.subscribe(event=>events.push(event));
    const {created:[line]}=await call('draw',{drawings:[{tool:'horizontal-line',points:[{barsAgo:0,value:200}]}]});
    drawing.selectLayers([line.id]);
    expect(events.find(e=>e.type==='scene')?.data).toMatchObject({added:[line.id],by:'agent'});
    expect(events.find(e=>e.type==='selection')?.data).toMatchObject({ids:[line.id],by:'user'});
  });
});

describe('chart agent adapter · text layout for models without vision',()=>{
  it('reports where each object lands and what collides, from the rendered geometry',async()=>{
    const {call}=harness();
    const {created,layout}=await call('draw',{drawings:[
      {tool:'horizontal-line',points:[{barsAgo:0,value:140}],name:'支撑'},
      {tool:'text',points:[{barsAgo:10,price:'close'}],text:'压在K线上'},
      {tool:'text',points:[{barsAgo:30,value:150}],text:'标签一'},{tool:'text',points:[{barsAgo:30,value:150}],text:'标签二'},
      {tool:'trend-line',points:[{barsAgo:110,value:100},{barsAgo:100,value:110}],name:'视窗外'},
    ]});
    const [line,onCandles,first,,outside]=created.map((item:{id:string})=>item.id);
    expect(layout.onScreen[line]).toBe('full');expect(layout.onScreen[outside]).toBe('off');
    const kinds=(id:string)=>layout.issues.filter((issue:{id:string})=>issue.id===id).map((issue:{kind:string})=>issue.kind);
    expect(kinds(outside)).toEqual(['offscreen']);
    expect(kinds(onCandles)).toContain('label-covers-candles');
    expect(kinds(first)).toContain('label-overlap');
    expect(kinds(line)).toEqual([]);
    const report=await call('layout',{columns:60,rows:12});
    const described=report.objects.find((object:{id:string})=>object.id===line);
    expect(described).toMatchObject({tool:'horizontal-line',onScreen:'full',labels:[{text:expect.stringContaining('140')}]});
    expect((described.labels[0].y0+described.labels[0].y1)/2).toBeCloseTo((230-140)/140*380,0);
    expect(report.ascii.split('\n')).toHaveLength(13);expect(report.ascii).toContain('─');expect(report.ascii).toContain('◀ last');
  });
});
