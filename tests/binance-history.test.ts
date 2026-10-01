import {describe,it,expect,vi} from 'vitest';
import {BinanceHistoryService} from '../src/lib/history/binance-history';
import {MemoryDatasetPersistence} from '../src/lib/history/persistence';
import {futuresInfo} from './fixtures/binance-contracts';
import {validateDatasetBars} from '../src/lib/history/datasets';
const base=Date.UTC(2025,0,1),step=60000;
const row=(index:number)=>[base+index*step,'10','12','9','11','100',base+(index+1)*step-1];
function requestFor(rows:unknown[][]){return vi.fn(async(input:RequestInfo|URL)=>{
  const url=new URL(String(input));let body:unknown;
  if(url.pathname.endsWith('/time'))body={serverTime:base+2000*step};
  else if(url.pathname.endsWith('/exchangeInfo'))body=futuresInfo();
  else body=rows.filter(row=>Number(row[0])>=Number(url.searchParams.get('startTime'))&&Number(row[0])<=Number(url.searchParams.get('endTime'))).slice(0,1000).map(row=>url.pathname.endsWith('/markPriceKlines')?[...row.slice(0,4),'11.5',...row.slice(5)]:row);
  return new Response(JSON.stringify(body),{status:200});
}) as unknown as typeof fetch;}
describe('Binance range snapshots',()=>{
  it('pages beyond the current 1000 candles and caches an immutable range',async()=>{
    const fetcher=requestFor(Array.from({length:1005},(_,i)=>row(i))),storage=new MemoryDatasetPersistence(),service=new BinanceHistoryService(storage,fetcher);
    const result=await service.load({symbol:'BTCUSDT',interval:'1m',from:base,to:base+1005*step});
    expect(result.bars).toHaveLength(1005);expect(result.tickSize).toBe(.1);expect(result.marketType).toBe('usdm-perpetual');expect(result.contract?.minNotional).toBe(100);expect(result.markPrices?.[0]).toEqual({time:base,close:11.5});expect(result.id).toHaveLength(64);
    const count=vi.mocked(fetcher).mock.calls.length;expect(count).toBe(6);
    expect((await service.load({symbol:'BTCUSDT',interval:'1m',from:base,to:base+1005*step})).id).toBe(result.id);expect(vi.mocked(fetcher).mock.calls.length).toBe(count);
    expect(vi.mocked(fetcher).mock.calls.every(call=>new URL(String(call[0])).hostname==='fapi.binance.com'&&new URL(String(call[0])).pathname.startsWith('/fapi/v1/'))).toBe(true);
  });
  it('retains spot cache bytes while fetching a separate perpetual snapshot',async()=>{
    const storage=new MemoryDatasetPersistence(),key=`binance:BTCUSDT:1m:${base}:${base+5*step}`,old={source:'binance',marketType:'spot',symbol:'BTCUSDT',interval:'1m',bars:[{time:base,open:1,high:1,low:1,close:1,volume:1}]};
    await storage.put('datasets',key,old);const fetcher=requestFor(Array.from({length:5},(_,i)=>row(i))),result=await new BinanceHistoryService(storage,fetcher).load({symbol:'BTCUSDT',interval:'1m',from:base,to:base+5*step});
    expect(result.marketType).toBe('usdm-perpetual');expect(result.bars[0].close).toBe(11);expect(await storage.get('datasets',key)).toEqual(old);expect(fetcher).toHaveBeenCalled();
  });
  it('does not permit incomplete contract rules to become a runnable contract dataset',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({symbols:[{symbol:'BTCUSDT',quoteAsset:'USDT',isSpotTradingAllowed:true,status:'TRADING'}]})));
    await expect(new BinanceHistoryService(undefined,fetcher).load({symbol:'BTCUSDT',interval:'1m',from:base,to:base+5*step})).rejects.toThrow('完整交易规则');expect(fetcher).toHaveBeenCalledOnce();
  });
  it('requires mark price coverage and never substitutes the trade close for a missing mark',async()=>{
    const bars=[{time:base,open:10,high:12,low:9,close:11,volume:1},{time:base+step,open:10,high:12,low:9,close:11,volume:1}];
    const fetcher=vi.fn(async()=>new Response(JSON.stringify([row(0)])));
    await expect(new BinanceHistoryService(undefined,fetcher).loadMarkPrices({symbol:'BTCUSDT',interval:'1m',bars})).rejects.toThrow(/重复|缺失/);
  });
  it('rejects gaps and incomplete requested dates instead of inventing flat candles',async()=>{
    const rows=Array.from({length:8},(_,i)=>row(i));rows.splice(3,1);
    await expect(new BinanceHistoryService(undefined,requestFor(rows)).load({symbol:'BTCUSDT',interval:'1m',from:base,to:base+8*step})).rejects.toThrow('缺口');
    await expect(new BinanceHistoryService(undefined,requestFor([row(4),row(5)])).load({symbol:'BTCUSDT',interval:'1m',from:base,to:base+6*step})).rejects.toThrow('覆盖不完整');
  });
  it('enforces a bound before network work and honours cancellation',async()=>{
    const fetcher=requestFor([]),service=new BinanceHistoryService(undefined,fetcher);
    await expect(service.load({symbol:'BTCUSDT',interval:'1m',from:base,to:base+50001*step})).rejects.toThrow('20,000');expect(fetcher).not.toHaveBeenCalled();
    const controller=new AbortController();controller.abort();
    await expect(service.load({symbol:'BTCUSDT',interval:'1m',from:base,to:base+10*step,signal:controller.signal})).rejects.toThrow();
  });
  it('rejects impossible prices and repeated timestamps',()=>{
    const valid={time:base,open:10,high:12,low:9,close:11,volume:1};
    expect(()=>validateDatasetBars([valid,{...valid}],step)).toThrow('重复');
    expect(()=>validateDatasetBars([{...valid,high:5}],step)).toThrow('无效');
  });
});
