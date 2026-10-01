import { describe, expect, it } from 'vitest';
import { describePatternCoverage } from '../src/lib/patterns/coverage';

const minute = 60_000;
const hour = 60 * minute;
const at = (value: string) => Date.parse(`${value}Z`);
type CoverageInput = Parameters<typeof describePatternCoverage>[0];
const current = (overrides: Partial<CoverageInput> = {}): CoverageInput => ({
  scanFrom: at('2026-08-13T00:00:00'),
  scanThrough: at('2026-08-15T10:25:00'),
  latestBarTime: at('2026-08-15T10:26:00'),
  latestConfirmedTime: at('2026-08-15T10:25:00'),
  latestMatchTime: at('2026-08-15T09:00:00'),
  latestDisplayedMatchTime: at('2026-08-15T09:00:00'),
  historicalSnapshot: false,
  following: true,
  intervalMs: minute,
  ...overrides,
});

describe('pattern date coverage diagnostics', () => {
  it.each(['2025', '2026', '2027'])('does not treat August 14 as a cutoff in %s', year => {
    for (const day of ['14', '15', '22']) {
      const through = at(`${year}-08-${day}T10:25:00`);
      const result = describePatternCoverage(current({
        scanFrom: at(`${year}-08-13T00:00:00`),
        scanThrough: through,
        latestBarTime: through + minute,
        latestConfirmedTime: through,
        latestMatchTime: through,
        latestDisplayedMatchTime: through,
      }));
      expect(result.code).toBe('current');
    }
  });

  it('distinguishes an old last match from an old scan', () => {
    const oldMatch = at('2026-08-14T18:00:00');
    expect(describePatternCoverage(current({
      latestMatchTime: oldMatch,
      latestDisplayedMatchTime: oldMatch,
    })).code).toBe('current');
    expect(describePatternCoverage(current({
      scanThrough: oldMatch,
      latestMatchTime: oldMatch,
      latestDisplayedMatchTime: oldMatch,
    })).code).toBe('stale-scan');
  });

  it('reports a lag only once it reaches a full calculation candle', () => {
    const through = at('2026-08-15T10:25:00');
    expect(describePatternCoverage(current({ scanThrough: through - minute + 1 })).code).toBe('current');
    expect(describePatternCoverage(current({ scanThrough: through - minute })).code).toBe('stale-scan');
  });

  it('does not call an unfinished higher-timeframe bucket stale', () => {
    const higher = current({
      intervalMs: hour,
      chartIntervalMs: minute,
      scanThrough: at('2026-08-15T09:00:00'),
      latestBarTime: at('2026-08-15T10:26:00'),
      latestConfirmedTime: at('2026-08-15T10:25:00'),
    });
    expect(describePatternCoverage(higher).code).toBe('current');
    // The 10:00 source candle becomes complete when the 10:59 base candle closes.
    expect(describePatternCoverage({
      ...higher,
      latestBarTime: at('2026-08-15T11:00:00'),
      latestConfirmedTime: at('2026-08-15T10:59:00'),
    }).code).toBe('stale-scan');
    expect(describePatternCoverage({
      ...higher,
      scanThrough: at('2026-08-15T10:00:00'),
      latestBarTime: at('2026-08-15T11:00:00'),
      latestConfirmedTime: at('2026-08-15T10:59:00'),
    }).code).toBe('current');
  });

  it('separates a filtered new match from an absence of matches', () => {
    expect(describePatternCoverage(current({
      latestDisplayedMatchTime: at('2026-08-14T18:00:00'),
    })).code).toBe('filtered-latest');
    expect(describePatternCoverage(current({ latestDisplayedMatchTime: undefined })).code).toBe('filtered-latest');
    const noMatches = describePatternCoverage(current({
      latestMatchTime: undefined,
      latestDisplayedMatchTime: undefined,
    }));
    expect(noMatches.code).toBe('current');
    expect(noMatches.message).toMatch(/暂无|没有|未识别|未发现/);
    expect(noMatches.message).toMatch(/已确认|符合规则/);
  });

  it('identifies a frozen snapshot before any live scan, filter or viewport diagnosis', () => {
    const result = describePatternCoverage(current({
      historicalSnapshot: true,
      following: false,
      scanThrough: at('2026-08-14T18:00:00'),
      latestDisplayedMatchTime: at('2026-08-14T17:00:00'),
    }));
    expect(result.code).toBe('snapshot');
    expect(result.action).toBe('latest');
    expect(result.message).toMatch(/快照|历史回测/);
  });

  it('identifies an older viewport without claiming the scan stopped', () => {
    const result = describePatternCoverage(current({ following: false }));
    expect(result.code).toBe('older-viewport');
    expect(result.action).toBe('latest');
  });

  it('prioritizes a stale scan and filtered latest match over a detached viewport', () => {
    expect(describePatternCoverage(current({
      following: false,
      scanThrough: at('2026-08-14T18:00:00'),
      latestDisplayedMatchTime: at('2026-08-14T17:00:00'),
    })).code).toBe('stale-scan');
    expect(describePatternCoverage(current({
      following: false,
      latestDisplayedMatchTime: at('2026-08-14T17:00:00'),
    })).code).toBe('filtered-latest');
  });
});

it('separates old evidence tiles from current lifecycle knowledge and still diagnoses true calculation lag',()=>{
  const base=current({scope:'viewport',following:false,scanThrough:at('2026-08-14T00:00:00'),knowledgeThroughTime:at('2026-08-15T10:26:00')});
  expect(describePatternCoverage(base).code).toBe('older-viewport');
  expect(describePatternCoverage(base).message).toContain('缩放');
  expect(describePatternCoverage({...base,knowledgeThroughTime:at('2026-08-15T10:25:00')}).code).toBe('stale-scan');
});
