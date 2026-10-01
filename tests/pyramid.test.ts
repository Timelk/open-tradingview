import { describe, expect, it } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';
import { Pyramid } from '../src/lib/core/pyramid';

function seedStore(n: number): ColumnStore {
  const s = new ColumnStore(n);
  for (let i = 0; i < n; i++) {
    s.appendBar({
      time: 1000 + i * 60_000,
      open: 10 + i,
      high: 12 + i,
      low: 9 + i,
      close: 11 + i,
      volume: 100 + i * 10,
    });
  }
  return s;
}

describe('Pyramid', () => {
  it('4 根聚 1 的 OHLCV 规则正确', () => {
    const p = new Pyramid(seedStore(16), [1, 4]);
    const l1 = p.aggLevel(4)!;
    expect(l1.length).toBe(4);
    // 第 0 组: open=首open=10, high=max(12..15)=15, low=min(9..12)=9, close=尾close=14, volume=100+110+120+130=460
    expect(l1.open[0]).toBe(10);
    expect(l1.high[0]).toBe(15);
    expect(l1.low[0]).toBe(9);
    expect(l1.close[0]).toBe(14);
    expect(l1.volume[0]).toBe(460);
    expect(l1.time[0]).toBe(1000);
    expect(l1.close[3]).toBe(11 + 15);
  });

  it('updateRange 只重算受影响段', () => {
    const s = seedStore(16);
    const p = new Pyramid(s, [1, 4]);
    s.updateLast({ time: 1000 + 15 * 60_000, open: 25, high: 99, low: 9 + 15, close: 26, volume: 250 });
    p.updateRange(15, 16);
    const l1 = p.aggLevel(4)!;
    expect(l1.high[3]).toBe(99); // 第3组被更新
    expect(l1.high[0]).toBe(15); // 第0组不受影响
  });

  it('pickLevel 按每像素根数选层', () => {
    const p = new Pyramid(seedStore(64), [1, 4, 16]);
    expect(p.pickLevel(0.5).factor).toBe(1); // 放大：原始
    expect(p.pickLevel(3).factor).toBe(1); // 4 根才够一组，不足用原始
    expect(p.pickLevel(4).factor).toBe(4);
    expect(p.pickLevel(100).factor).toBe(16); // 取最粗
  });
});
