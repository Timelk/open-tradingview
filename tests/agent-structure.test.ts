import {describe,expect,it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import {averageTrueRange,computeStructure,findPivots} from '../src/lib/agent/structure';

const MINUTE=60_000,T0=Date.UTC(2026,8,30);
function series(close:(i:number)=>number,count:number,spread=1){
  const store=new ColumnStore(count);
  for(let i=0;i<count;i++){const c=close(i),o=i?close(i-1):c;store.appendBar({time:T0+i*MINUTE,open:o,high:Math.max(o,c)+spread,low:Math.min(o,c)-spread,close:c,volume:1});}
  return store;
}
const options={strength:3,maxPivots:50,maxLevels:8,tolerance:.25,format:'ms' as const};

describe('agent market structure',()=>{
  it('finds confirmed pivots with first-of-equal extremes and labels the swing sequence',()=>{
    const cols=series(i=>100+10*Math.sin(2*Math.PI*i/20)+i*.4,120);
    const pivots=findPivots(cols,{start:0,end:120},3);
    expect(pivots.filter(p=>p.type==='high').map(p=>p.index)).toEqual([5,25,45,65,85,105]);
    const result=computeStructure(cols,{start:0,end:120},MINUTE,options) as any;
    expect(result.trend).toMatchObject({direction:'up'});expect(result.trend.r2).toBeGreaterThan(.5);
    expect(result.pivots.items.filter((p:{type:string})=>p.type==='high').slice(1).every((p:{label:string})=>p.label==='HH')).toBe(true);
    expect(result.pivots.items.filter((p:{type:string})=>p.type==='low').slice(1).every((p:{label:string})=>p.label==='HL')).toBe(true);
    expect(result.range).toMatchObject({bars:120,high:{time:T0+105*MINUTE}});
  });
  it('clusters repeated touches into support and resistance around the latest price',()=>{
    const cols=series(i=>[100,105,110,105][i%4]+(i%8<4?0:.1),64,.5);
    const result=computeStructure(cols,{start:0,end:64},MINUTE,{...options,strength:1}) as any;
    const levels=result.levels.items;
    expect(levels[0]).toMatchObject({side:'resistance',touches:expect.any(Number)});expect(levels[0].price).toBeCloseTo(110.55,1);expect(levels[0].touches).toBeGreaterThanOrEqual(10);
    expect(levels.at(-1)).toMatchObject({side:'support'});expect(levels.at(-1).price).toBeCloseTo(99.5,0);
    expect(result.trend.direction).toBe('flat');
    expect(result.nearest.resistance.price).toBeCloseTo(110.55,1);
    expect(averageTrueRange(cols,{start:0,end:64})).toBeGreaterThan(5);
  });
});
