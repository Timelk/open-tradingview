import {describe,expect,it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {computeStudyPreview} from '../src/lib/studies/preview';
import {sma} from '../src/lib/indicators/calc';

function store(n=300){const s=new ColumnStore();for(let i=0;i<n;i++){const close=100+10*Math.sin(i/9)+i*.05;s.appendBar({time:i*60_000,open:close-.5,high:close+1,low:close-1,close,volume:10+i%7});}return s;}
const registry=()=>{const r=new IndicatorRegistry();registerBuiltins(r);return r;};

describe('study library preview data',()=>{
  it('computes a main-pane study on the chart\'s own last N candles with exact values',()=>{
    const cols=store(),data=computeStudyPreview(registry(),cols,'ma',120)!;
    expect(data.target).toBe('main');expect(data.close).toHaveLength(120);expect(data.series).toHaveLength(1);
    const full=sma(cols.col('close').subarray(0,cols.length),20);
    expect(Array.from(data.series[0].values)).toEqual(Array.from(full.subarray(cols.length-120)));
    expect(data.close[119]).toBe(cols.col('close')[cols.length-1]);
  });
  it('previews sub-pane oscillators with their histogram and lines',()=>{
    const data=computeStudyPreview(registry(),store(),'macd')!;
    expect(data.series.some(s=>s.pane!=='main'&&s.plot==='hist')).toBe(true);
    expect(data.series.some(s=>s.plot==='line')).toBe(true);
  });
  it('does not replace pattern or structure analysis with an unrelated line preview',()=>{
    const r=registry(),cols=store();for(const def of r.list().filter(def=>!!def.category))expect(computeStudyPreview(r,cols,def.id),def.id).toBeUndefined();
  });
  it('declines strategies, unknown studies and too little data instead of drawing a mismatch',()=>{
    const r=registry(),strategy=r.list().find(def=>def.kind==='strategy');
    if(strategy)expect(computeStudyPreview(r,store(),strategy.id)).toBeUndefined();
    expect(computeStudyPreview(r,store(),'nope')).toBeUndefined();
    expect(computeStudyPreview(r,store(10),'ma')).toBeUndefined();
  });
});
