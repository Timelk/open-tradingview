import type {ColumnView,ParamValues} from '../core/types';
import type {Pivot} from '../patterns/pivots';
import {appendPivot,confirmedPivotEvents} from '../patterns/pivots';
import {harmonicView} from '../patterns/harmonic-swings';
import type {AnalysisObservation} from './types';
import {availableTime,numberParam} from './features';
import {priceLine,waveObservation,waveSnapshots} from './wave-common';

/** Public five-point geometry, not Bill Wolfe's complete private methodology.
 * The four known points can project a boundary but never manufacture point 5. */
export function detectWolfeWaves(input:ColumnView,params:ParamValues={}):AnalysisObservation[]{
  const found=new Map<string,AnalysisObservation>(),symmetry=numberParam(params,'timeSymmetry',2,1,4),maxOvershoot=numberParam(params,'maxOvershootAtr',2,.25,6),projectionBars=Math.round(numberParam(params,'projectionBars',40,5,300));
  for(const {cols,features,pivots,radius,known,availableAt} of waveSnapshots(input,params)){
    for(const size of params.showDeveloping===false?[5]:[4,5]){
      if(pivots.length<size)continue;
      const points=pivots.slice(-size),[one,two,three,four,five]=points,side=one.kind==='low'?1:-1;
      if(side*(two.value-one.value)<=0||side*(one.value-three.value)<=0||side*(four.value-one.value)<=0||side*(two.value-four.value)<=0)continue;
      const slope13=side*(three.value-one.value)/(three.index-one.index),slope24=side*(four.value-two.value)/(four.index-two.index);
      if(!(slope24<slope13&&slope13<0))continue;
      const widthAt4=side*(four.value-priceLine(one,three,four.index));
      const apex=four.index+widthAt4/(slope13-slope24);
      if(!(widthAt4>0&&apex>four.index&&apex-four.index<=4*(four.index-one.index)))continue;
      if(Math.max(three.index-one.index,four.index-two.index)/Math.min(three.index-one.index,four.index-two.index)>symmetry)continue;
      const atr=features.atr[(five??four).index];if(!Number.isFinite(atr)||atr<=0)continue;
      if(five){
        const overshoot=side*(priceLine(one,three,five.index)-five.value);
        if(five.index>=apex||side*(three.value-five.value)<=0||overshoot<0||overshoot>atr*maxOvershoot||Math.max(three.index-one.index,five.index-three.index)/Math.min(three.index-one.index,five.index-three.index)>symmetry)continue;
      }
      const profile=five?'wolfe-geometry/1.0':'wolfe-scaffold/1.0',item=waveObservation(cols,points,points.map((_,i)=>String(i+1)),five?'Wolfe 五点几何':'Wolfe 1–4 候选',profile,availableAt);
      if(found.has(item.id))continue;
      const step=availableTime(cols,known)-cols.col('time')[known],endIndex=(five??four).index+projectionBars,endTime=(five??four).time+projectionBars*step;
      item.direction=side>0?'bullish':'bearish';item.phase=five?'五点已知 · 等待收回边界':'四点已知 · 等待真实第 5 点';
      item.lines=[{role:'structure',label:'已确认摆动',points:item.points},
        {role:'projection',label:'1–3 边界延长',points:[{...item.points[0]},{label:'1–3',time:endTime,value:priceLine(one,three,endIndex)}]},
        {role:'projection',label:'2–4 边界延长',points:[{...item.points[1]},{label:'2–4',time:endTime,value:priceLine(two,four,endIndex)}]},
        {role:'projection',label:'1–4 几何投射（非成交目标）',points:[{...item.points[0]},{label:'1–4 投射',time:endTime,value:priceLine(one,four,endIndex)}]}];
      item.evidence=[`浪级：左右 ${radius} 柱确认。1–3 与 2–4 同向收敛；第 4 点在第 1、2 点价格之间。`,`交会位置约在第 4 点后 ${(apex-four.index).toFixed(1)} 柱，属于直线几何外推。`,five?`第 5 点真实极值越过 1–3 线 ${(side*(priceLine(one,three,five.index)-five.value)/atr).toFixed(2)} ATR。`:'没有第 5 点，图中只画已知点与投射线。'];
      item.counterEvidence=['这是明确规则的公开五点几何子集，未声称复制原作者完整课程。','1–4 投射线不保证触及，也不是自动止盈或下单指令。'];item.waitingFor=[five?'后续已收盘价格收回 1–3 边界。':'等待真实第 5 极值及其右侧闭柱确认。'];
      const limit=Math.min(features.n,known+Math.round(numberParam(params,'maxTrackingBars',300,10,1500)));
      if(five){
        const risk=five.value-side*atr*numberParam(params,'invalidationAtr',.25,0,3);
        for(let j=known;j<limit;j++){
          if(features.segmentStart[j]!==features.segmentStart[known]){item.dataWarning='后续数据缺口，状态暂停。';break;}
          item.throughTime=availableTime(cols,j);const close=cols.col('close')[j],time=cols.col('time')[j],boundary=priceLine(one,three,j);
          if(side*(close-risk)<0){item.state='invalidated';item.invalidatedAt=item.throughTime;item.events.push({id:`${item.id}:invalid`,kind:'invalidation',label:'第 5 点结构撤销',time,availableAt:item.throughTime,price:close,explanation:'收盘越过第 5 点外侧的设定 ATR 边界。'});break;}
          if(item.state==='observing'&&side*(close-boundary)>0){item.state='confirmed';item.phase='五点几何 · 收盘返回边界';item.events.push({id:`${item.id}:return`,kind:'boundary-return',label:'返回 1–3 边界',time,availableAt:item.throughTime,price:close,explanation:'已知五点之后，收盘价返回 1–3 线内侧。不是成交。'});item.waitingFor=['继续观察结构边界；几何投射与交易决策分开。'];}
        }
        if(limit<features.n&&item.state!=='invalidated'&&!item.dataWarning){item.trackingEndedAt=availableTime(cols,limit-1);item.trackingEndReason='expired';}
      }else{
        const expiredIndex=Math.min(features.n-1,Math.max(known,Math.ceil(apex)));
        for(let j=known;j<=expiredIndex;j++){
          if(features.segmentStart[j]!==features.segmentStart[known]){item.dataWarning='四点候选之后行情有缺口，等待条件暂停。';break;}
          item.throughTime=availableTime(cols,j);
        }
        if(features.n>Math.ceil(apex)&&!item.dataWarning){item.trackingEndedAt=availableTime(cols,Math.ceil(apex));item.trackingEndReason='expired';item.waitingFor=['几何交会时窗已过去，保留原始候选；未补造第 5 点。'];}
      }
      found.set(item.id,item);
    }
  }
  const result=[...found.values()];
  for(const item of result)if(item.points.length===4){
    const complete=result.filter(other=>other.points.length===5&&item.points.every((p,i)=>p.time===other.points[i].time&&p.value===other.points[i].value)).sort((a,b)=>a.availableAt-b.availableAt)[0];
    if(complete){item.trackingEndedAt=complete.availableAt;item.trackingEndReason='departure';item.waitingFor=['真实第 5 点已另建五点记录；此处保留原始四点候选，不回填锚点。'];}
  }
  return result.sort((a,b)=>b.availableAt-a.availableAt).slice(0,numberParam(params,'maxObservations',40,5,300));
}

