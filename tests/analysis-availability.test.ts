import {expect,it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import type {ColumnView} from '../src/lib/core/types';
import {detectCandlesticks} from '../src/lib/analysis/candlesticks';

it('never moves an already confirmed candle event to a later gap-recovery timestamp',()=>{
  const store=new ColumnStore(128),minute=60_000,epoch=Date.parse('2026-08-15T00:00:00Z');
  for(let i=0;i<22;i++){
    const close=110-i*.3;store.appendBar({time:epoch+i*minute,open:close-.2,high:close+.6,low:close-.7,close,volume:100});
  }
  store.appendBar({time:epoch+22*minute,open:103,high:105,low:101,close:103.05,volume:100});
  const view=():ColumnView=>({length:store.length,closedLength:store.length,intervalMs:minute,col:name=>store.col(name)});
  const before=detectCandlesticks(view(),{family:'Doji'}).find(o=>o.time===epoch+22*minute)!;
  expect(before).toBeDefined();expect(before.availableAt).toBe(epoch+23*minute);
  // Sixty one-minute candles are missing. The first later observation must
  // neither become the earlier event's confirmation nor rewrite its geometry.
  store.appendBar({time:epoch+83*minute,open:103,high:104,low:102,close:103.5,volume:100});
  const after=detectCandlesticks(view(),{family:'Doji'}).find(o=>o.id===before.id)!;
  expect(after.availableAt).toBe(before.availableAt);expect(after.points).toEqual(before.points);
  expect(after.throughTime).toBe(epoch+84*minute);
});
