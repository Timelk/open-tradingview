import {describe,expect,it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import {detectHuzi} from '../src/lib/patterns/huzi';
import {confirmedPivotEvents} from '../src/lib/patterns/pivots';

type Anchor=[number,number];
const minute=60_000;
const standard:Anchor[]=[[0,90],[10,110],[20,100],[30,125],[40,100],[50,111],[63,94],[70,94]];
const params={pivotStrength:2,multiScale:false,structuralSwings:false,family:'头肩形',maxPatterns:1000,showInvalidated:true};
function candles(anchors:Anchor[],mirror=false):ColumnStore {
  const store=new ColumnStore(128);let leg=0;
  for(let i=0;i<=anchors.at(-1)![0];i++){
    while(leg<anchors.length-2&&i>anchors[leg+1][0])leg++;
    const a=anchors[leg],b=anchors[leg+1],price=a[1]+(b[1]-a[1])*(i-a[0])/(b[0]-a[0]),value=mirror?250-price:price;
    store.appendBar({time:i*minute,open:value,high:value+.05,low:value-.05,close:value,volume:1});
  }
  return store;
}

describe('head-and-shoulders anchor integrity against source candles',()=>{
  it.each([false,true])('does not ignore an omitted outside bar that exceeds the named head (mirror=%s)',mirror=>{
    const name=mirror?'头肩底':'头肩顶',baseline=detectHuzi(candles(standard,mirror),params).find(match=>match.name===name)!;
    expect(baseline).toBeDefined();
    const broken=candles(standard,mirror);
    broken.col('open')[25]=mirror?140:110;broken.col('close')[25]=mirror?138:112;
    broken.col('high')[25]=mirror?190:200;broken.col('low')[25]=mirror?50:60;
    // Both prior extrema were crossed, so the pivot layer correctly declines
    // to invent an intrabar ordering. It must not erase the candle's prices.
    expect(confirmedPivotEvents(broken,2).some(point=>point.index===25)).toBe(false);
    const head=baseline.points[2].value;
    expect(mirror?broken.col('low')[25]<head:broken.col('high')[25]>head).toBe(true);
    expect(detectHuzi(broken,params).some(match=>match.id===baseline.id)).toBe(false);
  });

  it('checks only the actual L-to-R formation without applying later extremes retroactively',()=>{
    const store=candles(standard),baseline=detectHuzi(store,params).find(match=>match.name==='头肩顶')!;
    store.col('high')[1]=200;store.col('low')[1]=60; // Before the left shoulder.
    store.col('high')[65]=200; // A CLOSED candle after the original confirmation.
    store.appendBar({time:71*minute,open:94,high:200,low:60,close:95,volume:1});
    const match=detectHuzi(store,params).find(value=>value.id===baseline.id)!;
    expect(match).toBeDefined();expect(match.points).toEqual(baseline.points);expect(match.confirmedAt).toBe(baseline.confirmedAt);
  });

  it.each([false,true])('rejects an old head violated by a wick after R but before the first classic breakout (mirror=%s)',mirror=>{
    const name=mirror?'头肩底':'头肩顶',baseline=detectHuzi(candles(standard,mirror),params).find(match=>match.name===name)!;
    const store=candles(standard,mirror),shoulder=baseline.points.at(-1)!.value;
    expect(baseline.confirmedAt).toBeGreaterThan(55*minute);
    // The close has not crossed the old shoulder's failure boundary, so the
    // previous close-only pre-break check missed this actual replacement of H.
    expect(mirror?store.col('close')[55]>shoulder:store.col('close')[55]<shoulder).toBe(true);
    if(mirror)store.col('low')[55]=50;else store.col('high')[55]=200;
    expect(detectHuzi(store,params).some(match=>match.id===baseline.id)).toBe(false);
  });

  it('does not add a retrospective neckline-crossing veto or a new symmetry threshold',()=>{
    const store=candles([[0,115],[10,103],[20,120],[40,90],[60,115],[74,114.8],[80,103],[90,120],[100,120]]);
    const match=detectHuzi(store,{...params,pivotStrength:3}).find(value=>value.name==='头肩底')!;
    expect(match).toBeDefined();
    expect(match.points.map(point=>point.time/minute)).toEqual([10,20,40,60,80]);
    const neckAt74=120.05+(115.05-120.05)*(74-20)/(60-20);
    expect(store.col('close')[74]).toBeGreaterThan(neckAt74);
    expect(match.confirmedAt).toBe(87*minute);
  });
});
