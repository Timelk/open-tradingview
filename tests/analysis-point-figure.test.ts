import {describe,it,expect} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import type {ColumnView} from '../src/lib/core/types';
import {buildPointFigure,detectPointFigure,measurePointFigure} from '../src/lib/analysis/point-figure';
const epoch=Date.UTC(2026,0,1),minute=60000;
function view(prices:number[],closed=prices.length):ColumnView{const s=new ColumnStore();prices.forEach((c,i)=>s.appendBar({time:epoch+i*minute,open:c,high:c+50,low:Math.max(.01,c-50),close:c,volume:100}));return {length:s.length,closedLength:closed,intervalMs:minute,col:k=>s.col(k)};}
const p={boxSize:1,reversal:3};
describe('fixed-box close-only P&F measurement',()=>{
  it('matches a hand-counted sequence with three-box turns excluding the prior extreme',()=>{
    const result=buildPointFigure(view([100,103,104,102,101,100,103,106,103]),p);
    expect(result.columns.map(c=>[c.direction,c.lowBox,c.highBox])).toEqual([['X',101,104],['O',100,103],['X',101,106],['O',103,105]]);
    expect(result.columns.map(c=>c.fromTime)).toEqual([1,4,6,8].map(i=>epoch+i*minute));
  });
  it('does not reverse on a two-box pullback, and uses close rather than huge synthetic wicks',()=>{
    const result=buildPointFigure(view([100,104,102,105]),p);
    expect(result.columns).toHaveLength(1);expect(result.columns[0]).toMatchObject({direction:'X',lowBox:101,highBox:105});
  });
  it('measures an independently hand-counted six-column congestion using width × box × reversal',()=>{
    const result=buildPointFigure(view([100,104,100,104,100,104,100,104]),p),m=measurePointFigure(result,p)!;
    expect(m).toMatchObject({columns:6,countPrice:102,extension:18,rangeLow:100,rangeHigh:104,bullishReference:118,bearishReference:86,includesDeveloping:false});
    expect(measurePointFigure(result,{...p,includeDeveloping:true})?.columns).toBe(7);
  });
  it('refuses to count disjoint trend columns as congestion or manufacture a price reference',()=>{
    const data=view([100,110,105,120,115,130,125,140,135,150,145]);
    expect(measurePointFigure(buildPointFigure(data,p),p)).toBeUndefined();
    const observations=detectPointFigure(data,p);expect(observations[0].lines?.some(l=>l.role==='projection')).toBe(false);
  });
  it('supports an explicitly chosen count row and rejects a row outside the common overlap',()=>{
    const result=buildPointFigure(view([100,104,100,104,100,104,100,104]),p);
    expect(measurePointFigure(result,{...p,countPrice:101})?.countPrice).toBe(101);
    expect(measurePointFigure(result,{...p,countPrice:110})).toBeUndefined();
  });
  it('honors time anchors and closedLength so later price changes cannot rewrite a frozen measurement',()=>{
    const prices=[100,104,100,104,100,104,100,104,150,80],a=buildPointFigure(view(prices),{...p,rangeTo:epoch+7*minute});
    expect(a).toEqual(buildPointFigure(view(prices.slice(0,8)),p));
    expect(buildPointFigure(view(prices,8),p)).toEqual(a);
  });
  it('keeps unknown tick size invalid instead of choosing a profitable-looking adaptive box',()=>{
    expect(buildPointFigure(view([100,104,100]),{boxMode:'ticks',boxTicks:10}).columns).toEqual([]);
    expect(buildPointFigure(view([100,104,100]),{boxMode:'ticks',boxTicks:10,tickSize:.1}).columns).toEqual(buildPointFigure(view([100,104,100]),p).columns);
  });
  it('does not join horizontal counts across a timestamp gap',()=>{
    const data=view([100,104,100,104,100,104,100,104]);for(let i=4;i<data.length;i++)data.col('time')[i]+=10*minute;
    const result=buildPointFigure(data,p);expect(result.warnings.join(' ')).toContain('缺口');
    expect(measurePointFigure(result,{...p,includeDeveloping:true})).toBeUndefined();
  });
  it('outputs independent projection measurements without target-tracking or trade fields',()=>{
    const o=detectPointFigure(view([100,104,100,104,100,104,100,104]),p)[0];
    expect(o.name).toContain('独立测量');expect(o.state).toBe('observing');
    expect(o.lines?.filter(l=>l.role==='projection')).toHaveLength(2);
    expect(o).not.toHaveProperty('targets');expect(o).not.toHaveProperty('resolution');expect(o).not.toHaveProperty('entry');
  });
});
