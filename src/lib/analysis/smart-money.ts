import type {ColumnView,ParamValues} from '../core/types';
import type {AnalysisEvent,AnalysisObservation} from './types';
import {analyzeBars,availableTime,closedBars,continuous,numberParam,validCandle} from './features';
import {detectMarketStructure} from './structure';

const np=numberParam;
const DISCLAIMER='本平台的可复现价格事件定义，不确认机构持仓、意图或真实挂单。';
interface Block {from:number;to:number;low:number;high:number;fvg?:{index:number;low:number;high:number}}
interface Swing {index:number;price:number;kind:'high'|'low';availableAt:number}
export interface SessionStamp {day:string;minute:number;second:number;weekday:number}
export interface SessionRange {kind:'day'|'session';key:string;fromTime:number;throughTime:number;availableAt:number;high:number;low:number}
const clocks=new Map<string,Intl.DateTimeFormat>();
function clock(zone:string):Intl.DateTimeFormat {
  let formatter=clocks.get(zone);
  if(!formatter){formatter=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});clocks.set(zone,formatter);}
  return formatter;
}
export function localSessionTime(time:number,zone='America/New_York'):SessionStamp {
  const p=Object.fromEntries(clock(zone).formatToParts(time).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  return {day:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute),second:Number(p.second),weekday:new Date(Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day))).getUTCDay()};
}
function previousDay(day:string):string {return new Date(Date.parse(`${day}T00:00:00Z`)-86400000).toISOString().slice(0,10);}
/** Local wall-clock windows automatically follow the chosen IANA zone's DST. */
export function sessionMembership(time:number,zone:string,start:number,end:number):{inside:boolean;key:string;stamp:SessionStamp} {
  return membership(localSessionTime(time,zone),start,end);
}
function membership(stamp:SessionStamp,start:number,end:number):{inside:boolean;key:string;stamp:SessionStamp} {
  const overnight=start>=end;
  const inside=start===end||(!overnight?stamp.minute>=start&&stamp.minute<end:stamp.minute>=start||stamp.minute<end);
  return {inside,key:overnight&&stamp.minute<end||start===end&&stamp.minute<start?previousDay(stamp.day):stamp.day,stamp};
}
function scoped(cols:ColumnView,p:ParamValues):ColumnView {
  const n=closedBars(cols),start=Math.max(0,n-Math.round(np(p,'lookback',3000,100,10000)));
  return {length:n-start,closedLength:n-start,intervalMs:cols.intervalMs,col:key=>cols.col(key).subarray(start,n),flow:key=>cols.flow?.(key)?.subarray(start,n)};
}
function emit(o:AnalysisObservation,kind:string,label:string,index:number,price:number,explanation:string,cols:ColumnView):void {
  const time=cols.col('time')[index];o.events.push({id:`${o.id}:${kind}:${time}`,kind,label,time,price,availableAt:availableTime(cols,index),explanation});
}
function born(cols:ColumnView,id:string,name:string,start:number,known:number,bull:boolean):AnalysisObservation {
  return {id,family:'smc',name,ruleVersion:'smc-ict/observable-1',direction:bull?'bullish':'bearish',state:'observing',
    time:cols.col('time')[start],availableAt:availableTime(cols,known),throughTime:availableTime(cols,known),points:[],events:[],evidence:[],counterEvidence:[DISCLAIMER],waitingFor:[]};
}
function findFvg(cols:ColumnView,index:number,bull:boolean,atr:Float64Array,segment:Int32Array,p:ParamValues):Block['fvg'] {
  if(index<2||segment[index]!==segment[index-2])return;
  if(bull?cols.col('close')[index-1]<=cols.col('open')[index-1]:cols.col('close')[index-1]>=cols.col('open')[index-1])return;
  const low=bull?cols.col('high')[index-2]:cols.col('high')[index],high=bull?cols.col('low')[index]:cols.col('low')[index-2];
  if(high-low>=atr[index]*np(p,'minGapAtr',.1,.01,2))return {index,low,high};
}
function displaced(cols:ColumnView,i:number,bull:boolean,atr:Float64Array,p:ParamValues):boolean {
  const o=cols.col('open')[i],c=cols.col('close')[i],h=cols.col('high')[i],l=cols.col('low')[i];
  return (bull?c-o:o-c)>=atr[i]*np(p,'displacementAtr',1,0.5,5)
    &&(bull?c-l:h-c)>=Math.max(h-l,1e-12)*np(p,'closeStrength',.65,.5,.95);
}
function findBlock(cols:ColumnView,i:number,bull:boolean,atr:Float64Array,segment:Int32Array,p:ParamValues):Block|undefined {
  const o=cols.col('open'),c=cols.col('close'),h=cols.col('high'),l=cols.col('low');
  const max=Math.round(np(p,'baseLookback',12,2,60));let base=i-1;
  while(base>=Math.max(segment[i],i-max)&&(bull?c[base]>=o[base]:c[base]<=o[base]))base--;
  if(base<Math.max(segment[i],i-max))return;
  let from=base;
  if(p.baseMode==='opposite-cluster')while(from>Math.max(segment[i],i-max)&&base-from<3&&(bull?c[from-1]<o[from-1]:c[from-1]>o[from-1]))from--;
  let low=Infinity,high=-Infinity;
  for(let j=from;j<=base;j++){
    const mode=String(p.zoneMode??'wick');
    low=Math.min(low,mode==='body'?Math.min(o[j],c[j]):mode==='open-to-extreme'&&!bull?o[j]:l[j]);
    high=Math.max(high,mode==='body'?Math.max(o[j],c[j]):mode==='open-to-extreme'&&bull?o[j]:h[j]);
  }
  if(!(high>low))return;
  for(let j=base+1;j<i;j++)if(bull?c[j]<low:c[j]>high)return;
  let fvg:Block['fvg'];for(let j=base+2;j<=i;j++){const gap=findFvg(cols,j,bull,atr,segment,p);if(gap)fvg=gap;}
  if(p.requireFvg===true&&!fvg)return;
  return {from,to:base,low,high,fvg};
}
function lifecycle(o:AnalysisObservation,cols:ColumnView,at:number,bull:boolean,segment:Int32Array,p:ParamValues):void {
  if(!o.zone)return;
  const n=closedBars(cols),end=Math.min(n,at+Math.round(np(p,'maxLifeBars',300,10,1500))+1),h=cols.col('high'),l=cols.col('low'),c=cols.col('close'),t=cols.col('time');
  let revisited=false,mitigated=false;
  const depth=np(p,'mitigationDepth',.5,0,1),inside=bull?o.zone.high-(o.zone.high-o.zone.low)*depth:o.zone.low+(o.zone.high-o.zone.low)*depth;
  for(let j=at+1;j<end;j++){
    if(segment[j]!==segment[at]||!validCandle(cols,j)){o.dataWarning='后续行情缺口，区域状态停止续接。';o.trackingEndedAt=availableTime(cols,j-1);break;}
    o.zone.toTime=t[j];o.throughTime=availableTime(cols,j);
    const invalid=p.invalidationMode==='wick'?(bull?l[j]<o.zone.low:h[j]>o.zone.high):(bull?c[j]<o.zone.low:c[j]>o.zone.high);
    if(invalid){emit(o,'invalidation','区域失效',j,c[j],'已收盘行情穿越区域远端；不推测同柱内先后成交。',cols);o.state='invalidated';o.invalidatedAt=availableTime(cols,j);o.waitingFor=[];break;}
    if(h[j]>=o.zone.low&&l[j]<=o.zone.high){
      if(!revisited){emit(o,'revisit','首次回访',j,bull?Math.min(o.zone.high,h[j]):Math.max(o.zone.low,l[j]),'价格首次进入已经公开的区域。',cols);revisited=true;o.phase='区域已回访';}
      if(!mitigated&&(bull?l[j]<=inside:h[j]>=inside)){emit(o,'mitigation','达到回访深度',j,inside,`触及区域 ${Math.round(depth*100)}% 深度；不是委托成交或已获利。`,cols);mitigated=true;o.phase='已达到设定回访深度';}
    }
  }
  if(end<n&&o.state!=='invalidated'&&!o.trackingEndedAt){o.trackingEndedAt=availableTime(cols,end-1);o.trackingEndReason='expired';o.waitingFor=[];}
}

