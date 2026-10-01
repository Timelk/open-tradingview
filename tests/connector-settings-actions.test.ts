import {afterEach,describe,it,expect,vi} from 'vitest';
import {ConnectorConfigStore,connectorConfigStore,DEFAULT_CONNECTOR_CONFIGS,type ConnectorUserConfig} from '../src/lib/market/connector-config';
import {probeConnectorDraft,type ConnectorProbeFeed} from '../src/lib/market/connector-probe';
import {chartConnectionPresentation} from '../src/lib/chart/status-presentation';
import type {ChartState} from '../src/lib/chart/controller';

afterEach(()=>vi.unstubAllGlobals());
const valid={time:1,open:100,high:103,low:99,close:102,volume:3};
function reader(load=async()=>[valid]):ConnectorProbeFeed {
  return {name:'test',loadBulk:vi.fn(load),connect:vi.fn(),disconnect:vi.fn(),onBar:vi.fn(),onStatus:vi.fn()};
}
function localStorage(fails=false){
  const data=new Map<string,string>(),storage={getItem:vi.fn((key:string)=>data.get(key)??null),setItem:vi.fn((key:string,value:string)=>{if(fails)throw Error('quota');data.set(key,value);})};
  vi.stubGlobal('localStorage',storage);return storage;
}

describe('connection test and explicit apply are isolated',()=>{
  it('tests a draft without saving, notifying configuration listeners or connecting a live feed',async()=>{
    const storage=localStorage(),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const before=JSON.stringify(connectorConfigStore.list()),notify=vi.fn(),off=connectorConfigStore.subscribe(notify),feed=reader(),factory=vi.fn((_draft:ConnectorUserConfig)=>feed);
    const result=await probeConnectorDraft({...DEFAULT_CONNECTOR_CONFIGS['cn-a'],restBase:'https://draft.example',mode:'auto'}, {createFeed:factory});
    expect(factory.mock.calls[0][0]).toMatchObject({restBase:'https://draft.example',mode:'live'});
    expect(result).toMatchObject({kind:'history',bars:1,lastClose:102});
    expect(feed.connect).not.toHaveBeenCalled();expect(feed.disconnect).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);expect(storage.setItem).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(connectorConfigStore.list())).toBe(before);off();
  });

  it('uses the draft endpoint in a real built-in REST reader and issues no persistence request',async()=>{
    const storage=localStorage(),fetcher=vi.fn(async(_url:RequestInfo|URL)=>new Response(JSON.stringify({data:[['1','100','103','99','102','3']]})));
    vi.stubGlobal('fetch',fetcher);
    const result=await probeConnectorDraft({...DEFAULT_CONNECTOR_CONFIGS.okx,restBase:'https://draft.example',defaultSymbol:'ETHUSDT'});
    expect(result.kind).toBe('history');expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain('https://draft.example/api/v5/market/candles?instId=ETH-USDT-SWAP');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('never presents simulation as a successful remote connection',async()=>{
    const createFeed=vi.fn(()=>reader());
    expect(await probeConnectorDraft({...DEFAULT_CONNECTOR_CONFIGS.okx,mode:'simulation'},{createFeed})).toEqual({kind:'simulation',bars:0,elapsedMs:0});
    expect(createFeed).not.toHaveBeenCalled();
  });

  it('disconnects failed/invalid readers and propagates cancellation instead of reporting success',async()=>{
    const bad=reader(async()=>[]);await expect(probeConnectorDraft(DEFAULT_CONNECTOR_CONFIGS.okx,{createFeed:()=>bad})).rejects.toThrow();
    expect(bad.disconnect).toHaveBeenCalledTimes(1);
    let resolve!:(value:typeof valid[])=>void;const pending=reader(()=>new Promise(done=>resolve=done)),aborter=new AbortController();
    const promise=probeConnectorDraft(DEFAULT_CONNECTOR_CONFIGS.okx,{createFeed:()=>pending,signal:aborter.signal});
    aborter.abort();resolve([valid]);await expect(promise).rejects.toMatchObject({name:'AbortError'});
    expect(pending.disconnect).toHaveBeenCalled();
  });
});

describe('truthful persistence receipts',()=>{
  it('only confirms both storage targets after each succeeds',async()=>{
    const storage=localStorage(),store=new ConnectorConfigStore(),notify=vi.fn();store.subscribe(notify);
    const request=vi.fn(async()=>new Response(JSON.stringify({sources:[{source:'okx',count:8,updatedAt:10}]})));
    const result=await store.save('okx',{defaultSymbol:'ETHUSDT'},request);
    expect(result).toMatchObject({browserSaved:true,serverSaved:true,config:{defaultSymbol:'ETHUSDT'}});
    expect(storage.setItem).toHaveBeenCalledTimes(1);expect(request).toHaveBeenCalledTimes(1);expect(notify).toHaveBeenCalledTimes(2);
  });
  it('reports a local service failure without discarding the browser settings',async()=>{
    localStorage();const store=new ConnectorConfigStore();
    const result=await store.save('okx',{defaultSymbol:'SOLUSDT'},async()=>new Response('{}',{status:503}));
    expect(result).toMatchObject({browserSaved:true,serverSaved:false,sources:[]});expect(store.get('okx').defaultSymbol).toBe('SOLUSDT');
  });
  it('does not claim browser persistence when storage is unavailable',async()=>{
    localStorage(true);const result=await new ConnectorConfigStore().save('okx',{defaultSymbol:'SOLUSDT'},async()=>new Response(JSON.stringify({sources:[]})));
    expect(result).toMatchObject({browserSaved:false,serverSaved:true});
  });
});

describe('compact chart connection states',()=>{
  const state={source:'cn-a',loading:false,status:'ok',paused:false,historicalSnapshot:false,analysisReplay:false} as ChartState;
  it('labels historical and simulation data explicitly and does not claim auto fallback is live',()=>{
    expect(chartConnectionPresentation({...state,historicalSnapshot:true,paused:true},'live').badge).toBe('历史');
    expect(chartConnectionPresentation(state,'simulation').badge).toBe('模拟');
    expect(chartConnectionPresentation(state,'auto').badge).toBe('自动模式');
    expect(chartConnectionPresentation({...state,source:'binance'},'live').badge).toBe('实时');
  });
  it('keeps connection errors and pending initialization distinct from normal live operation',()=>{
    expect(chartConnectionPresentation({...state,status:'error'},'live').tone).toBe('error');
    expect(chartConnectionPresentation({...state,loading:true},'live').tone).toBe('waiting');
    expect(chartConnectionPresentation({...state,paused:true},'live').badge).toBe('已暂停');
  });
});
