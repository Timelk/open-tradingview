import type { ColumnStore } from '../core/datastore';
import type { BarInput, Feed } from '../core/types';

/** 批量首屏 + 增量订阅的 Feed。Mock 同步返回，Binance 异步拉 REST。 */
export interface BulkFeed extends Feed {
  loadStore?(): ColumnStore | Promise<ColumnStore>;
  loadBulk(): BarInput[] | Promise<BarInput[]>;
  /** Read-only older history. Never advances the live feed cursor or emits bars. */
  loadBefore?(before:number,limit?:number):Promise<BarInput[]>;
}
