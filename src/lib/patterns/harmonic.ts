import type { ColumnView, ParamValues } from '../core/types';
import type {Pivot} from './pivots';
import {HARMONIC_RULES as RULES, type HarmonicFamily as Family,type Range} from './harmonic-rules';
import {harmonicView,harmonicSwings,harmonicStep,harmonicConsecutive,validHarmonicBar,harmonicLegsIntact} from './harmonic-swings';
import {extraHarmonicSetups} from './harmonic-extra';
export {HARMONIC_FAMILIES} from './harmonic-rules';
import type { PatternMatch, PatternRatio } from './types';
import {resolvePatternLifecycle} from './lifecycle';
import {buildConfluenceSeries,type ConfluenceSeries} from './confluence';
import {harmonicSignals} from './harmonic-signals';

function numeric(params:ParamValues,key:string,fallback:number,min:number,max:number):number {
  const value=Number(params[key]);
  return Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
}
function inRange(value:number,[min,max]:Range,tolerance:number):boolean {
  return Number.isFinite(value)&&value>=min*(1-tolerance)-1e-10&&value<=max*(1+tolerance)+1e-10;
}
function rangeText([min,max]:Range):string {
  return min===max?min.toFixed(3):!Number.isFinite(max)?`≥ ${min.toFixed(3)}`:`${min.toFixed(3)}–${max.toFixed(3)}`;
}
function ratio(label:string,value:number,expected:Range):PatternRatio {
  return {label,value,expected:rangeText(expected)};
}

/** Intersect projection bands: the PRZ must be supported by more than one leg. */
function projectionZone(projections:{anchor:number;leg:number;range:Range}[],direction:number,tolerance:number):{low:number;high:number}|undefined {
  let low=-Infinity,high=Infinity;
  for(const projection of projections){
    const [min,max]=projection.range;
    const first=projection.anchor-direction*projection.leg*min*(1-tolerance);
    const last=projection.anchor-direction*projection.leg*max*(1+tolerance);
    low=Math.max(low,Math.min(first,last));high=Math.min(high,Math.max(first,last));
  }
  return Number.isFinite(low)&&Number.isFinite(high)&&low<=high?{low,high}:undefined;
}

function makeMatch(family:Family,name:string,points:Pivot[],labels:string[],ratios:PatternRatio[],zone:{low:number;high:number},reference:string,invalidation?:number):PatternMatch {
  const d=points[points.length-1],c=points[points.length-2],direction=d.kind==='low'?1:-1;
  const height=Math.max(...points.map(point=>point.value))-Math.min(...points.map(point=>point.value));
  const far=direction>0?zone.low:zone.high;
  return {
    id:`harmonic:${family}:${points.map(point=>point.time).join(':')}`,
    family,name:`${name} · ${family}`,direction:direction>0?'bullish':'bearish',ruleVersion:'harmonic/2.1-source-legs',
    points:points.map((point,index)=>({label:labels[index],time:point.time,value:point.value})),
    confirmedAt:d.confirmedAt,zone,
    invalidation:invalidation??far-direction*height*.05,
    targets:[.382,.618].map(level=>d.value+direction*Math.abs(c.value-d.value)*level),
    ratios,status:'confirmed',
    description:`${reference}。${labels.at(-1)} 点右侧闭合 K 柱确认后识别；图形锚定实际完成点，确认时间独立记录。PRZ 由结构投影与所设容差构成。${invalidation===undefined?'失效参考为 PRZ 远端外扩结构高度的 5%。':'失效参考为起点 X。'}辅助参考为最后一腿的 38.2% / 61.8% 回撤，是工程默认测量，不是该家族完整交易管理法，不代表已成交或获利概率。`,
  };
}

