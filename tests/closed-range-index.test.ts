import {describe,expect,it,vi} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import {ClosedRangeIndex} from '../src/lib/analysis/closed-range-index';
import type {ColumnView} from '../src/lib/core/types';
function fixture(n=1000){const store=new ColumnStore(n);for(let i=0;i<n;i++)store.appendBar({time:i*60000,open:100,high:101,low:99,close:100,volume:1});return store;}
describe('closed candle block index',()=>{
  it('finds the first strict/inclusive crossing across partial block boundaries and updates real corrections',()=>{
    const store=fixture();store.col('high')[260]=110;store.col('high')[770]=120;const index=new ClosedRangeIndex({...store,length:store.length,col:name=>store.col(name),intervalMs:60000},1000);
    expect(index.firstCross('high',261,1000,'gte',110)).toBe(770);expect(index.firstCross('high',0,1000,'gt',110)).toBe(770);expect(index.firstCross('high',0,260,'gte',110)).toBe(-1);
    store.col('high')[260]=105;index.update(index.cols,1000,260);expect(index.firstCross('high',0,1000,'gte',110)).toBe(770);
    index.update(index.cols,500,0);expect(index.firstCross('high',0,1000,'gte',110)).toBe(-1);
  });
  it('blocks malformed bars and actual gaps while known closing times do not drift to later timestamps',()=>{
    const store=fixture(),cols:ColumnView={length:1000,intervalMs:60000,col:name=>store.col(name)};for(let i=400;i<1000;i++)store.col('time')[i]+=120000;
    const index=new ClosedRangeIndex(cols,1000);expect(index.firstInvalid(0,1000)).toBe(400);expect(index.knownAt(399)).toBe(400*60000);
    store.col('low')[300]=120;index.update(cols,1000,300);expect(index.firstInvalid(0,1000)).toBe(300);
  });
  it('does not line-scan a large backing history when seeking an old geometry’s later risk event',()=>{
    const store=fixture(100000),col=vi.fn((name:Parameters<ColumnView['col']>[0])=>store.col(name)),cols={length:store.length,intervalMs:60000,col};store.col('high')[99000]=150;
    const index=new ClosedRangeIndex(cols,100000);col.mockClear();expect(index.firstCross('high',1,100000,'gt',120)).toBe(99000);expect(index.firstInvalid(1,100000)).toBe(-1);
    expect(col.mock.calls.length).toBeLessThan(10);
  });
  it('uses a declared monthly close even for one known candle and never relabels a declared 4h gap as monthly',()=>{
    const store=fixture(2);store.col('time')[0]=Date.parse('2026-01-01T00:00:00Z');store.col('time')[1]=Date.parse('2026-02-01T00:00:00Z');
    const month=new ClosedRangeIndex({length:1,intervalMs:30*86400000,col:name=>store.col(name)},1);
    expect(month.knownAt(0)).toBe(store.timeAt(1));
    const fourHours=new ClosedRangeIndex({length:2,intervalMs:4*3600000,col:name=>store.col(name)},2);
    expect(fourHours.knownAt(0)).toBe(store.timeAt(0)+4*3600000);expect(fourHours.firstInvalid(0,2)).toBe(1);
  });
});
