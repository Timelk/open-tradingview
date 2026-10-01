import { describe, expect, it } from 'vitest';
import { ColumnStore } from '../src/lib/core/datastore';

const bar = (t: number, o: number) => ({
  time: t,
  open: o,
  high: o + 2,
  low: o - 1,
  close: o + 1,
  volume: 100 + t,
});

describe('ColumnStore', () => {
  it('追加 3 根后长度与列视图正确', () => {
    const s = new ColumnStore(8);
    s.appendBar(bar(1000, 10));
    s.appendBar(bar(2000, 11));
    s.appendBar(bar(3000, 12));
    expect(s.length).toBe(3);
    expect(Array.from(s.col('close').subarray(0, 3))).toEqual([11, 12, 13]);
    expect(s.timeAt(1)).toBe(2000);
  });

  it('updateLast 只改最后一根且长度不变', () => {
    const s = new ColumnStore(8);
    s.appendBar(bar(1000, 10));
    s.appendBar(bar(2000, 11));
    s.updateLast({ ...bar(2000, 11), close: 99, high: 100 });
    expect(s.length).toBe(2);
    expect(s.col('close')[1]).toBe(99);
    expect(s.col('high')[1]).toBe(100);
    expect(s.timeAt(1)).toBe(2000);
  });

  it('超容量自动指数扩容且数据不丢', () => {
    const s = new ColumnStore(2);
    for (let i = 0; i < 10; i++) s.appendBar(bar(i, i));
    expect(s.length).toBe(10);
    expect(s.capacity).toBeGreaterThanOrEqual(10);
    expect(s.col('open')[9]).toBe(9);
    expect(s.timeAt(0)).toBe(0);
  });

  it('ensureCapacity 预分配不改变长度', () => {
    const s = new ColumnStore(4);
    s.appendBar(bar(1, 1));
    s.ensureCapacity(1_000_000);
    expect(s.length).toBe(1);
    expect(s.capacity).toBeGreaterThanOrEqual(1_000_000);
    expect(s.col('open')[0]).toBe(1);
  });
});