/** OB requires an actual closed structural break AND directional displacement.
 * Its origin is a configurable preceding opposing candle/base, not an FVG
 * renamed as an order block. */
export function detectOrderBlocks(input:ColumnView,params:ParamValues={}):AnalysisObservation[] {
  const cols=scoped(input,params),{atr,segmentStart}=analyzeBars(cols),t=cols.col('time');
  const breaks=detectMarketStructure(cols,{...params,showSwings:false,maxObservations:300}).filter(o=>o.events.some(e=>e.kind==='breakout')).reverse();
  const result:AnalysisObservation[]=[],used=new Set<string>();
  for(const breakout of breaks){
    const i=t.subarray(0,cols.length).indexOf(breakout.time),bull=breakout.direction==='bullish';
    if(i<0||!displaced(cols,i,bull,atr,params))continue;
    const block=findBlock(cols,i,bull,atr,segmentStart,params);if(!block)continue;
    const id=`order-block:${bull?'bull':'bear'}:${t[block.from]}`;if(used.has(id))continue;used.add(id);
    const o=born(cols,id,bull?'看涨 Order Block':'看跌 Order Block',block.from,i,bull);o.state='confirmed';o.phase='区域已建立 · 等待回访';
    o.zone={low:block.low,high:block.high,fromTime:t[block.from],toTime:t[i]};
    o.points=[{label:'OB 基底',time:t[block.from],value:bull?block.low:block.high},...breakout.points];
    o.lines=breakout.lines;
    o.evidence=[...breakout.evidence,`破位柱方向实体 / ATR ${(Math.abs(cols.col('close')[i]-cols.col('open')[i])/atr[i]).toFixed(2)}`,
      `基底：${params.baseMode==='opposite-cluster'?'连续反向蜡烛':'最后一根反向蜡烛'}；区域口径 ${String(params.zoneMode??'wick')}`];
    emit(o,'activation','推进 + 结构破位',i,cols.col('close')[i],'破位柱收盘后，历史基底才成为可知的 OB 候选区域。',cols);
    if(block.fvg){o.evidence.push(`同段推进已形成 FVG：${block.fvg.low} — ${block.fvg.high}`);emit(o,'fvg','同段 FVG',block.fvg.index,block.fvg.low,'第三柱已收盘后才记录价差关系。',cols);}
    else o.counterEvidence.push('本次推进尚未形成符合阈值的三柱 FVG。');
    o.events.sort((a,b)=>a.availableAt-b.availableAt||a.time-b.time);
    o.waitingFor=['观察回访深度与区域远端是否被穿越。'];lifecycle(o,cols,i,bull,segmentStart,params);result.push(o);
  }
  return result.reverse().slice(0,Math.round(np(params,'maxObservations',60,5,300)));
}

