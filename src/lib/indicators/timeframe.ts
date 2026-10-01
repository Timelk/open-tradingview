import { ColumnStore } from '../core/datastore';
import {FLOW_COLUMNS,type ColumnView,type FlowColumnName} from '../core/types';
import {continuous} from '../analysis/features';

/** Shared UTC aggregation. A checkpoint before the newest base candle makes
 * repeated quote replacements O(1), even for a day bucket on a minute chart. */
export class TimeframeCache {
  readonly store = new ColumnStore();
  map = new Int32Array(0);
  private previousLength = 0;
  private checkpoint = { high: -Infinity, low: Infinity, volume: 0 };
  private flowCheckpoint:Partial<Record<FlowColumnName,number>>={};
  private flowSignature='';
  dirty = 0;
  offset = 0;
  constructor(readonly intervalMs: number) {}

  update(base: ColumnView, from: number): void {
    if (this.map.length < base.length) {
      const next = new Int32Array(Math.max(base.length + 1024, this.map.length * 2)); next.set(this.map); this.map = next;
    }
    const flowSignature=FLOW_COLUMNS.map(key=>Boolean(base.flow?.(key))).join(':');
    if (!this.previousLength || from < this.previousLength - 1 || base.length < this.previousLength||flowSignature!==this.flowSignature) {
      this.store.length = 0; this.previousLength = 0; from = 0;
      this.checkpoint = { high: -Infinity, low: Infinity, volume: 0 };
      this.flowCheckpoint={};this.flowSignature=flowSignature;
    }
    const time = base.col('time'), open = base.col('open'), high = base.col('high'), low = base.col('low'), close = base.col('close'), volume = base.col('volume');
    this.offset = base.length && time[0] % this.intervalMs !== 0 ? 1 : 0;
    const start = Math.max(0, Math.min(from, this.previousLength));
    for (let i = start; i < base.length; i++) {
      const bucket = Math.floor(time[i] / this.intervalMs) * this.intervalMs;
      const fresh = !this.store.length || this.store.timeAt(this.store.length - 1) !== bucket;
      if (fresh) this.store.appendBar({ time: bucket, open: open[i], high: -Infinity, low: Infinity, close: close[i], volume: 0,...Object.fromEntries(FLOW_COLUMNS.filter(key=>base.flow?.(key)).map(key=>[key,0])) });
      const group = this.store.length - 1;
      this.map[i] = group;
      if (i === this.previousLength - 1) {
        this.store.col('high')[group] = this.checkpoint.high;
        this.store.col('low')[group] = this.checkpoint.low;
        this.store.col('volume')[group] = this.checkpoint.volume;
        for(const key of FLOW_COLUMNS){const values=this.store.flow(key);if(values)values[group]=this.flowCheckpoint[key]??NaN;}
        if (group === 0 ? i === 0 : this.map[i - 1] !== group) this.store.col('open')[group] = open[i];
      }
      if (i === base.length - 1){this.checkpoint = { high: this.store.col('high')[group], low: this.store.col('low')[group], volume: this.store.col('volume')[group] };this.flowCheckpoint=Object.fromEntries(FLOW_COLUMNS.map(key=>[key,this.store.flow(key)?.[group]??NaN]));}
      this.store.col('high')[group] = Math.max(this.store.col('high')[group], high[i]);
      this.store.col('low')[group] = Math.min(this.store.col('low')[group], low[i]);
      this.store.col('close')[group] = close[i]; this.store.col('volume')[group] += volume[i];
      for(const key of FLOW_COLUMNS){const values=this.store.flow(key);if(values){
        // A bucket assembled across missing source candles has incomplete
        // taker totals, even if the OHLC range can still be drawn.
        if(!continuous(base,i)||fresh&&time[i]!==bucket)values[group]=NaN;
        else values[group]+=base.flow?.(key)?.[i]??NaN;
      }}
    }
    this.dirty = start < base.length ? this.map[start] : Math.max(0, this.store.length - 1);
    this.previousLength = base.length;
  }
}
