/** Deterministic public exchangeInfo fixture; these are test rules, not live quotes. */
export const futuresSymbol=(symbol='BTCUSDT')=>({
  symbol,pair:symbol,baseAsset:symbol.replace(/USDT$/,''),quoteAsset:'USDT',marginAsset:'USDT',contractType:'PERPETUAL',status:'TRADING',pricePrecision:5,quantityPrecision:8,onboardDate:1569398400000,
  filters:[{filterType:'PRICE_FILTER',minPrice:'0.10',maxPrice:'1000000',tickSize:'0.10'},{filterType:'LOT_SIZE',minQty:'0.001',maxQty:'1000',stepSize:'0.001'},{filterType:'MARKET_LOT_SIZE',minQty:'0.002',maxQty:'200',stepSize:'0.002'},{filterType:'MIN_NOTIONAL',notional:'100'}],
});
export const futuresInfo=(symbols=['BTCUSDT','ETHUSDT','SOLUSDT'])=>({timezone:'UTC',symbols:symbols.map(futuresSymbol)});
