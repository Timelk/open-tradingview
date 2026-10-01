import {afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {build} from 'esbuild';
import {compile} from 'svelte/compiler';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {PanelOrderBookSubscription,type PanelOrderBookDemand} from '../src/lib/flow/panel-orderbook';
import {createOrderBookHub,type SharedOrderBookLease} from '../src/lib/flow/orderbook-hub';
import {aggregateOrderBook} from '../src/lib/flow/orderbook-models';
import type {OrderBookSocket} from '../src/lib/flow/orderbook';

const identity={source:'binance',marketType:'usdm-perpetual',symbol:'BTCUSDT'};
const demand:PanelOrderBookDemand={...identity,tickSize:.1,active:true,running:true,view:'book',sourceView:'live',historical:false};
const snapshot={lastUpdateId:100,bids:[['100.8','2'],['100.2','3']],asks:[['101.2','2'],['101.8','3']]};
const update=(patch:Record<string,unknown>={})=>({e:'depthUpdate',s:'BTCUSDT',U:99,u:101,pu:98,T:1000,b:[],a:[],...patch});
const response=()=>({ok:true,status:200,json:async()=>snapshot}) as Response;
async function flush(){for(let i=0;i<8;i++)await Promise.resolve();}
class Socket implements OrderBookSocket {
  static instances:Socket[]=[];onopen:((event:Event)=>void)|null=null;onmessage:((event:MessageEvent)=>void)|null=null;onclose:((event:CloseEvent)=>void)|null=null;onerror:((event:Event)=>void)|null=null;
  close=vi.fn();constructor(readonly url:string){Socket.instances.push(this);}
  open(){this.onopen?.({} as Event);}receive(value:unknown){this.onmessage?.({data:JSON.stringify(value)} as MessageEvent);}
}
const dispose:Array<()=>void>=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(1000);Socket.instances=[];});
afterEach(()=>{dispose.splice(0).forEach(fn=>fn());vi.useRealTimers();});
function harness(){
  const request=vi.fn<typeof fetch>().mockResolvedValue(response()),hub=createOrderBookHub({fetch:request,WebSocket:Socket}),changed=vi.fn();
  const panel=new PanelOrderBookSubscription(changed,(market,options)=>hub.acquire(market,options));dispose.push(()=>panel.destroy());
  const terminal=()=>{const lease=hub.acquire(identity);dispose.push(()=>lease.release());return lease;};
  const connect=async(symbol='BTCUSDT')=>{const socket=Socket.instances.at(-1)!;socket.open();socket.receive(update({s:symbol}));await flush();return socket;};
  return {panel,changed,terminal,connect,request,hub};
}

