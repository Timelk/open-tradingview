import type {ColumnView} from '../core/types';

export interface OscillatorDivergencePoint {time:number;value:number;price:number}
/** Independent, confirmed price/oscillator evidence. A drawing is not a trade. */
export interface OscillatorDivergence {
  id:string;
  direction:'bullish'|'bearish';
  indicator:string;
  seriesName:string;
  plotIndex:number;
  points:[OscillatorDivergencePoint,OscillatorDivergencePoint];
  confirmedAt:number;
  ruleVersion:string;
}
export interface OscillatorDivergenceMetadata {indicator:string;seriesName:string;plotIndex:number}
export interface OscillatorDivergenceParams {divergenceStrength?:number}
interface Pivot {index:number;time:number;price:number;value:number}
const RULE_VERSION='oscillator-divergence/1.0-regular';
const strengthOf=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?Math.max(1,Math.min(30,Math.round(value))):3;

/** A tracker owns one indicator output on its own source timeframe. New closed
 * candles inspect only newly completed pivot windows. Historical edits must
 * supply their earliest dirty index; rewinds and replaced buffers also reset.
 * No history cap or alternating-zigzag compression changes the preceding pivot. */
export class OscillatorDivergenceCalculator {
  private readonly metadata:OscillatorDivergenceMetadata;
  private readonly strength:number;
  private result:OscillatorDivergence[]=[];
  private emittedIds=new Set<string>();
  private processed=0;
  private segmentStart=0;
  private previousHigh?:Pivot;
  private previousLow?:Pivot;
  private badValuePrefix=new Uint32Array(0);
  private cadence=Infinity;
  private buffers:ArrayBufferLike[]=[];
  private valueOffset=-1;
  private firstTime=NaN;
  private lastSignature='';

  constructor(metadata:OscillatorDivergenceMetadata,params:OscillatorDivergenceParams={}) {
    this.metadata={...metadata};this.strength=strengthOf(params.divergenceStrength);
  }

  update(cols:ColumnView,values:Float64Array,from?:number):OscillatorDivergence[] {
    const rawClosed=cols.closedLength??cols.length-1;
    const n=Number.isFinite(rawClosed)?Math.max(0,Math.min(cols.length,Math.floor(rawClosed))):0;
    const time=cols.col('time'),open=cols.col('open'),high=cols.col('high'),low=cols.col('low'),close=cols.col('close');
    const inputs=[time,open,high,low,close,values],buffers=inputs.map(column=>column.buffer);
    const signature=(index:number)=>index<0?'':inputs.map(column=>column[index]).join(':');
    const reset=this.buffers.length!==buffers.length||buffers.some((buffer,i)=>buffer!==this.buffers[i])
      ||this.valueOffset!==values.byteOffset||this.firstTime!==time[0]||n<this.processed
      ||from!==undefined&&Number.isFinite(from)&&from<this.processed
      ||this.processed>0&&signature(this.processed-1)!==this.lastSignature;
    if(reset){this.result=[];this.emittedIds.clear();this.processed=0;this.segmentStart=0;this.previousHigh=undefined;this.previousLow=undefined;this.cadence=Infinity;}
    this.buffers=buffers;this.valueOffset=values.byteOffset;this.firstTime=time[0];
    if(this.badValuePrefix.length<n+1){const next=new Uint32Array(Math.max(n+1,Math.max(64,this.badValuePrefix.length*2)));next.set(this.badValuePrefix);this.badValuePrefix=next;}
    this.badValuePrefix[0]=0;
    if(n===this.processed)return this.result;
    const added:OscillatorDivergence[]=[];
    const validBar=(i:number)=>[time[i],open[i],high[i],low[i],close[i]].every(Number.isFinite)
      &&low[i]<=Math.min(open[i],close[i])&&high[i]>=Math.max(open[i],close[i])&&low[i]<=high[i];
    const pair=(previous:Pivot|undefined,current:Pivot,direction:OscillatorDivergence['direction'],confirmedAt:number)=>{
      if(!previous||previous.index>=current.index||!Number.isFinite(previous.value)||!Number.isFinite(current.value)
        ||this.badValuePrefix[current.index+1]!==this.badValuePrefix[previous.index])return;
      const bullish=direction==='bullish';
      if(!(bullish?current.price<previous.price&&current.value>previous.value:current.price>previous.price&&current.value<previous.value))return;
      const {indicator,seriesName,plotIndex}=this.metadata;
      const id=`osc-div:${encodeURIComponent(indicator)}:${plotIndex}:${direction}:${previous.time}:${current.time}`;
      if(this.emittedIds.has(id))return;this.emittedIds.add(id);
      added.push({id,
        direction,indicator,seriesName,plotIndex,
        points:[{time:previous.time,value:previous.value,price:previous.price},{time:current.time,value:current.value,price:current.price}],
        confirmedAt,ruleVersion:RULE_VERSION});
    };
    const radius=this.strength;
    for(let right=this.processed;right<n;right++){
      this.badValuePrefix[right+1]=this.badValuePrefix[right]+(Number.isFinite(values[right])?0:1);
      if(right>0){const delta=time[right]-time[right-1];if(Number.isFinite(delta)&&delta>0)this.cadence=Math.min(this.cadence,delta);}
      if(!validBar(right)){
        this.segmentStart=right+1;this.previousHigh=undefined;this.previousLow=undefined;continue;
      }
      if(right>0&&time[right]<=time[right-1]){this.segmentStart=right;this.previousHigh=undefined;this.previousLow=undefined;}
      const center=right-radius;
      if(center-radius<this.segmentStart)continue;
      let isHigh=true,isLow=true;
      for(let d=1;d<=radius&&(isHigh||isLow);d++){
        // Equal-price plateaus resolve to their rightmost extreme. A fully flat
        // window produces no pivot and cannot manufacture oscillator evidence.
        isHigh=isHigh&&high[center]>=high[center-d]&&high[center]>high[center+d];
        isLow=isLow&&low[center]<=low[center-d]&&low[center]<low[center+d];
      }
      if(!isHigh&&!isLow)continue;
      // Source cadence is explicit when available; otherwise infer only from
      // elapsed observations. Never read a future bar to timestamp a signal.
      const interval=typeof cols.intervalMs==='number'&&Number.isFinite(cols.intervalMs)&&cols.intervalMs>0?cols.intervalMs:this.cadence;
      const confirmedAt=time[right]+interval;
      if(!Number.isFinite(confirmedAt)||confirmedAt<=time[right])continue;
      // An outside candle may independently confirm both sides. Each side has
      // its own earlier pivot; no high-before-low ordering within a bar is made.
      if(isLow){const pivot={index:center,time:time[center],price:low[center],value:values[center]};pair(this.previousLow,pivot,'bullish',confirmedAt);this.previousLow=pivot;}
      if(isHigh){const pivot={index:center,time:time[center],price:high[center],value:values[center]};pair(this.previousHigh,pivot,'bearish',confirmedAt);this.previousHigh=pivot;}
    }
    if(added.length)this.result=[...this.result,...added];
    this.processed=n;this.lastSignature=signature(n-1);
    return this.result;
  }
}

/** Pure full-history entry point, using exactly the same rules as live updates. */
export function detectOscillatorDivergences(cols:ColumnView,values:Float64Array,metadata:OscillatorDivergenceMetadata,
  params:OscillatorDivergenceParams={}):OscillatorDivergence[]{
  return new OscillatorDivergenceCalculator(metadata,params).update(cols,values);
}
