import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import type {ColumnName,ColumnView,ParamValues} from '../src/lib/core/types';
import type {PatternMatch} from '../src/lib/patterns/types';
import type {Pivot} from '../src/lib/patterns/pivots';
import {harmonicLegsIntact} from '../src/lib/patterns/harmonic-swings';
import {detectHarmonics} from '../src/lib/patterns/harmonic';
import {detectHarmonicCandidates} from '../src/lib/patterns/harmonic-candidates';
import {detectHuzi} from '../src/lib/patterns/huzi';

interface AuditCase {id:string;frame:string;rows:number[][];anchors:{label:string;row:number;time:number;price:number}[];predictionId:string}
const cases=(JSON.parse(readFileSync(new URL('./fixtures/anchor-audit-regression.json',import.meta.url),'utf8')) as {cases:AuditCase[]}).cases;
const get=(n:number)=>cases.find(c=>c.id===`anchor-${String(n).padStart(2,'0')}`)!;
const params:ParamValues={lookback:2000,maxPatterns:1000,showInvalidated:true,pivotStrength:3,multiScale:true};
function view(card:AuditCase,count=card.rows.length,mirror=false,forming=false):ColumnView {
  const ms=card.frame==='5m'?300000:60000;
  const rows=card.rows.slice(0,count).map(r=>mirror?[r[0],200000-r[1],200000-r[3],200000-r[2],200000-r[4],r[5]]:[...r]);
  if(!forming)rows.push([rows.at(-1)![0]+ms,NaN,NaN,NaN,NaN,NaN]);
  const keys:ColumnName[]=['time','open','high','low','close','volume'];
  const columns=Object.fromEntries(keys.map((key,i)=>[key,Float64Array.from(rows,r=>r[i])])) as Record<ColumnName,Float64Array>;
  return {length:rows.length,closedLength:forming?rows.length-1:count,intervalMs:ms,col:key=>columns[key]};
}
const samePoints=(match:PatternMatch,card:AuditCase)=>match.points.length===card.anchors.length&&match.points.every((p,i)=>p.time===card.anchors[i].time);
function pivots(card:AuditCase):Pivot[]{return card.anchors.map(a=>({index:a.row,time:a.time,value:a.price,
  kind:card.rows[a.row][2]===a.price?'high':'low',confirmedAt:a.time+4*60000}));}

describe('unblinded source-leg regression, not a replacement blind score',()=>{
  it.each([false,true])('rejects the real Alternate Bat whose BC candles exceeded both measured endpoints (mirrored=%s)',mirror=>{
    const card=get(30),cols=view(card,card.rows.length,mirror);
    for(const structuralSwings of [false,true])expect(detectHarmonics(cols,{...params,family:'Alternate Bat',structuralSwings}).some(m=>samePoints(m,card))).toBe(false);
    // The defect also existed without amplitude compression. It must not be
    // "fixed" by merely disabling a hierarchy or widening ratio tolerance.
    expect(detectHarmonics(cols,{...params,family:'Alternate Bat',tolerance:.15}).some(m=>samePoints(m,card))).toBe(false);
  });
  it('does not keep advertising the same broken XABC scaffold while waiting for D',()=>{
    const card=get(30),times=card.anchors.slice(0,4).map(a=>a.time);
    for(const length of [76,77,78,79]){
      const candidates=detectHarmonicCandidates(view(card,length,false,true),{...params,family:'Alternate Bat'},[]);
      expect(candidates.some(c=>c.points.length===4&&c.points.every((p,i)=>p.time===times[i]))).toBe(false);
    }
  });
  it('keeps contained internal corrections, and confines the guard to source legs rather than later outcomes',()=>{
    const card=get(30),cols=view(card),points=pivots(card);
    expect(harmonicLegsIntact(cols,points)).toBe(false);
    const floor=card.anchors[3].price,ceiling=card.anchors[2].price;
    for(let i=65;i<71;i++)for(const field of ['open','high','low','close'] as const)cols.col(field)[i]=Math.min(ceiling,Math.max(floor,cols.col(field)[i]));
    expect(harmonicLegsIntact(cols,points)).toBe(true);
    cols.col('high')[78]=900000; // After D, not part of the measured XABCD legs.
    expect(harmonicLegsIntact(cols,points)).toBe(true);
    expect(harmonicLegsIntact(cols,[points[0],points[2],points[1],...points.slice(3)])).toBe(false);
    expect(harmonicLegsIntact(cols,points.map((p,i)=>i===2?{...p,value:p.value+1}:p))).toBe(false);
  });
});

describe('unblinded classical-state clarification preserves original frozen review',()=>{
  it.each([6,8,36])('card %i is an explicitly upward continuation, not an incorrectly confirmed downward head-and-shoulders',n=>{
    const card=get(n),all=detectHuzi(view(card),params),match=all.find(m=>m.id===card.predictionId)!;
    expect(match).toBeDefined();expect(match.id.endsWith(':continuation')).toBe(true);
    expect(match.name).toBe('头肩中继上破');expect(match.direction).toBe('bullish');
    expect(match.events?.[0]).toMatchObject({kind:'breakout',boundary:card.anchors[2].price});
    expect(match.events![0].value).toBeGreaterThan(card.anchors[2].price);
    const ms=card.frame==='5m'?300000:60000;
    expect(match.confirmedAt).toBe(card.rows.at(-1)![0]+ms);
    expect(detectHuzi(view(card,card.rows.length-1),params).some(m=>m.id===card.predictionId)).toBe(false);
    expect(all.some(m=>samePoints(m,card)&&m.name==='头肩顶')).toBe(false);
  });
  it('retains the five-touch rising wedge that also supports a four-point-plus-overrun Wolfe interpretation',()=>{
    const card=get(45),match=detectHuzi(view(card),params).find(m=>m.id===card.predictionId)!;
    expect(match).toBeDefined();expect(match.name).toBe('上升楔形');expect(match.direction).toBe('bearish');
    expect(match.ratios.find(r=>r.label==='末端 / 初始宽度')!.value).toBeCloseTo(.7211157381);
    const q=card.anchors.map(a=>a.row),p=card.anchors.map(a=>a.price);
    const slope13=(p[2]-p[0])/(q[2]-q[0]),slope24=(p[3]-p[1])/(q[3]-q[1]);
    expect(slope24).toBeGreaterThan(slope13);expect(slope13).toBeGreaterThan(0);
    expect(p[4]-(p[0]+slope13*(q[4]-q[0]))).toBeCloseTo(5.6791666667);
    const x=[q[0],q[2],q[4]],y=[p[0],p[2],p[4]],mx=x.reduce((a,b)=>a+b)/3,my=y.reduce((a,b)=>a+b)/3;
    const slope=x.reduce((s,xi,i)=>s+(xi-mx)*(y[i]-my),0)/x.reduce((s,xi)=>s+(xi-mx)**2,0),intercept=my-slope*mx;
    const maxResidual=Math.max(...x.map((xi,i)=>Math.abs(y[i]-slope*xi-intercept))),height=Math.max(...p)-Math.min(...p);
    expect(maxResidual/height).toBeLessThan(.04*1.5);
    // Neither family has to become a retrospective synonym of the other.
    expect(match.events?.[0].kind).toBe('breakout');expect(match.status).toBe('confirmed');
  });
});