describe('legacy analysis-panel shared book ownership',()=>{
  it('shares the terminal connection and revision, and hiding/reopening the legacy panel never clears the terminal book',async()=>{
    const h=harness(),terminal=h.terminal();h.panel.update(demand);expect(Socket.instances).toHaveLength(1);const socket=await h.connect();
    expect(h.request).toHaveBeenCalledOnce();expect(h.panel.snapshot()?.revision).toBe(terminal.snapshot().revision);
    h.panel.update({...demand,active:false});expect(h.panel.snapshot()).toBeUndefined();expect(socket.close).not.toHaveBeenCalled();
    socket.receive(update({U:102,u:102,pu:101,b:[['100.8','4']]}));expect(terminal.snapshot().revision).toBe(2);expect(h.panel.snapshot()).toBeUndefined();
    h.panel.update(demand);expect(h.panel.snapshot()?.revision).toBe(2);expect(Socket.instances).toHaveLength(1);
    h.panel.destroy();expect(socket.close).not.toHaveBeenCalled();terminal.release();expect(socket.close).toHaveBeenCalledOnce();
  });
  it('pauses only its own lease and presents a real paused/empty state rather than retained live levels',async()=>{
    const h=harness(),terminal=h.terminal();h.panel.update(demand);const socket=await h.connect();
    h.panel.update({...demand,running:false});expect(h.panel.snapshot()).toMatchObject({status:'paused',bids:[],asks:[]});expect(terminal.snapshot().status).toBe('live');expect(socket.close).not.toHaveBeenCalled();
    h.panel.update(demand);expect(h.panel.snapshot()?.status).toBe('live');expect(Socket.instances).toHaveLength(1);
    h.panel.update({...demand,chartPaused:true});expect(h.panel.snapshot()?.status).toBe('paused');expect(terminal.snapshot().status).toBe('live');
  });
  it('releases its lease for other modes, historical archives, zero tick size, and unsupported markets',async()=>{
    const h=harness();h.panel.update(demand);const socket=await h.connect();h.panel.update({...demand,view:'profile'});expect(socket.close).toHaveBeenCalledOnce();
    for(const patch of [{historical:true},{sourceView:'history'},{sourceView:'data'},{tickSize:0},{source:'okx'},{marketType:'spot'},{active:false}]){
      h.panel.update({...demand,...patch});expect(h.panel.snapshot()).toBeUndefined();
    }
    expect(Socket.instances).toHaveLength(1);h.panel.update(demand);expect(Socket.instances).toHaveLength(2);
  });
  it('does not re-acquire on unchanged demand and discards old-market updates after switching symbols',async()=>{
    const h=harness(),terminal=h.terminal();h.panel.update(demand);const btc=await h.connect();
    for(let i=0;i<10;i++)h.panel.update({...demand});expect(Socket.instances).toHaveLength(1);
    h.panel.update({...demand,symbol:'ETHUSDT'});await h.connect('ETHUSDT');expect(h.panel.snapshot()?.symbol).toBe('ETHUSDT');
    btc.receive(update({U:102,u:102,pu:101,b:[['100.8','8']]}));expect(terminal.snapshot().revision).toBe(2);expect(h.panel.snapshot()?.symbol).toBe('ETHUSDT');
  });
  it('delivers stale status and performs one explicit shared reconnect',async()=>{
    const h=harness(),terminal=h.terminal();h.panel.update(demand);await h.connect();await vi.advanceTimersByTimeAsync(5000);
    expect(h.panel.snapshot()).toMatchObject({status:'stale',bids:[],asks:[]});await h.panel.reconnect();expect(Socket.instances).toHaveLength(2);expect(terminal.snapshot().status).toBe('connecting');
    await h.connect();expect(h.panel.snapshot()?.status).toBe('live');expect(h.panel.snapshot()?.revision).toBe(terminal.snapshot().revision);
  });
  it('provides correct bid/ask grouping and source-price quote amounts to the legacy table',async()=>{
    const h=harness();h.panel.update(demand);await h.connect();
    const base=aggregateOrderBook(h.panel.snapshot()!,{priceStep:demand.tickSize*10,unit:'base',limit:30});
    const quote=aggregateOrderBook(h.panel.snapshot()!,{priceStep:demand.tickSize*10,unit:'quote',limit:30});
    expect(base.bids[0]).toMatchObject({price:100,quantity:5});expect(base.asks[0]).toMatchObject({price:102,quantity:5});
    expect(quote.bids[0].quantity).toBeCloseTo(502.2,10);expect(quote.asks[0].quantity).toBeCloseTo(507.8,10);expect(Socket.instances).toHaveLength(1);
  });
});

let renderPanel:(props:unknown,language:string)=>string;
beforeAll(async()=>{
  const directory=resolve('src/components/studies');
  const result=await build({stdin:{contents:"import Panel from './TradeFlowPanel.svelte';import {render} from 'svelte/server';import {locale} from '../../lib/i18n';export const draw=(props,language)=>{locale.set(language);return render(Panel,{props}).body;};",resolveDir:directory},bundle:true,platform:'node',format:'esm',write:false,
    plugins:[{name:'legacy-panel-ssr',setup(builder){builder.onLoad({filter:/\.svelte$/},args=>({contents:compile(readFileSync(args.path,'utf8'),{filename:args.path,generate:'server'}).js.code,loader:'js',resolveDir:dirname(args.path)}));}}]});
  renderPanel=(await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))).draw;
});
it('does not mislabel a non-Binance real source as simulated, in either UI language',()=>{
  const props={context:{chartState:{source:'okx',marketType:'usdm-perpetual',symbol:'BTCUSDT',historicalSnapshot:false,paused:false},controller:{}},active:true,zone:'right',density:'compact',onClose(){}};
  const chinese=renderPanel(props,'zh-CN'),english=renderPanel(props,'en-US');
  expect(chinese).toContain('当前支持 Binance USDT 永续公开深度');expect(chinese).not.toContain('当前为模拟行情');
  expect(english).toContain('Binance USDT perpetuals');expect(english).not.toContain('simulated market');expect(english).not.toMatch(/\p{Script=Han}/u);
  expect(Socket.instances).toHaveLength(0);
});