export interface ElliottValidation {valid:boolean;violations:string[];guidelines:string[];side:number;truncated:boolean}
/** Arithmetic, ordinary non-diagonal impulse rules. Guidance never overrides
 * a failed hard rule; percentage/log variants require a separate rule version. */
export function validateElliottImpulse(values:readonly number[],allowTruncated=false):ElliottValidation {
  const violations:string[]=[],guidelines:string[]=[];
  if(values.length!==6||!values.every(Number.isFinite))return {valid:false,violations:['需要 0–5 六个有限价格锚点'],guidelines,side:0,truncated:false};
  const side=values[1]>values[0]?1:-1,p=values.map(v=>v*side),w1=p[1]-p[0],w3=p[3]-p[2],w5=p[5]-p[4];
  if(w1<=0||w3<=0||w5<=0||p[2]>=p[1]||p[4]>=p[3])violations.push('推进与修正必须交替');
  if(p[2]<=p[0])violations.push('第 2 浪不得回撤第 1 浪的 100%');
  if(p[3]<=p[1])violations.push('第 3 浪必须越过第 1 浪终点');
  if(p[4]<=p[1])violations.push('普通推进浪第 4 浪不得进入第 1 浪价格区间');
  if(w3<Math.min(w1,w5)-1e-10*Math.max(1,w1,w3,w5))violations.push('第 3 浪不能是 1、3、5 中最短者');
  const truncated=p[5]<=p[3];if(truncated&&!allowTruncated)violations.push('当前配置要求第 5 浪越过第 3 浪终点');
  if(w1>0&&w3>0){guidelines.push(`第 3/1 浪长度 ${(w3/w1).toFixed(3)}；第 2 浪回撤 ${((p[1]-p[2])/w1).toFixed(3)}；第 4 浪回撤 ${((p[3]-p[4])/w3).toFixed(3)}。`);if(Math.abs((p[1]-p[2])/w1-(p[3]-p[4])/w3)<.1)guidelines.push('2、4 浪回撤接近，缺少明显幅度交替；指导原则而非硬性否决。');}
  return {valid:violations.length===0,violations,guidelines,side,truncated};
}
function zigzag(values:readonly number[]):boolean {
  if(values.length!==4)return false;const s=values[0]>values[1]?1:-1,p=values.map(v=>v*s);
  return p[0]>p[1]&&p[2]>p[1]&&p[2]<p[0]&&p[3]<p[1];
}
function fineLeg(events:readonly Pivot[],from:Pivot,to:Pivot,knownAt:number):number[]{
  const points:Pivot[]=[];appendPivot(points,from);
  for(const p of events)if(p.index>from.index&&p.index<to.index&&p.confirmedAt<=knownAt)appendPivot(points,p);
  appendPivot(points,to);return points.map(p=>p.value);
}
function subdivisions(points:readonly Pivot[],events:readonly Pivot[],knownAt:number,kind:'impulse'|'abc'):{valid:boolean;counts:number[]} {
  const legs=points.slice(1).map((to,index)=>fineLeg(events,points[index],to,knownAt));
  const expected=kind==='impulse'?[5,3,5,3,5]:[5,3,5];
  return {counts:legs.map(leg=>leg.length-1),valid:legs.every((leg,i)=>leg.length-1===expected[i]&&(expected[i]===5?validateElliottImpulse(leg,true).valid:zigzag(leg)))};
}
/** Finite candidate counts, not a hindsight-selected single narrative. Each
 * scale/anchor combination has an immutable ID and its own first known time. */