/** One entry per candle contains only previously completed, fully covered
 * local days/sessions. A partial first session is never a "previous high". */
export function priorSessionRanges(cols:ColumnView,zone:string,start:number,end:number):SessionRange[][] {
  const n=closedBars(cols),out:SessionRange[][]=[],t=cols.col('time'),h=cols.col('high'),l=cols.col('low');
  type Acc=SessionRange&{complete:boolean};let day:Acc|undefined,session:Acc|undefined,lastDay:SessionRange|undefined,lastSession:SessionRange|undefined;
  let previousCloseTime=NaN,previousClose:SessionStamp|undefined;
  for(let i=0;i<n;i++){
    if(!validCandle(cols,i)){out.push([]);day=session=undefined;continue;}
    const current=previousCloseTime===t[i]&&previousClose?previousClose:localSessionTime(t[i],zone),known=availableTime(cols,i),close=localSessionTime(known,zone),member=membership(current,start,end);
    previousCloseTime=known;previousClose=close;
    const endedDay=current.minute>=end?current.day:previousDay(current.day),expectedSession=start>=end?previousDay(endedDay):endedDay;
    out.push([lastDay?.key===previousDay(current.day)?lastDay:undefined,lastSession?.key===expectedSession?lastSession:undefined]
      .filter((v):v is SessionRange=>!!v&&v.availableAt<=t[i]));
    const gap=i>0&&!continuous(cols,i);if(gap){day=session=undefined;}
    if(!day||day.key!==current.day)day={kind:'day',key:current.day,fromTime:t[i],throughTime:t[i],availableAt:known,high:h[i],low:l[i],complete:current.minute===0&&current.second===0};
    else{day.high=Math.max(day.high,h[i]);day.low=Math.min(day.low,l[i]);day.throughTime=t[i];day.availableAt=known;}
    if(close.day!==current.day&&close.minute===0&&close.second===0){if(day.complete)lastDay={...day};day=undefined;}
    if(member.inside){
      if(!session||session.key!==member.key)session={kind:'session',key:member.key,fromTime:t[i],throughTime:t[i],availableAt:known,high:h[i],low:l[i],complete:current.minute===start&&current.second===0};
      else{session.high=Math.max(session.high,h[i]);session.low=Math.min(session.low,l[i]);session.throughTime=t[i];session.availableAt=known;}
      const after=membership(close,start,end);
      if(close.minute===end&&close.second===0&&(!after.inside||after.key!==member.key)){if(session.complete)lastSession={...session};session=undefined;}
    }else session=undefined;
  }
  return out;
}
function swings(cols:ColumnView,radius:number,segment:Int32Array):Swing[]{
  const n=closedBars(cols),out:Swing[]=[],h=cols.col('high'),l=cols.col('low');
  for(let i=radius;i+radius<n;i++){
    if(segment[i-radius]!==segment[i+radius])continue;
    let high=true,low=true;
    for(let j=i-radius;j<=i+radius;j++)if(j!==i){high=high&&(j<i?h[i]>=h[j]:h[i]>h[j]);low=low&&(j<i?l[i]<=l[j]:l[i]<l[j]);}
    if(high!==low)out.push({index:i,price:high?h[i]:l[i],kind:high?'high':'low',availableAt:availableTime(cols,i+radius)});
  }
  return out;
}