function xabcd(points:Pivot[],tolerance:number,family:string):PatternMatch[] {
  const [x,a,b,c,d]=points,side=d.kind==='low'?1:-1;
  const xa=(a.value-x.value)*side,ab=(a.value-b.value)*side,bc=(c.value-b.value)*side,cd=(c.value-d.value)*side;
  if(Math.min(xa,ab,bc,cd)<=0||b.value*side<=x.value*side||c.value*side>=a.value*side||d.value*side>=b.value*side)return [];
  const rb=ab/xa,rc=bc/ab,rd=(a.value-d.value)*side/xa,rbc=cd/bc,rabcd=cd/ab;
  const matches:PatternMatch[]=[];
  for(const rule of RULES){
    if(family!=='全部'&&family!==rule.family)continue;
    if(!inRange(rb,rule.b,tolerance)||!inRange(rc,rule.c,tolerance)||!inRange(rd,[rule.d,rule.d],tolerance)||!inRange(rbc,rule.bc,tolerance))continue;
    if(rule.abcd&&!inRange(rabcd,rule.abcd,tolerance))continue;
    // Classification boundaries are structural, so tolerance cannot turn a
    // retracement into an extension, a Bat into a Gartley, or a deep B past X.
    if(rule.retracement&&d.value*side<=x.value*side)continue;
    if(!rule.retracement&&d.value*side>=x.value*side)continue;
    if(rule.family==='Bat'&&rb>=.618)continue;
    if(rule.family==='Deep Crab'&&(rb<.886||rb>=1))continue;
    if(rule.family==='Alternate Bat'&&rb>.382)continue;
    const projections=[{anchor:a.value,leg:xa,range:[rule.d,rule.d] as Range},{anchor:c.value,leg:bc,range:rule.bc}];
    if(rule.abcd)projections.push({anchor:c.value,leg:ab,range:rule.abcd});
    const zone=projectionZone(projections,side,tolerance);
    if(!zone||d.value<zone.low-1e-8||d.value>zone.high+1e-8)continue;
    const ratios=[ratio('AB / XA',rb,rule.b),ratio('BC / AB',rc,rule.c),ratio('AD / XA',rd,[rule.d,rule.d]),ratio('CD / BC',rbc,rule.bc)];
    if(rule.abcd)ratios.push(ratio('CD / AB',rabcd,rule.abcd));
    matches.push(makeMatch(rule.family,rule.name,points,['X','A','B','C','D'],ratios,zone,rule.reference,rule.retracement?x.value:undefined));
  }
  return matches;
}

function abcd(points:Pivot[],tolerance:number,includeAlternate:boolean):PatternMatch|undefined {
  const [a,b,c,d]=points,side=d.kind==='low'?1:-1;
  const ab=(a.value-b.value)*side,bc=(c.value-b.value)*side,cd=(c.value-d.value)*side;
  if(Math.min(ab,bc,cd)<=0||c.value*side>=a.value*side||d.value*side>=b.value*side)return;
  if(!inRange(bc/ab,[.382,.886],tolerance))return;
  const multiple=[1,...(includeAlternate?[1.27,1.618]:[])].find(value=>inRange(cd/ab,[value,value],tolerance));
  if(multiple===undefined)return;
  // Alternate AB=CD is not an arbitrary stretched equal-leg pattern. Volume
  // One pp. 69–77 requires another Fibonacci projection to support its PRZ.
  // Keep the original equivalent rule; extensions require a discrete BC level.
  const extension=multiple!==1;
  const projection=extension?[1.618,2,2.24,2.618,3.14,3.618].find(value=>inRange(cd/bc,[value,value],tolerance)):undefined;
  if(extension&&projection===undefined)return;
  const bcRange:Range=extension?[projection!,projection!]:[1.13,2.618];
  if(!inRange(cd/bc,bcRange,tolerance))return;
  const zone=projectionZone([{anchor:c.value,leg:ab,range:[multiple,multiple]},{anchor:c.value,leg:bc,range:bcRange}],side,tolerance);
  if(!zone)return;
  return makeMatch('AB=CD',extension?`${multiple} 延伸 AB=CD`:'等幅形态',points,['A','B','C','D'],[ratio('BC / AB',bc/ab,[.382,.886]),ratio('CD / AB',cd/ab,[multiple,multiple]),ratio('CD / BC',cd/bc,bcRange)],zone,extension?'卷一 · Alternate AB=CD（延伸腿与 BC 投影共振）':'卷一 · AB=CD');
}

function fiveZero(points:Pivot[],tolerance:number):PatternMatch|undefined {
  const [zero,x,a,b,c,d]=points,side=d.kind==='low'?1:-1;
  const xa=(a.value-x.value)*side,ab=(a.value-b.value)*side,bc=(c.value-b.value)*side,cd=(c.value-d.value)*side;
  if(Math.min(xa,ab,bc,cd)<=0||zero.value*side<=a.value*side||b.value*side>=x.value*side||c.value*side<=a.value*side||d.value*side<=b.value*side)return;
  if(!inRange(ab/xa,[1.13,1.618],tolerance)||!inRange(bc/ab,[1.618,2.24],tolerance)||!inRange(cd/bc,[.5,.5],tolerance))return;
  // Reciprocal AB=CD is a confluence measurement, not an extra exact equality:
  // BC/AB can legitimately range 1.618–2.24 in the original definition.
  const half=c.value-side*bc*.5,reciprocal=c.value-side*ab;
  const zone={low:Math.min(half,reciprocal)-bc*.5*tolerance,high:Math.max(half,reciprocal)+bc*.5*tolerance};
  return makeMatch('5-0','5-0 反转回撤',points,['0','X','A','B','C','D'],[ratio('AB / XA',ab/xa,[1.13,1.618]),ratio('BC / AB',bc/ab,[1.618,2.24]),ratio('CD / BC',cd/bc,[.5,.5]),{label:'CD / AB',value:cd/ab,expected:'1.000（PRZ 辅助参考）'}],zone,'卷二 · 5-0（50% BC 与 Reciprocal AB=CD）');
}

