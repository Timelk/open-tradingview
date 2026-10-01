import {describe,it,expect} from 'vitest';
import {datasetFingerprint} from '../src/lib/history/datasets';
import {marketIdentity} from '../src/lib/market/identity';
import type {DatasetSnapshot} from '../src/lib/history/types';
const sample:DatasetSnapshot={source:'binance',symbol:'BTCUSDT',interval:'1m',bars:[{time:60000,open:100,high:101,low:99,close:100,volume:10}],tickSize:.1,quoteCurrency:'USDT'};
describe('spot and perpetual calculation provenance',()=>{
  it('treats untagged historical Binance records as spot and gives futures a distinct identity',async()=>{
    const spot={...sample,marketType:'spot' as const},futures={...sample,marketType:'usdm-perpetual' as const};
    expect(marketIdentity(sample)).toBe(marketIdentity(spot));expect(marketIdentity(futures)).not.toBe(marketIdentity(spot));
    expect(await datasetFingerprint(spot)).not.toBe(await datasetFingerprint(futures));
  });
  it('includes independent mark price inputs in the immutable dataset fingerprint',async()=>{
    const first={...sample,marketType:'usdm-perpetual' as const,markPrices:[{time:60000,close:100}]};
    const corrected={...first,markPrices:[{time:60000,close:100.1}]};
    expect(await datasetFingerprint(first)).not.toBe(await datasetFingerprint(corrected));
  });
});