/** A configurable sequence: prior completed level sweep -> later displacement
 * and known-swing break -> FVG and/or OB. Session names are operational presets,
 * not a claim to implement every teaching of ICT or an institutional model. */
export function detectIctSetups(input:ColumnView,params:ParamValues={}):AnalysisObservation[] {
  const cols=scoped(input,params),n=closedBars(cols);if(n<10||(cols.intervalMs??60000)>3600000)return [];
  const zone=String(params.timeZone??'America/New_York');clock(zone);
  const start=Math.round(np(params,'sessionStart',1200,0,1439)),end=Math.round(np(params,'sessionEnd',0,0,1439));
  const kzStart=Math.round(np(params,'killzoneStart',420,0,1439)),kzEnd=Math.round(np(params,'killzoneEnd',600,0,1439));
  const refs=priorSessionRanges(cols,zone,start,end),{atr,segmentStart}=analyzeBars(cols),pivots=swings(cols,Math.round(np(params,'pivotStrength',2,1,10)),segmentStart);
  const t=cols.col('time'),h=cols.col('high'),l=cols.col('low'),c=cols.col('close'),out:AnalysisObservation[]=[],used=new Map<string,number>();
  const model=String(params.entryModel??'fvg'),reference=String(params.reference??'either'),wait=Math.round(np(params,'maxSetupBars',18,2,100));
  const memberships=new Map<number,ReturnType<typeof sessionMembership>>();
  const killzone=(time:number)=>{let found=memberships.get(time);if(!found){found=sessionMembership(time,zone,kzStart,kzEnd);memberships.set(time,found);}return found;};
  for(let i=5;i<n;i++){
    if(!Number.isFinite(atr[i])||!validCandle(cols,i))continue;
    const member=killzone(t[i]);
    if(params.killzoneOnly!==false&&!member.inside||params.weekdaysOnly===true&&(member.stamp.weekday===0||member.stamp.weekday===6))continue;
    const levels=refs[i].filter(ref=>reference==='either'||ref.kind===reference).filter((ref,index,all)=>
      all.findIndex(other=>other.high===ref.high&&other.low===ref.low&&other.availableAt===ref.availableAt)===index);
    for(const ref of levels){
      const pad=atr[i]*np(params,'sweepAtr',.05,0,1),up=h[i]>ref.high+pad&&c[i]<ref.high,down=l[i]<ref.low-pad&&c[i]>ref.low;
      if(up===down)continue;const bull=down,referenceKey=`ict:${ref.kind}:${ref.key}:${bull?'bull':'bear'}`,key=`${referenceKey}:${t[i]}`;
      if(i-(used.get(referenceKey)??-Infinity)<np(params,'minSweepSpacing',6,1,100))continue;used.set(referenceKey,i);
      const target=pivots.filter(p=>p.availableAt<=t[i]&&p.index>=segmentStart[i]&&p.kind===(bull?'high':'low')).at(-1);
      const o=born(cols,key,bull?'ICT 向上事件组合':'ICT 向下事件组合',i,i,bull);
      o.phase='已扫过参考位 · 等待结构转向';o.evidence=[`${zone} · ${member.stamp.day} ${String(Math.floor(member.stamp.minute/60)).padStart(2,'0')}:${String(member.stamp.minute%60).padStart(2,'0')}`,
        `参考已完整结束的${ref.kind==='day'?'当地前日':'前时段'}高低点：${ref.low} — ${ref.high}`];
      o.points=[{label:'参考位',time:ref.throughTime,value:bull?ref.low:ref.high},{label:'Sweep',time:t[i],value:bull?l[i]:h[i]}];
      o.lines=[{role:'boundary',label:ref.kind==='day'?'前日参考位':'前时段参考位',points:[{label:'',time:ref.fromTime,value:bull?ref.low:ref.high},{label:'',time:t[i],value:bull?ref.low:ref.high}]}];
      emit(o,'sweep','越过后收回',i,bull?l[i]:h[i],'影线越过已知参考位且收盘收回；没有观测到真实止损或机构订单。',cols);
      o.waitingFor=['等待后续推进收盘越过扫单前已经可知的反向波段点。'];
      let shifted=-1,block:Block|undefined,confirmed=-1;
      for(let j=i+1;j<Math.min(n,i+wait+1);j++){
        o.throughTime=availableTime(cols,j);
        if(segmentStart[j]!==segmentStart[i]){o.throughTime=availableTime(cols,j-1);o.trackingEndedAt=o.throughTime;o.dataWarning='后续数据缺口，事件组合停止续接。';break;}
        if(params.killzoneOnly!==false&&!killzone(t[j]).inside){o.trackingEndedAt=availableTime(cols,j-1);o.trackingEndReason='expired';break;}
        if(bull?c[j]<l[i]:c[j]>h[i]){o.state='invalidated';o.invalidatedAt=availableTime(cols,j);emit(o,'invalidation','扫过后的方向假设失效',j,c[j],'推进确认之前已收盘穿越扫过极值。',cols);break;}
        if(shifted<0&&target&&(bull?c[j]>target.price:c[j]<target.price)&&displaced(cols,j,bull,atr,params)){
          shifted=j;block=findBlock(cols,j,bull,atr,segmentStart,{...params,requireFvg:false});
          emit(o,'mss','推进 + MSS',j,c[j],`收盘越过扫过前已知波段位 ${target.price}，并满足方向实体 / ATR 阈值。`,cols);
          o.phase='MSS 已发生 · 等待价格区域';o.evidence.push(`MSS 参考锚：${new Date(t[target.index]).toISOString()} · ${target.price}`);
          o.waitingFor=[model==='ob'?'等待符合基底规则的 OB 区域。':'等待后续闭柱形成 FVG 价差区域。'];
        }
        if(shifted>=0){
          const gap=j>=i+2?findFvg(cols,j,bull,atr,segmentStart,params):undefined;
          const ready=model==='ob'?!!block:model==='both'?!!block&&!!gap:model==='either'?!!block||!!gap:!!gap;
          if(ready){
            const useBlock=model==='ob'||(!gap&&!!block);const z=useBlock?block!:gap!;
            o.zone={low:z.low,high:z.high,fromTime:useBlock?t[block!.from]:t[j-2],toTime:t[j]};
            if(block&&(model==='ob'||model==='both'||model==='either'))emit(o,'order-block','OB 区域可知',shifted,bull?block.low:block.high,'MSS 推进前反向基底已按区域口径确认。',cols);
            if(gap&&model!=='ob')emit(o,'fvg','FVG 区域可知',j,bull?gap.low:gap.high,'三柱价差成立于第三柱收盘；未把它当作订单薄数据。',cols);
            o.state='confirmed';o.availableAt=availableTime(cols,j);o.phase='事件链已完成 · 等待回访';confirmed=j;
            o.waitingFor=['观察已成立区域的实际回访、深度与失效。'];break;
          }
        }
      }
      if(!target)o.counterEvidence.push('扫过之前没有足够已确认的反向波段点，未构造 MSS。');
      if(confirmed>=0)lifecycle(o,cols,confirmed,bull,segmentStart,params);
      else if(o.state!=='invalidated'&&n-1>=i+wait){o.trackingEndedAt=availableTime(cols,i+wait);o.trackingEndReason='expired';o.waitingFor=[];}
      if(o.state==='invalidated')o.waitingFor=[];
      out.push(o);
    }
  }
  return out.reverse().slice(0,Math.round(np(params,'maxObservations',60,5,300)));
}
