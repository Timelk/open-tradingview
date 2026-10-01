import {describe,expect,it} from 'vitest';
import {detectHuzi} from '../src/lib/patterns/huzi';
import {patternChartLabel} from '../src/lib/patterns/presentation';
import {patternStrategies,EARLY_MIN_BARS} from '../src/lib/patterns/registry';
import {plant,viewOf} from './fixtures/huzi-synthetic';
import {untranslated} from './fixtures/huzi-english';

const params={pivotStrength:3,lookback:1500,tolerance:.04,maxPatterns:1000,showInvalidated:true,minStructureBars:0};
const early=(seed:number,length:number,extra:Record<string,unknown>={})=>{
  const t=plant({kind:'sym-triangle',length,seed,noise:.3,prefix:300,touches:4,breakout:'up'});
  return {t,matches:detectHuzi(viewOf(t.bars,t.breakout+6),{...params,allowEarly:true,...extra}).filter(m=>m.formation==='early')};
};

describe('breakout after four touches ("no E point")',()=>{
  it('is off unless asked for, and marked as such when it is on',()=>{
    let checked=0;
    for(let seed=1;seed<=20;seed++){
      const t=plant({kind:'sym-triangle',length:150,seed,noise:.3,prefix:300,touches:4,breakout:'up'});
      const view=viewOf(t.bars,t.breakout+6);
      expect(detectHuzi(view,params).some(m=>m.formation==='early')).toBe(false);
      const on=detectHuzi(view,{...params,allowEarly:true}).filter(m=>m.formation==='early');
      for(const m of on){
        checked++;
        expect(m.description).toContain('无 E 点');
        expect(patternChartLabel(m)).toContain('无E点');
        expect(m.points.length).toBe(4);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('keeps only structures at least earlyMinBars long, so fragments do not flood the chart',()=>{
    let kept=0,dropped=0;
    for(let seed=1;seed<=20;seed++){
      const {matches:all}=early(seed,150,{earlyMinBars:0}),{matches:filtered}=early(seed,150,{earlyMinBars:400});
      expect(filtered).toEqual([]);
      const long=early(seed,150,{earlyMinBars:100}).matches;
      for(const m of long)expect((m.points.at(-1)!.time-m.points[0].time)/3_600_000).toBeGreaterThanOrEqual(100);
      kept+=long.length;dropped+=all.length-long.length;
    }
    expect(kept).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThanOrEqual(0);
  });

  it('is off by default in the panel and, when switched on, limited to author-scale structures',()=>{
    const def=patternStrategies().find(d=>d.id==='pattern-huzi')!;
    const input=(key:string)=>def.inputs.find(i=>i.key===key)!;
    expect(input('allowEarly').def).toBe(false);
    expect(input('earlyMinBars').def).toBe(EARLY_MIN_BARS);
    expect(EARLY_MIN_BARS).toBe(80);
  });

  it('is fully translated',()=>{
    for(let seed=1;seed<=20;seed++){
      const m=early(seed,150).matches[0];
      if(m){expect(untranslated(m)).toEqual([]);return;}
    }
    throw new Error('no early structure found');
  });
});
