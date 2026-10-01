import {beforeAll,describe,it,expect,vi} from 'vitest';
import {build} from 'esbuild';
import {compile} from 'svelte/compiler';
import {readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {aggregateOrderBook} from '../src/lib/flow/orderbook-models';
import {normalizeOrderFlowSettings,type ChartOrderFlowState} from '../src/lib/flow/chart-order-flow';
import {sharedBook,terminalState} from './fixtures/orderbook-terminal';

let renderTerminal:(props:Record<string,unknown>,locale:string)=>string;
let renderHeatmapSettings:(props:Record<string,unknown>,locale:string)=>string;
beforeAll(async()=>{
  const root=decodeURIComponent(new URL('../src/',import.meta.url).pathname);
  const output=await build({stdin:{contents:"import Component from './components/orderbook/OrderBookTerminal.svelte';import Settings from './components/orderbook/HeatmapSettings.svelte';import{render}from'svelte/server';import{locale}from'./lib/i18n';export const draw=(props,language)=>{locale.set(language);return render(Component,{props}).body};export const drawSettings=(props,language)=>{locale.set(language);return render(Settings,{props}).body};",resolveDir:root},bundle:true,format:'esm',platform:'node',write:false,
    plugins:[{name:'terminal-ssr',setup(builder){builder.onLoad({filter:/\.svelte$/},async args=>({contents:compile(await readFile(args.path,'utf8'),{filename:args.path,generate:'server'}).js.code,loader:'js',resolveDir:dirname(args.path)}));}}]});
  const module=await import(/* @vite-ignore */'data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
  renderTerminal=module.draw;renderHeatmapSettings=module.drawSettings;
});
const text=(html:string)=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
function props(state=terminalState()){
  const flow={snapshot:()=>state,aggregate:(limit:number)=>state.book?aggregateOrderBook(state.book,{priceStep:state.market!.tickSize*state.settings.priceStepTicks,unit:state.settings.unit,limit,now:60000}):undefined,
    panel:vi.fn(),subscribe:vi.fn(),settings:vi.fn(),pause:vi.fn(),reconnect:vi.fn(),datasets:vi.fn(),loadArchive:vi.fn(),seek:vi.fn(),live:vi.fn()};
  return {context:{controller:{orderFlow:flow,loadOrderFlowArchivePrices:vi.fn()},chartState:{source:'binance',symbol:'BTCUSDT',marketType:'usdm-perpetual'}},active:true,density:'compact',zone:'right',onClose:vi.fn()};
}
function history(view:'book'|'delta'|'dom'):ChartOrderFlowState{
  const state=terminalState({mode:'history'}),dataset={id:'archive',symbol:'BTCUSDT',kind:'recording' as const,tradeType:'aggTrades' as const,state:'stopped' as const,source:'public',createdAt:0,fromTime:0,throughTime:60000,tradeCount:0,depthCount:4,gapCount:0};
  state.settings={...state.settings,view};state.archive={dataset,from:0,to:60000,cursor:60000,gaps:[],pending:false,
    frame:{datasetId:dataset.id,at:60000,book:{status:'available',bids:sharedBook().bids,asks:sharedBook().asks,time:60000,lastUpdateId:20},trades:[],coverage:{dataset,gaps:[],gapsTruncated:false,note:''}}};
  return state;
}

describe('standalone order-book terminal UI',()=>{
  it('renders same-level Book/Delta/DOM, current cumulative depth and truthful units',()=>{
    const html=renderTerminal(props(),'en-US');
    for(const name of ['Book','Delta','DOM'])expect(html).toContain(`>${name}</button>`);
    expect(html).toContain('role="tablist"');expect(html).toContain('aria-selected="true"');
    expect(text(html)).toContain('Mid price');expect(text(html)).toContain('Total');expect(text(html)).toContain('BTC');
    expect(text(html)).toContain('33.3% / 66.7%');
    expect(text(html)).not.toMatch(/SQLite|adapter|wallet|place order/i);
    expect(text(html)).not.toMatch(/[\u3400-\u9fff]/);
  });

  it('marks partial Delta coverage and retains removed-to-zero rows',()=>{
    const state=terminalState();state.settings.view='delta';state.book!.changeCoverage.fromTime=59000;
    state.book!.changes=[{revision:2,segmentId:1,eventTime:59900,receivedAt:59900,levels:[{side:'bid',price:95,addedBase:0,removedBase:7,addedQuote:0,removedQuote:665}]}];
    const html=renderTerminal(props(state),'en-US');
    expect(text(html)).toContain('Collecting window');expect(text(html)).toContain('Added');expect(text(html)).toContain('Removed');
    expect(html).toContain('title="95"');expect(html).toContain('title="7"');expect(text(html)).toContain('separate from trade delta');
  });

  it('retains the half-tick precision of a midpoint between adjacent native prices',()=>{
    const state=terminalState();state.market!.tickSize=.1;state.book!.asks=[{price:100.1,quantity:20}];
    const html=renderTerminal(props(state),'en-US');
    // Mid is shown once, in the book's centre row, at half-tick precision.
    expect(html).toContain('>100.05</strong>');expect(html.match(/>100\.05</g)).toHaveLength(1);
  });

  it('keeps historical Book/DOM usable while explicitly disabling historical Delta and tape claims',()=>{
    const book=renderTerminal(props(history('book')),'en-US'),dom=renderTerminal(props(history('dom')),'en-US'),delta=renderTerminal(props(history('delta')),'en-US');
    expect(text(book)).toContain('Historical book');expect(book).toContain('role="table"');
    expect(text(book)).toContain('Load archive price chart');expect(text(book)).toContain('Return to live book');
    expect(dom).toContain('role="grid"');expect(text(dom)).toContain('Historical trade window unavailable');expect(text(dom)).toContain('—');
    expect(text(delta)).toContain('Historical delta unavailable');expect(delta).not.toContain('class="depth-row');
  });

  it('shows unavailable states without displaying stale numeric depth',()=>{
    for(const status of ['stale','error','connecting','unsupported'] as const){
      const state=terminalState({book:{...sharedBook(),status,supported:status!=='unsupported'}}),html=renderTerminal(props(state),'en-US');
      expect(html).toContain('role="status"');expect(html).not.toContain('class="depth-row');
    }
  });

  it('localizes Chinese and English and does not acquire market leases during SSR',()=>{
    const input=props(),zh=renderTerminal(input,'zh-CN'),en=renderTerminal(input,'en-US');
    expect(text(zh)).toContain('中间价');expect(text(zh)).toContain('深度档案');expect(text(en)).not.toMatch(/[\u3400-\u9fff]/);
    expect(input.context.controller.orderFlow.panel).not.toHaveBeenCalled();expect(input.context.controller.orderFlow.datasets).not.toHaveBeenCalled();
    expect(input.context.controller.loadOrderFlowArchivePrices).not.toHaveBeenCalled();
  });
});

describe('chart-overlay settings in the order-book settings sheet',()=>{
  const settingsProps=(patch:Partial<ChartOrderFlowState['settings']>={})=>({
    controller:{getDepthOverlay:()=>undefined,orderFlow:{aggregate:()=>undefined}},
    settings:normalizeOrderFlowSettings({heatmap:true,theme:'cold',...patch}),unitLabel:'BTC',revision:0,locale:'en-US',change:vi.fn()});
  it('keeps the settings behind the terminal gear instead of a toolbar popover',()=>{
    const html=renderTerminal(props(),'en-US');
    expect(html).toContain('aria-controls="orderbook-settings"');expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('id="orderbook-settings"');
  });
  it('renders switches, every theme and the color scale in both languages',()=>{
    const en=renderHeatmapSettings(settingsProps(),'en-US'),zh=renderHeatmapSettings(settingsProps(),'zh-CN');
    expect(text(en)).not.toMatch(/[\u3400-\u9fff]/);
    expect(text(en)).toContain('Depth heatmap');expect(text(en)).toContain('Hover details');expect(text(en)).toContain('Glacier');
    expect(text(zh)).toContain('深度热图');expect(text(zh)).toContain('冰川');
    expect(en.match(/role="switch"/g)).toHaveLength(3);expect(en.match(/checked/g)?.length).toBeGreaterThanOrEqual(1);
    expect(en.match(/class="swatch[ "]/g)).toHaveLength(11);expect(en.match(/role="slider"/g)).toHaveLength(2);
    expect(text(en)).toContain('Waiting for depth data');
  });
  it('dims the rendering controls while every overlay is off',()=>{
    expect(renderHeatmapSettings(settingsProps({heatmap:false,profile:false}),'en-US')).toMatch(/class="render-group[^"]*dormant/);
    expect(renderHeatmapSettings(settingsProps(),'en-US')).not.toContain('dormant');
  });
});
