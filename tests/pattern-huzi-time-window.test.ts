import {describe,expect,it} from 'vitest';
import type {ColumnView,ColumnName} from '../src/lib/core/types';
import {detectHuzi} from '../src/lib/patterns/huzi';
import fixture from './fixtures/huzi-double-time-regression.json?raw';
const epoch=Date.UTC(2026,0,1),step=60_000;
function view(rows:number[][],closed=rows.length):ColumnView {
  const keys:ColumnName[]=['time','open','high','low','close','volume'],interval=rows.length>1?rows[1][0]-rows[0][0]:step,all=[...rows,[rows.at(-1)![0]+interval,NaN,NaN,NaN,NaN,NaN]],columns=Object.fromEntries(keys.map((key,i)=>[key,Float64Array.from(all,r=>r[i])]));
  return {length:Math.min(all.length,closed+1),closedLength:closed,col:name=>columns[name]};
}
function shape(scale=1,mirror=false,late=25,compact=false){
  const left=10*scale,neck=(compact?14:18)*scale,right=(compact?16:32)*scale,breakAt=right+late*scale;
  const anchors=[[0,110],[left,100],[neck,120],[right,101],[right+Math.min(8,late-2)*scale,110],[breakAt-scale,119.5],[breakAt,122],[breakAt+4*scale,124]],rows:number[][]=[];
  for(let leg=0;leg<anchors.length-1;leg++)for(let i=anchors[leg][0];i<anchors[leg+1][0];i++){
    const price=anchors[leg][1]+(anchors[leg+1][1]-anchors[leg][1])*(i-anchors[leg][0])/(anchors[leg+1][0]-anchors[leg][0]),value=mirror?300-price:price;
    rows.push([epoch+i*step,value,value,value,value,100]);
  }
  return {rows,indices:[left,neck,right],breakAt};
}
const options={family:'双底 / 双顶',pivotStrength:6,multiScale:false,showInvalidated:true,maxPatterns:1000};
const target=(results:ReturnType<typeof detectHuzi>,indices:number[])=>results.find(p=>p.points.map(p=>(p.time-epoch)/step).join()===indices.join());

describe('explicit Huzi duration and post-availability confirmation budget',()=>{
  for(const scale of [1,2,4])for(const mirror of [false,true])it(`preserves an asymmetric valid double across temporal scaling ${scale}, mirror ${mirror}`,()=>{
    const s=shape(scale,mirror),params={...options,pivotStrength:6*scale},found=target(detectHuzi(view(s.rows),params),s.indices);
    // Time stretching creates intermediate closes on the final upward leg;
    // the first actual close past the fixed price band is the causal oracle.
    const firstBreak=s.rows.findIndex((row,index)=>index>s.indices[2]&&(mirror?300-row[4]:row[4])>120.195);
    expect(found).toBeDefined();expect(found!.direction).toBe(mirror?'bearish':'bullish');expect(found!.confirmedAt).toBe(epoch+(firstBreak+1)*step);
    expect(found!.ruleVersion).toBe('huzi/2.0-explicit-time');expect(found!.description).toContain('全部锚点可知后');
    expect(target(detectHuzi(view(s.rows,firstBreak),params),s.indices)).toBeUndefined();
    expect(target(detectHuzi(view(s.rows,firstBreak+1),params),s.indices)?.points).toEqual(found!.points);
  });
  it('recognizes a six-bar double only when actual alternating pivots and explicit spacing support it',()=>{
    const s=shape(1,false,10,true),p={...options,pivotStrength:3};expect(target(detectHuzi(view(s.rows),p),s.indices)).toBeDefined();
    expect(target(detectHuzi(view(s.rows),{...p,minDoubleLeg:3}),s.indices)).toBeUndefined();
    expect(target(detectHuzi(view(s.rows),{...p,minDoubleSpan:8}),s.indices)).toBeUndefined();
  });
  it('keeps the ordinary symmetry and price-deviation rejections',()=>{
    const s=shape();const p={...options};
    const altered=s.rows.map(row=>row.slice());
    // A second extreme at 110 is a 10/15=66.7% mismatch, not a double bottom.
    for(let i=18;i<=32;i++){const value=120+(110-120)*(i-18)/(32-18);for(let c=1;c<=4;c++)altered[i][c]=value;}
    expect(target(detectHuzi(view(altered),p),s.indices)).toBeUndefined();
  });
  it('expires a genuinely late break, honors an explicit wait, and never recycles a prior invalidation',()=>{
    const late=shape(1,false,100);expect(target(detectHuzi(view(late.rows),options),late.indices)).toBeUndefined();
    expect(target(detectHuzi(view(late.rows),{...options,breakoutWaitBars:120}),late.indices)).toBeDefined();
    const ordinary=shape();expect(target(detectHuzi(view(ordinary.rows),{...options,breakoutWaitBars:10}),ordinary.indices)).toBeUndefined();
    const broken=ordinary.rows.map(r=>r.slice());for(let c=1;c<=4;c++)broken[43][c]=90;
    expect(target(detectHuzi(view(broken),options),ordinary.indices)).toBeUndefined();
  });
});

describe('previous blind disagreements promoted to regression-only evidence',()=>{
  const cases=JSON.parse(fixture).cases as {id:string;rows:number[][];actualAnchors:number[];knownRow:number}[];
  it.each(cases)('recovers actual supported extrema in $id without changing reviewer labels',({rows,actualAnchors,knownRow})=>{
    const params={family:'全部',pivotStrength:3,multiScale:true,showInvalidated:true,maxPatterns:1000};
    const item=detectHuzi(view(rows),params).find(p=>p.family==='huzi-double'&&p.points.map(p=>rows.findIndex(r=>r[0]===p.time)).join()===actualAnchors.join());
    expect(item).toBeDefined();expect(item!.confirmedAt).toBe(rows[knownRow][0]);
    const before=detectHuzi(view(rows,knownRow-1),params);expect(before.some(p=>p.id===item!.id)).toBe(false);
  });
});
