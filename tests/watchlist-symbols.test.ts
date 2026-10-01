import {afterEach,expect,it,vi} from 'vitest';
import {DEFAULT_SYMBOLS,fetchPerpetualSymbols,normalizeSymbol,normalizePerpetualSymbol} from '../src/lib/watchlist/symbols';
import {parseBinancePerpetualSymbols} from '../src/lib/market/binance-contracts';
import {futuresSymbol} from './fixtures/binance-contracts';
afterEach(()=>vi.unstubAllGlobals());

it('keeps generic simulation syntax separate from perpetual contract aliases',()=>{
  expect(normalizeSymbol(' btc/usdt ')).toBe('BTCUSDT');expect(normalizeSymbol('ETH-USDT')).toBe('ETHUSDT');expect(normalizeSymbol('ETHBTC')).toBe('ETHBTC');
  for(const value of ['BTCUSDT.P','BTCUSDT_260925','BTCUSD_PERP','BTCUSDT-PERP','BINANCE:BTCUSDT','BTC USDT','','A','<script>'])expect(normalizeSymbol(value)).toBeNull();
  for(const value of [' btc/usdt ','BINANCE:BTCUSDT.P','BTCUSDT.P','btc-usdt'])expect(normalizePerpetualSymbol(value)).toBe('BTCUSDT');
  for(const value of ['ETHBTC','BTCUSDC','BTCUSD_PERP','BTCUSDT_260925','OKX:BTCUSDT.P','USDT','<script>USDT'])expect(normalizePerpetualSymbol(value)).toBeNull();
  expect(normalizePerpetualSymbol('币安人生USDT')).toBe('币安人生USDT');
  expect(DEFAULT_SYMBOLS.map(s=>s.symbol)).toEqual(['BTCUSDT','ETHUSDT','SOLUSDT']);expect(DEFAULT_SYMBOLS.every(s=>s.contractType==='PERPETUAL'&&!s.contract)).toBe(true);
});

it('only returns active USDT margined perpetuals with complete exchange rules',async()=>{
  const valid=futuresSymbol(),eth=futuresSymbol('ETHUSDT');
  const fetch=vi.fn(async(_url:string)=>({ok:true,json:async()=>({symbols:[valid,valid,eth,{...valid,status:'HALT'},{...valid,contractType:'CURRENT_QUARTER'},{...valid,quoteAsset:'USDC'},{...valid,marginAsset:'BTC'},{...valid,symbol:'BTCUSDT.P'},{...valid,filters:valid.filters.slice(0,2)}]})}));vi.stubGlobal('fetch',fetch);
  const result=await fetchPerpetualSymbols();expect(result.map(s=>s.symbol)).toEqual(['BTCUSDT','ETHUSDT']);
  expect(result[0].contract).toMatchObject({marketType:'usdm-perpetual',tickSize:.1,stepSize:.001,minQty:.001,maxQty:1000,marketStepSize:.002,marketMinQty:.002,marketMaxQty:200,minNotional:100,quoteCurrency:'USDT',marginAsset:'USDT'});
  expect(new URL(String(fetch.mock.calls[0][0])).hostname).toBe('fapi.binance.com');expect(String(fetch.mock.calls[0][0])).toContain('/fapi/v1/exchangeInfo');expect(String(fetch.mock.calls[0][0])).not.toContain('permissions=');
});

it('never substitutes pricePrecision or quantityPrecision for exchange filter steps',()=>{
  const symbol=futuresSymbol();expect(parseBinancePerpetualSymbols({symbols:[symbol]})[0].contract).toMatchObject({pricePrecision:5,quantityPrecision:8,tickSize:.1,stepSize:.001});
  symbol.filters[0].tickSize='bad';expect(()=>parseBinancePerpetualSymbols({symbols:[symbol]})).toThrow('完整交易规则');
});

it('excludes unknown or directional position-risk restrictions rather than simulating unrestricted orders',()=>{
  const unrestricted=futuresSymbol('BTCUSDT'),restricted=futuresSymbol('ETHUSDT'),unknown=futuresSymbol('SOLUSDT');
  const symbols=[{...unrestricted,filters:[...unrestricted.filters,{filterType:'POSITION_RISK_CONTROL',positionControlSide:'NONE'}]},{...restricted,filters:[...restricted.filters,{filterType:'POSITION_RISK_CONTROL',positionControlSide:'LONG'}]},{...unknown,filters:[...unknown.filters,{filterType:'POSITION_RISK_CONTROL',positionControlSide:'NEW_MODE'}]}];
  expect(parseBinancePerpetualSymbols({symbols}).map(symbol=>symbol.symbol)).toEqual(['BTCUSDT']);
});

it('surfaces unavailable or malformed directories instead of returning spot or fabricated rules',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce({ok:false,status:451}).mockResolvedValueOnce({ok:true,json:async()=>({symbols:[]})}).mockResolvedValueOnce({ok:true,json:async()=>({error:'bad'})});vi.stubGlobal('fetch',fetch);
  await expect(fetchPerpetualSymbols()).rejects.toThrow('451');await expect(fetchPerpetualSymbols()).rejects.toThrow('未返回');await expect(fetchPerpetualSymbols()).rejects.toThrow('格式');
});

it('passes cancellation to the public futures directory without private headers',async()=>{
  const controller=new AbortController();controller.abort();const fetch=vi.fn((_url:string,options:{signal:AbortSignal})=>{expect(options.signal.aborted).toBe(true);expect(options).not.toHaveProperty('headers');return Promise.reject(new DOMException('aborted','AbortError'));});vi.stubGlobal('fetch',fetch);
  await expect(fetchPerpetualSymbols(controller.signal)).rejects.toMatchObject({name:'AbortError'});
});
