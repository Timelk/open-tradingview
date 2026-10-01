import {describe,expect,it} from 'vitest';
import {detectHuzi} from '../src/lib/patterns/huzi';
import {plant,viewOf,withApproach,type PlantedKind} from './fixtures/huzi-synthetic';
import {untranslated} from './fixtures/huzi-english';

const params={pivotStrength:3,lookback:1500,tolerance:.04,maxPatterns:1000,showInvalidated:true,minStructureBars:0};
const detect=(bars:ReturnType<typeof plant>['bars'],cut:number)=>detectHuzi(viewOf(bars,cut),params);

describe('English display of Huzi structures',()=>{
  it.each(['sym-triangle','asc-triangle','rising-wedge','falling-wedge','up-channel','head-shoulders-top'] as PlantedKind[])(
    'leaves no Chinese in the description, ratios or labels of a %s',kind=>{
      const seen=new Set<string>();let checked=0;
      for(const approach of ['up','down'] as const)for(const breakout of ['up','down'] as const)for(let seed=1;seed<=4;seed++){
        const t=withApproach(kind,seed,approach,breakout);
        for(const match of detect(t.bars,t.breakout+6)){
          const missing=untranslated(match);checked++;
          for(const entry of missing)seen.add(entry);
        }
      }
      expect(checked).toBeGreaterThan(0);
      expect([...seen]).toEqual([]);
    });
});