/** Causal detector: replay immutable pivot confirmations, retaining each matched
 * D snapshot even if a later same-side pivot replaces the latest zigzag point.
 * The final candle is always treated as forming; no prospective shape is emitted. */
export function detectHarmonics(input:ColumnView,params:ParamValues={}):PatternMatch[] {
  const cols=harmonicView(input);
  const lookback=Math.round(numeric(params,'lookback',1500,50,10000));
  const tolerance=numeric(params,'tolerance',.04,.001,.15);
  const limit=Math.round(numeric(params,'maxPatterns',12,1,1000));
  const family=String(params.family??'全部');
  const found=new Map<string,{match:PatternMatch;scanFrom:number}>();
  for(const {pivots,event,radius,retracement} of harmonicSwings(cols,params,lookback)){
    const matches:PatternMatch[]=[];
    if(pivots.length>=5)matches.push(...xabcd(pivots.slice(-5),tolerance,family));
    if((family==='全部'||family==='AB=CD')&&pivots.length>=4){const match=abcd(pivots.slice(-4),tolerance,params.includeAlternateABCD!==false);if(match)matches.push(match);}
    if((family==='全部'||family==='5-0')&&pivots.length>=6){const match=fiveZero(pivots.slice(-6),tolerance);if(match)matches.push(match);}
    const terminal=pivots.at(-1)!;
    for(const setup of extraHarmonicSetups(pivots.slice(0,-1),params)){
      const ratios=setup.complete(terminal);
      if(!ratios||terminal.value<setup.zone.low||terminal.value>setup.zone.high)continue;
      matches.push(makeMatch(setup.family,setup.name,[...setup.points,terminal],[...setup.labels,setup.terminalLabel],[...setup.ratios,...ratios],setup.zone,setup.reference,setup.invalidation));
    }
    for(const match of matches){
      if(!harmonicLegsIntact(cols,pivots.slice(-match.points.length)))continue;
      match.confirmedAt=Math.max(match.confirmedAt,event.confirmedAt);
      const existing=found.get(match.id);
      if(existing&&existing.match.confirmedAt<=match.confirmedAt)continue;
      match.pivotStrength=radius;
      if(retracement)match.description+=` 结构摆动层级压缩不超过前腿 ${(retracement*100).toFixed(1)}% 且已出现确认延伸的内部回撤；比例与 PRZ 容差未放宽。`;
      found.set(match.id,{match,scanFrom:event.index+radius+1});
    }
  }
  const high=cols.col('high'),low=cols.col('low'),time=cols.col('time');
  const result:PatternMatch[]=[],step=harmonicStep(cols);
  // Reading aids at D (MACD divergence, ATR reference, pin bar) come from the same closed candles and never change
  // what is recognised, when it is known, or how it is ordered; only `requireDivergence` hides matches without one.
  const wantSignals=params.harmonicSignals!==false,needDivergence=params.requireDivergence===true;
  const signalOptions={atrPeriod:Math.round(numeric(params,'atrPeriod',14,5,50)),atrMultiple:numeric(params,'atrStopMultiple',2,.5,6),radius:Math.round(numeric(params,'pivotStrength',3,1,30))};
  let series:ConfluenceSeries|undefined;
  for(const {match,scanFrom} of [...found.values()].sort((a,b)=>b.match.confirmedAt-a.match.confirmedAt||a.match.family.localeCompare(b.match.family))){
    if(wantSignals||needDivergence){
      series??=buildConfluenceSeries(cols,50,{requireContinuousTime:true});
      const evidence=harmonicSignals(match,cols,series,signalOptions);
      if(needDivergence&&!evidence?.signals.macd)continue;
      if(evidence&&wantSignals){
        match.signals=evidence.signals;
        if(evidence.divergences.length)match.divergences=evidence.divergences;
        match.ratios=[...match.ratios,...evidence.ratios];
        match.description+=evidence.sentences.join('');
      }
    }
    for(let i=scanFrom;i<cols.length-1;i++){
      if(!validHarmonicBar(cols,i)||i>0&&!harmonicConsecutive(time[i-1],time[i],step)){match.dataWarning='后续行情存在缺口；保留缺口前的历史结构，当前有效性未知。';break;}
      if(match.direction==='bullish'?low[i]<match.invalidation:high[i]>match.invalidation){
        match.status='invalidated';match.invalidatedAt=time[i+1];break;
      }
    }
    const resolved=resolvePatternLifecycle(match,cols);
    if(params.showInvalidated===true||resolved.status==='confirmed')result.push(resolved);
    if(result.length>=limit)break;
  }
  return result;
}
