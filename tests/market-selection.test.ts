import {describe,it,expect} from 'vitest';
import {
  DEFAULT_FAVORITE_INTERVALS,
  FAVORITE_INTERVALS_KEY,
  loadFavoriteIntervals,
  loadMarketSelection,
  MARKET_SELECTION_KEY,
  saveMarketSelection,
  toggleFavoriteInterval,
  toolbarIntervals,
} from '../src/lib/chart/market-selection';
import {nextOpenTime,toBinanceInterval} from '../src/lib/feed/binance-feed';
import {validateDatasetBars} from '../src/lib/history/datasets';
import {
  CnAShareFeed,
  coerceConnectorSymbol,
  getMarketConnector,
  marketConnectors,
  normalizeCnAShareSymbol,
  normalizeCoinbaseSymbol,
  normalizeOkxSwapSymbol,
  toOkxBar,
  toOkxSwapInstId,
  type MarketConnector,
} from '../src/lib/market/connectors';
import {MockFeed} from '../src/lib/feed/mock-feed';
import {TIMEFRAMES} from '../src/lib/scene/types';
describe('the current chart selection',()=>{
  it('remembers the chosen perpetual symbol, source and interval independently of its scene',()=>{
    const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
    saveMarketSelection({source:'binance',symbol:'xrp/usdt',interval:'30m'},storage);
    expect(loadMarketSelection(storage)).toEqual({source:'binance',symbol:'XRPUSDT',interval:'30m'});
    expect([...values.keys()]).toEqual([MARKET_SELECTION_KEY]);
  });
  it.each(['{broken',JSON.stringify({source:'binance',symbol:'BTCUSDC',interval:'1m'}),JSON.stringify({source:'binance',symbol:'BTCUSDT',interval:'bad'})])('falls back safely for corrupt or unsupported saved selections',raw=>{
    expect(loadMarketSelection({getItem:()=>raw,setItem:()=>{}})).toEqual({source:'binance',symbol:'BTCUSDT',interval:'15m'});
  });
  it('accepts perpetual notation without reusing an old spot selection',()=>{
    expect(loadMarketSelection({getItem:()=>JSON.stringify({source:'binance',symbol:'BINANCE:BTCUSDT.P',interval:'4h'}),setItem:()=>{}})).toEqual({source:'binance',symbol:'BTCUSDT',interval:'4h'});
    const oldOnly={getItem:(key:string)=>key==='tvchart.market-selection.v1'?JSON.stringify({source:'binance',symbol:'ETHUSDT',interval:'1d'}):null,setItem:()=>{}};
    expect(loadMarketSelection(oldOnly)).toEqual({source:'binance',symbol:'BTCUSDT',interval:'15m'});
  });
  it('does not block navigation when browser storage is denied',()=>{
    const denied={getItem:():string=>{throw Error('denied');},setItem:()=>{throw Error('denied');}};
    expect(()=>saveMarketSelection({source:'binance',symbol:'PEPEUSDT',interval:'1h'},denied)).not.toThrow();
    expect(loadMarketSelection(denied).symbol).toBe('BTCUSDT');
  });
  it('supports 30m, 7d, and 30d intervals with TradingView-style favorite interval ordering',()=>{
    const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
    const defaults=loadFavoriteIntervals(storage);
    expect(defaults).toEqual(DEFAULT_FAVORITE_INTERVALS);
    expect(defaults).toContain('30m');
    expect(defaults).toContain('7d');
    expect(defaults).toContain('30d');
    const with2h=toggleFavoriteInterval(defaults,'2h',storage);
    expect(with2h).toContain('2h');
    expect(with2h.indexOf('1h')).toBeLessThan(with2h.indexOf('2h'));
    expect(with2h.indexOf('2h')).toBeLessThan(with2h.indexOf('4h'));
    expect(values.get(FAVORITE_INTERVALS_KEY)).toBe(JSON.stringify(with2h));
    const without30m=toggleFavoriteInterval(with2h,'30m',storage);
    expect(without30m).not.toContain('30m');
    expect(toolbarIntervals(without30m,'30m')).toContain('30m');
  });
  it('maps 7d and 30d to Binance wire intervals 1w and 1M and validates calendar-month steps',()=>{
    expect(toBinanceInterval('30m')).toBe('30m');
    expect(toBinanceInterval('7d')).toBe('1w');
    expect(toBinanceInterval('30d')).toBe('1M');
    const jan=Date.UTC(2026,0,1),feb=Date.UTC(2026,1,1),mar=Date.UTC(2026,2,1);
    expect(nextOpenTime(jan,'30d')).toBe(feb);
    expect(nextOpenTime(feb,'30d')).toBe(mar);
    expect(()=>validateDatasetBars([
      {time:jan,open:100,high:110,low:95,close:105,volume:10},
      {time:feb,open:105,high:115,low:100,close:112,volume:12},
      {time:mar,open:112,high:120,low:108,close:118,volume:14},
    ],TIMEFRAMES['30d'])).not.toThrow();
  });
  it('normalizes symbols and coerces cross-market switching across Binance, OKX, Coinbase, and China A-Shares',()=>{
    expect(normalizeOkxSwapSymbol('OKX:SOL-USDT-SWAP')).toBe('SOLUSDT');
    expect(toOkxSwapInstId('SOLUSDT')).toBe('SOL-USDT-SWAP');
    expect(toOkxBar('1h')).toBe('1H');
    expect(toOkxBar('1d')).toBe('1Dutc');

    expect(normalizeCoinbaseSymbol('BTCUSDT')).toBe('BTC-USD');
    expect(normalizeCoinbaseSymbol('COINBASE:eth/usd')).toBe('ETH-USD');

    expect(normalizeCnAShareSymbol('600519')).toBe('600519.SH');
    expect(normalizeCnAShareSymbol('sz300750')).toBe('300750.SZ');
    expect(normalizeCnAShareSymbol('830799')).toBe('830799.BJ');
    expect(normalizeCnAShareSymbol('BTCUSDT')).toBeNull();

    // Switching from crypto to A-shares coerces BTCUSDT to A-share default symbol 600519.SH
    expect(coerceConnectorSymbol('cn-a','BTCUSDT')).toBe('600519.SH');
    // Switching from A-shares back to Coinbase coerces 600519.SH to BTC-USD
    expect(coerceConnectorSymbol('coinbase','600519.SH')).toBe('BTC-USD');
    // Switching from Coinbase BTC-USD to OKX preserves BTC as BTCUSDT
    expect(coerceConnectorSymbol('okx','BTC-USD')).toBe('BTCUSDT');

    const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
    saveMarketSelection({source:'cn-a',symbol:'300750',interval:'1d'},storage);
    expect(loadMarketSelection(storage)).toEqual({source:'cn-a',symbol:'300750.SZ',interval:'1d'});
  });
  it('supports registering custom market connectors and A-Share session/lot rules without core modifications',()=>{
    const cnConnector=getMarketConnector('cn-a')!;
    expect(cnConnector).toBeDefined();
    expect(cnConnector.session.timezone).toBe('Asia/Shanghai');
    expect(cnConnector.session.settlementRule).toBe('T+1');
    expect(cnConnector.session.lotSize).toBe(100);
    expect(cnConnector.session.priceLimitRatio).toBe(0.1);

    const cnFeed=new CnAShareFeed({symbol:'600519.SH',interval:'15m'});
    const bars=cnFeed.loadBulk();
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every(bar=>bar.volume%100===0&&bar.low>0)).toBe(true);

    const customConnector:MarketConnector={
      id:'hk-eq',
      label:'港股 · HKEX',
      shortLabel:'HKEX',
      badge:'HKEX · 港股主板',
      connectedLabel:'HKEX 已连接',
      errorPrefix:'HKEX 行情连接失败',
      assetClass:'equity',
      marketType:'hk-equity',
      defaultSymbol:'00700.HK',
      defaultQuoteCurrency:'HKD',
      defaultSymbols:[{symbol:'00700.HK',baseAsset:'00700',quoteAsset:'HKD',name:'腾讯控股'}],
      session:{
        timezone:'Asia/Hong_Kong',
        continuous24x7:false,
        sessions:[{open:'09:30',close:'12:00'},{open:'13:00',close:'16:00'}],
        settlementRule:'T+0',
        lotSize:100,
      },
      capabilities:{
        supportsPause:true,
        supportsHistoricalBackfill:false,
        supportsDateRangeHistory:false,
        supportsContractRules:false,
        supportsMarkPriceValidation:false,
        supportsFundingRate:false,
        supportsLiveTradeFlow:false,
      },
      normalizeSymbol:raw=>{
        const m=raw.trim().toUpperCase().match(/^(\d{5})(?:\.HK)?$/);
        return m?`${m[1]}.HK`:null;
      },
      createFeed:()=>new MockFeed({count:100,intervalMs:60_000}),
    };
    marketConnectors.register(customConnector);
    try {
      expect(marketConnectors.has('hk-eq')).toBe(true);
      expect(coerceConnectorSymbol('hk-eq','700')).toBe('00700.HK');
      expect(coerceConnectorSymbol('hk-eq','09988.HK')).toBe('09988.HK');
    } finally {
      marketConnectors.unregister('hk-eq');
    }
    expect(marketConnectors.has('hk-eq')).toBe(false);
  });
});
