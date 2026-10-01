import type {ColumnView,DerivedSeries} from '../core/types';
import type {IndicatorRegistry} from '../indicators/registry';

export interface StudyPreviewSeries {name:string;color:string;pane:'main'|'sub'|'volume';plot:'line'|'hist';values:Float64Array}
/** The last `bars` candles and the study's plottable outputs over them. */
export interface StudyPreviewData {
  target:'main'|'sub'|'volume';
  open:Float64Array;high:Float64Array;low:Float64Array;close:Float64Array;volume:Float64Array;
  series:StudyPreviewSeries[];
}

/**
 * Computes a study on the chart's own recent data for the library preview.
 * Only plain line/histogram indicators are previewed; strategies, pattern and
 * analysis layers (markers and zones) return undefined and the UI says
 * so instead of drawing something that would not match the chart.
 */
export function computeStudyPreview(registry:IndicatorRegistry,cols:ColumnView,id:string,bars=120):StudyPreviewData|undefined {
  let def;try{def=registry.get(id);}catch{return undefined;}
  if(def.kind==='strategy'||def.category||cols.length<Math.min(bars,30))return undefined;
  let outputs:DerivedSeries[];
  try{outputs=def.calc({cols,from:0,to:cols.length},registry.defaults(id));}catch{return undefined;}
  const from=Math.max(0,cols.length-bars),slice=(values:Float64Array)=>Float64Array.from(values.subarray(from,cols.length));
  const series=outputs.filter(output=>(output.plot==='line'||output.plot==='hist')&&output.values?.length===cols.length)
    .map(output=>({name:output.name,color:output.color,pane:output.pane,plot:output.plot as 'line'|'hist',values:slice(output.values)}))
    .filter(output=>output.values.some(Number.isFinite));
  if(!series.length)return undefined;
  return {target:def.target??series[0].pane,open:slice(cols.col('open')),high:slice(cols.col('high')),low:slice(cols.col('low')),close:slice(cols.col('close')),volume:slice(cols.col('volume')),series};
}