export function detectElliottWaves(input:ColumnView,params:ParamValues={}):AnalysisObservation[]{
  const found=new Map<string,AnalysisObservation>(),fine=confirmedPivotEvents(harmonicView(input),1,numberParam(params,'lookback',1800,100,10000));
  for(const {cols,features,pivots,radius,known,availableAt} of waveSnapshots(input,params)){
    const emit=(points:Pivot[],labels:string[],kind:'impulse'|'abc'|'developing',direction:number,proof?:ElliottValidation)=>{
      const item=waveObservation(cols,points,labels,kind==='impulse'?'Elliott 五浪计数':kind==='abc'?'Elliott ABC 修正':'Elliott 推进计数中',`elliott-${kind}/1.0`,availableAt);
      if(found.has(item.id))return;
      item.direction=direction>0?'bullish':'bearish';item.phase=`浪级 L${radius} · ${kind==='developing'?'未完成':'硬规则匹配'}`;
      item.lines=[{role:'structure',label:'真实确认摆动计数',points:item.points}];
      const sub=kind==='developing'?undefined:subdivisions(points,fine,availableAt,kind);
      item.state=kind==='developing'||params.requireSubwaves!==false&&!sub?.valid?'observing':'confirmed';
      item.evidence=[`当前浪级使用左右 ${radius} 柱确认；所有编号锚点都来自真实已确认极值。`,...(proof?.guidelines??[]),kind==='abc'?'A 与 C 逆先行摆动；B 未越过 A 起点，C 越过 A 终点。':kind==='impulse'?'2 浪未全回撤、3 浪越过 1 浪且非最短、4 浪未重叠 1 浪。':'已知 0–3/4；只检查当前可验证硬规则，不绘制尚不存在的后续浪。'];
      if(sub)item.evidence.push(`小一级观测腿数：${sub.counts.join('–')}；${kind==='abc'?'5–3–5':'5–3–5–3–5'} 细分${sub.valid?'匹配':'尚未完整匹配'}。`);
      item.counterEvidence=['浪级和备选计数存在歧义；比例指导不能替代硬规则。','本模块是普通推进与简单 Zigzag 计数，不把对角线、平台或组合修正硬塞入该定义。'];
      if(proof?.truncated)item.counterEvidence.push('允许截短第 5 浪；仅作为备选，需要细分证据。');
      if(sub&&!sub.valid)item.counterEvidence.push('细分未证实，不能称完整 Elliott 形态；默认保留为观察计数。');
      item.waitingFor=item.state==='confirmed'?['观察新计数和相反结构，不把完成五浪自动解释为买卖。']:['等待真实后续极值或更小浪级细分验证。'];
      if(kind==='developing'){
        const boundary=points[1].value,side=direction;
        for(let j=known;j<Math.min(features.n,known+300);j++){
          if(features.segmentStart[j]!==features.segmentStart[known]){item.dataWarning='后续数据缺口，计数暂停。';break;}
          item.throughTime=availableTime(cols,j);
          if(side*(cols.col('close')[j]-boundary)<=0){item.state='invalidated';item.invalidatedAt=item.throughTime;item.events.push({id:`${item.id}:overlap`,kind:'invalidation',label:'普通推进计数撤销',time:cols.col('time')[j],availableAt:item.throughTime,price:cols.col('close')[j],explanation:'预期第 4 浪或后续摆动进入第 1 浪价格区间。'});break;}
        }
      }
      found.set(item.id,item);
    };
    if(pivots.length>=6){const points=pivots.slice(-6),proof=validateElliottImpulse(points.map(p=>p.value),params.allowTruncated===true);if(proof.valid)emit(points,['0','1','2','3','4','5'],'impulse',proof.side,proof);}
    if(params.showABC!==false&&pivots.length>=5){const points=pivots.slice(-4),before=pivots.at(-5)!;if(zigzag(points.map(p=>p.value))&&(points[0].value-points[1].value)*(points[0].value-before.value)>0)emit(points,['0','A','B','C'],'abc',points[3].kind==='low'?-1:1);}
    if(params.showDeveloping!==false)for(const size of [4,5]){
      if(pivots.length<size)continue;const points=pivots.slice(-size),s=points[1].value>points[0].value?1:-1,p=points.map(p=>p.value*s);
      if(p[1]>p[0]&&p[2]>p[0]&&p[2]<p[1]&&p[3]>p[1]&&(size===4||p[4]>p[1]&&p[4]<p[3]))emit(points,points.map((_,i)=>String(i)),'developing',s);
    }
  }
  const all=[...found.values()].sort((a,b)=>a.availableAt-b.availableAt||a.id.localeCompare(b.id)),maxAlternatives=Math.round(numberParam(params,'maxAlternatives',3,1,6));
  const peers=new Map<number,AnalysisObservation[]>();
  for(const item of all){const group=peers.get(item.availableAt)??[];group.push(item);peers.set(item.availableAt,group);}
  for(const group of peers.values()){
    // Rank only simultaneous, already-known evidence. Later invalidations of
    // developing hypotheses cannot alter which historical count was primary.
    const quality=(item:AnalysisObservation)=>(item.ruleVersion.includes('developing')?0:10)+(item.ruleVersion.includes('impulse')?3:0)+(item.state==='confirmed'?5:0);
    const primary=[...group].sort((a,b)=>quality(b)-quality(a)||a.id.localeCompare(b.id))[0];
    for(const item of group)item.phase+=item===primary?' · 主计数':' · 备选计数';
  }
  // Alternatives are only counts already knowable at this record's timestamp.
  // Later, more attractive counts never rewrite its original numbering.
  for(let i=0;i<all.length;i++){
    const item=all[i],start=item.points[0].time,end=item.time;
    const alternatives=all.slice(Math.max(0,i-80),i).filter(other=>other.id!==item.id&&other.time>=start&&other.points[0].time<=end&&!(other.invalidatedAt!==undefined&&other.invalidatedAt<=item.availableAt)).slice(-maxAlternatives);
    item.alternatives=alternatives.map(other=>`${other.name} · ${other.phase} · ${other.points.map(p=>p.label).join('-')} · 起点 ${new Date(other.points[0].time).toISOString()}`);
    item.evidence.push(`按首次可知时点的硬规则/细分证据排序；另有 ${alternatives.length} 个当时已知且重叠的备选计数。排序不是盈利概率。`);
  }
  return all.reverse().slice(0,numberParam(params,'maxObservations',50,5,300));
}
