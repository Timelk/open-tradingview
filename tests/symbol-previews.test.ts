import {describe,expect,it,vi} from 'vitest';
import {SymbolPreviewStore,parseGatewayBars,formatPreviewPrice,formatPreviewVolume,parseBinanceTickers,parseOkxTickers,quoteFromSpark,sparkFromRows,SPARK_BARS} from '../src/lib/market/symbol-previews';
import type {MarketSymbol} from '../src/lib/watchlist/types';

const sym=(symbol:string,source='binance',base=symbol.replace(/USDT$/,''),quote='USDT'):MarketSymbol=>({symbol,baseAsset:base,quoteAsset:quote,source} as MarketSymbol);
const json=(body:unknown)=>Promise.resolve(new Response(JSON.stringify(body),{status:200}));

describe('symbol preview parsing',()=>{
  it('parses Binance and OKX bulk tickers, skipping invalid rows',()=>{
    const binance=parseBinanceTickers([{symbol:'BTCUSDT',lastPrice:'100',priceChangePercent:'-1.5',highPrice:'110',lowPrice:'90',volume:'5',quoteVolume:'500'},{symbol:'BAD',lastPrice:'0',priceChangePercent:'1'},{lastPrice:'1'}]);
    expect([...binance.keys()]).toEqual(['BTCUSDT']);expect(binance.get('BTCUSDT')).toMatchObject({last:100,changePercent:-1.5,high:110,low:90});
    const okx=parseOkxTickers({data:[{instId:'ETH-USDT-SWAP',last:'110',open24h:'100',high24h:'120',low24h:'95'},{instId:'ETH-USDT',last:'1',open24h:'1'},{instId:'X-USDT-SWAP',last:'1',open24h:'0'}]});
    expect([...okx.keys()]).toEqual(['ETHUSDT']);expect(okx.get('ETHUSDT')!.changePercent).toBeCloseTo(10);
  });
  it('builds a time-ascending, bounded sparkline and derives a 24h quote from it',()=>{
    const rows=Array.from({length:120},(_,i)=>[String(1000-i),'0','0','0',String(10+i)]);
    const spark=sparkFromRows(rows,0,4)!;
    expect(spark.closes).toHaveLength(SPARK_BARS);expect(spark.from).toBeLessThan(spark.to);
    expect(spark.closes.at(-1)).toBe(10);// newest time (1000) has close 10
    const coinbase=sparkFromRows([[2,0,0,0,5],[1,0,0,0,4]],0,4,1000)!;expect(coinbase).toEqual({closes:[4,5],from:1000,to:2000});
    expect(sparkFromRows([[1,0,0,0,5]],0,4)).toBeUndefined();expect(sparkFromRows('x',0,4)).toBeUndefined();
    expect(quoteFromSpark({closes:[100,90,120,110],from:0,to:1})).toEqual({last:110,changePercent:10.000000000000009,high:120,low:90});
  });
  it('reads A-share daily gateway bars: 30-session spark, change vs previous close',()=>{
    const bars=Array.from({length:30},(_,i)=>({time:(30-i)*86_400_000,open:100,high:105+i,low:95,close:100+i,volume:1000+i}));
    const {spark,quote}=parseGatewayBars({bars});
    expect(spark!.closes).toHaveLength(30);expect(spark!.closes[0]).toBe(129);expect(spark!.closes.at(-1)).toBe(100);
    expect(quote).toMatchObject({last:100,high:105,low:95,volume:1000});expect(quote!.changePercent).toBeCloseTo((100/101-1)*100);
    expect(parseGatewayBars({})).toEqual({});
  });
  it('formats prices by magnitude and volumes compactly',()=>{
    expect(formatPreviewPrice(82345.678,'en-US')).toBe('82,345.68');expect(formatPreviewPrice(1.23456,'en-US')).toBe('1.2346');
    expect(formatPreviewPrice(0.00001234,'en-US')).toMatch(/^0\.0000123/);expect(formatPreviewPrice(undefined)).toBe('—');
    expect(formatPreviewVolume(1_234_567)).toBe('1.23M');expect(formatPreviewVolume(950)).toBe('950');
  });
});

describe('SymbolPreviewStore',()=>{
  it('requests each bulk ticker once per TTL, dedupes sparks and notifies subscribers',async()=>{
    let now=0;const fetcher=vi.fn((url:string)=>url.includes('ticker/24hr')?json([{symbol:'BTCUSDT',lastPrice:'100',priceChangePercent:'2'}]):json([[1,0,0,0,'1'],[2,0,0,0,'2']]));
    const store=new SymbolPreviewStore(fetcher,()=>now),listener=vi.fn();store.subscribe(listener);
    const btc=sym('BTCUSDT');store.request([btc,btc]);store.request([btc]);
    await vi.waitFor(()=>expect(store.get(btc).spark).toBeDefined());
    expect(fetcher).toHaveBeenCalledTimes(2);expect(store.get(btc).quote).toMatchObject({last:100,changePercent:2});expect(listener).toHaveBeenCalled();
    now=10_000;store.request([btc]);expect(fetcher).toHaveBeenCalledTimes(2);
    now=200_000;store.request([btc]);await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(4));
  });
  it('bounds parallel spark requests and derives quotes where no bulk ticker exists',async()=>{
    let active=0,peak=0;const release:Array<()=>void>=[];
    const fetcher=vi.fn((url:string)=>{if(url.includes('/candles'))return new Promise<Response>(resolve=>{active++;peak=Math.max(peak,active);release.push(()=>{active--;resolve(new Response(JSON.stringify([[1,0,0,0,10],[2,0,0,0,11]])));});});return json([]);});
    const store=new SymbolPreviewStore(fetcher),items=Array.from({length:9},(_,i)=>sym(`C${i}-USD`,'coinbase',`C${i}`,'USD'));
    store.request(items);await Promise.resolve();
    expect(peak).toBe(4);
    while(release.length||active){release.shift()?.();await new Promise(r=>setTimeout(r,0));}
    await vi.waitFor(()=>expect(items.every(item=>store.get(item).spark)).toBe(true));
    expect(peak).toBe(4);expect(store.get(items[0]).quote!.changePercent).toBeCloseTo(10);
    // Coinbase has no bulk ticker endpoint: only candle requests were issued.
    expect(fetcher.mock.calls.every(([url])=>String(url).includes('/candles'))).toBe(true);
  });
  it('keeps working after failures and never requests unsupported sources',async()=>{
    const fetcher=vi.fn(()=>Promise.resolve(new Response('no',{status:500})));const store=new SymbolPreviewStore(fetcher);
    store.request([sym('BTCUSDT','mock')]);expect(fetcher).not.toHaveBeenCalled();
    const btc=sym('BTCUSDT');store.request([btc]);await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
    await new Promise(r=>setTimeout(r,0));expect(store.get(btc)).toEqual({quote:undefined,spark:undefined,span:'24h'});
  });
});
