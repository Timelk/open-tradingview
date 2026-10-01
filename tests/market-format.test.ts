import {describe,it,expect} from 'vitest';
import {formatMarketPrice,marketPriceDigits,formatSeriesValue} from '../src/lib/core/market-format';
import {niceTicks,priceDigits,fmtPrice} from '../src/lib/render/axes';
import {mockSeedForSymbol} from '../src/lib/feed/mock-feed';

describe('prices across a broad spot-symbol directory',()=>{
  it('retains meaningful low-price digits in prices and price-axis labels',()=>{
    expect(formatMarketPrice(79580.58)).toBe('79,580.58');
    expect(formatMarketPrice(1.4106)).toBe('1.4106');
    expect(formatMarketPrice(.000003617)).toBe('0.000003617');
    expect(formatMarketPrice(.000000000123)).toBe('0.000000000123');
    expect(formatMarketPrice(NaN)).toBe('—');
    const digits=priceDigits(.0000035,.0000038);
    expect(digits).toBeGreaterThanOrEqual(8);
    expect(fmtPrice(.0000036,digits)).not.toMatch(/^0\.0+$/);
    expect(marketPriceDigits(0)).toBe(2);
  });
  it('does not generate thousands of out-of-range ticks for tiny prices',()=>{
    const ticks=niceTicks(1e-14,2e-14,8);
    expect(ticks.length).toBeGreaterThan(1);expect(ticks.length).toBeLessThan(20);
    expect(ticks.every(v=>v>=1e-14&&v<=2e-14)).toBe(true);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(niceTicks(100,200,5)).toEqual([100,150,200]);
  });
  it('shows small-price MA/MACD readings while keeping oscillator precision readable',()=>{
    expect(formatSeriesValue(.000003562,true)).toBe('0.000003562');
    expect(formatSeriesValue(-.00000000215)).toBe('-0.00000000215');
    expect(formatSeriesValue(51.12345)).toBe('51.12');
    expect(formatSeriesValue(1.4106,true)).toBe('1.4106');
  });
  it('preserves existing mock histories and gives other symbols stable distinct seeds',()=>{
    expect(mockSeedForSymbol('BTCUSDT')).toBe(20260904);
    expect(mockSeedForSymbol('ETHUSDT')).toBe(20260905);
    expect(mockSeedForSymbol('SOLUSDT')).toBe(20260906);
    expect(mockSeedForSymbol('XRPUSDT')).toBe(mockSeedForSymbol('XRPUSDT'));
    expect(mockSeedForSymbol('XRPUSDT')).not.toBe(mockSeedForSymbol('PEPEUSDT'));
  });
});
