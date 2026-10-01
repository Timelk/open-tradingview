import {FLOW_COLUMNS,type BarInput,type ColumnName,type ColumnView,type FlowColumnName} from './types';

/**
 * 列式 K 线存储：OHLCV 各一根 Float64Array。
 * 百万级下对象数组的 GC 与缓存局部性都扛不住，列存是 WebGL 上传与 Worker 计算的前提。
 */
export class ColumnStore implements ColumnView {
  length = 0;
  capacity: number;
  private arrays: Record<ColumnName, Float64Array>;
  private flowArrays:Partial<Record<FlowColumnName,Float64Array>>={};

  constructor(initialCapacity = 1024) {
    this.capacity = Math.max(1, Math.floor(initialCapacity));
    const mk = () => new Float64Array(this.capacity);
    this.arrays = { time: mk(), open: mk(), high: mk(), low: mk(), close: mk(), volume: mk() };
  }

  col(name: ColumnName): Float64Array {
    return this.arrays[name];
  }
  flow(name:FlowColumnName):Float64Array|undefined{return this.flowArrays[name];}
  prepend(bars:readonly BarInput[]):void {
    if(!bars.length)return;const count=bars.length,previous=this.length;this.ensureCapacity(previous+count);
    for(const name of Object.keys(this.arrays) as ColumnName[]){const values=this.arrays[name];values.copyWithin(count,0,previous);for(let i=0;i<count;i++)values[i]=bars[i][name];}
    for(const name of FLOW_COLUMNS){let values=this.flowArrays[name];if(!values&&bars.some(bar=>Number.isFinite(bar[name]))){values=new Float64Array(this.capacity).fill(NaN);this.flowArrays[name]=values;}if(values){values.copyWithin(count,0,previous);for(let i=0;i<count;i++)values[i]=bars[i][name]??NaN;}}
    this.length=previous+count;
  }
  private writeFlow(index:number,bar:BarInput):void {
    for(const name of FLOW_COLUMNS){
      let values=this.flowArrays[name];const value=bar[name];
      if(!values&&Number.isFinite(value)){values=new Float64Array(this.capacity).fill(NaN);this.flowArrays[name]=values;}
      if(values)values[index]=typeof value==='number'&&Number.isFinite(value)?value:NaN;
    }
  }

  timeAt(i: number): number {
    return this.arrays.time[i];
  }

  ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    let cap = this.capacity;
    while (cap < n) cap *= 2;
    const next: Record<ColumnName, Float64Array> = {
      time: new Float64Array(cap),
      open: new Float64Array(cap),
      high: new Float64Array(cap),
      low: new Float64Array(cap),
      close: new Float64Array(cap),
      volume: new Float64Array(cap),
    };
    (Object.keys(next) as ColumnName[]).forEach((k) => next[k].set(this.arrays[k].subarray(0, this.length)));
    this.arrays = next;
    for(const name of FLOW_COLUMNS){const previous=this.flowArrays[name];if(previous){const values=new Float64Array(cap).fill(NaN);values.set(previous.subarray(0,this.length));this.flowArrays[name]=values;}}
    this.capacity = cap;
  }

  appendBar(b: BarInput): void {
    this.ensureCapacity(this.length + 1);
    const i = this.length++;
    this.arrays.time[i] = b.time;
    this.arrays.open[i] = b.open;
    this.arrays.high[i] = b.high;
    this.arrays.low[i] = b.low;
    this.arrays.close[i] = b.close;
    this.arrays.volume[i] = b.volume;
    this.writeFlow(i,b);
  }

  /** tick 更新：只改最后一根，长度不变。 */
  updateLast(b: BarInput): void {
    if (this.length === 0) {
      this.appendBar(b);
      return;
    }
    const i = this.length - 1;
    this.arrays.time[i] = b.time;
    this.arrays.open[i] = b.open;
    this.arrays.high[i] = b.high;
    this.arrays.low[i] = b.low;
    this.arrays.close[i] = b.close;
    this.arrays.volume[i] = b.volume;
    this.writeFlow(i,b);
  }
}
