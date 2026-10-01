import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockFeed } from '../src/lib/feed/mock-feed';
import type { BarEvent } from '../src/lib/core/types';

afterEach(() => vi.useRealTimers());
describe('mock live candle timing', () => {
  it('updates the current candle at 100 ms and opens exactly one at the interval boundary', async () => {
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-06T00:00:59.000Z'));
    const feed = new MockFeed({count:3,intervalMs:60_000});
    const history = feed.loadBulk(), ticks:BarEvent[] = [];
    feed.onBar(bar => ticks.push(bar));await feed.connect();
    vi.advanceTimersByTime(900);
    expect(ticks).toHaveLength(9);
    expect(ticks.every(bar => !bar.isNew && bar.time === history[2].time)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(ticks[9].isNew).toBe(true);
    expect(ticks[9].time).toBe(history[2].time + 60_000);
    expect(ticks[9].open).toBe(ticks[8].close);
    vi.advanceTimersByTime(500);
    expect(ticks.filter(bar => bar.isNew)).toHaveLength(1);
    expect(ticks[14].time).toBe(ticks[9].time);
    feed.disconnect();vi.advanceTimersByTime(500);
    expect(ticks).toHaveLength(15);
  });
});
