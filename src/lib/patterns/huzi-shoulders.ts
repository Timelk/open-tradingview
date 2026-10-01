import type {Pivot} from './pivots';
import {envelope,headShoulders,type Setup} from './huzi';
import type {PriceColumns} from './huzi-fit';

/**
 * Head and shoulders whose shoulders are structures of their own.
 *
 * `headShoulders()` needs the last five alternating pivots to be exactly [L,N1,H,N2,R]. A shoulder that is a
 * double peak, or a small wedge / channel / triangle, has interior swings deeper than the amplitude level may
 * remove, so that template never sees it. Two readings are added here, both called with the zig-zag stack at
 * every confirmed pivot and both causal (only pivots already in the stack, only bars up to the newest one):
 *
 * - complex shoulders: a window of 7 / 9 / 11 pivots whose extreme is the head. Each side is reduced to one
 *   shoulder (L = the highest high left of H, R = the highest high right of H, N1 / N2 = the deepest trough on
 *   either side) and those five anchors go through the ordinary head-and-shoulders rules. The newest pivot must
 *   be R itself, and interior pullbacks must not have broken the neckline.
 * - composite: the pivots after the head form a triangle / wedge / channel of their own. The head is confirmed
 *   only when that sub-structure is broken, and its close decides the direction: the same right shoulder is a
 *   failed top when it breaks up and a completed one when it breaks down.
 */

const HEAD_NAMES:Record<string,string>={'头肩顶':'Head and shoulders top','头肩底':'Inverse head and shoulders'};
const SUB_NAMES:Record<string,string>={
  '水平通道':'Horizontal channel','上升通道':'Ascending channel','下降通道':'Descending channel',
  '上升三角形':'Ascending triangle','下降三角形':'Descending triangle','对称三角形':'Symmetrical triangle',
  '上升楔形':'Rising wedge','下降楔形':'Falling wedge',
};
/** English text for this module's names, ratios and sentences (aggregated in i18n/messages-huzi-extra.ts). */
export const shouldersMessages:Record<string,string>={
  '肩部内部拐点数':'Interior shoulder pivots',
  '子结构高度 / 头部高度':'Sub-structure height / Head height',
  '复杂肩部：左肩区 {0} 个、右肩区 {1} 个内部拐点，两肩锚点取各自一侧的最高（低）点，内部回撤均未跌破颈线。':
    'Complex shoulders: {0} interior pivots on the left shoulder and {1} on the right. Each shoulder anchor is the highest (lowest) point on its side, and no interior pullback broke the neckline. ',
  '右肩区形成{0}，突破方向由该子结构的收盘突破决定，不预设头肩形态必然反转。':
    'The right shoulder forms {0}. The breakout direction is set by that sub-structure\'s closing breakout, not assumed to be a reversal. ',
  ...Object.fromEntries(Object.entries(HEAD_NAMES).flatMap(([head,headEn])=>
    Object.entries(SUB_NAMES).map(([sub,subEn])=>[`${head} + ${sub}`,`${headEn} + ${subEn}`]))),
};

/** Interior pullbacks may not go further beyond the neckline than this share of the head's height. */
const NECKLINE_SLACK=1;
/** Most pivots one complex head-and-shoulders may span (L … R): the windows of 7, 9 and 11 pivots. */
const COMPLEX_MAX_PIVOTS=11;
/** Sub-structure sizes in pivots: the smallest envelope and the largest one tried. */
const COMPOSITE_SIZES=[5,9];
/** The sub-structure has to be a fraction of the whole formation, or it is the formation. */
const MAX_SUB_HEIGHT=.9;
/** How many pivots back the left shoulder is searched from the head. */
const LEFT_REACH=8;

export function shoulderSetups(stack:Pivot[],radius:number,tolerance:number,price:PriceColumns):Setup[] {
  if(stack.length<7)return [];
  const out:Setup[]=[];
  complexShoulders(stack,radius,tolerance,price,out);
  compositeStructures(stack,radius,tolerance,price,out);
  return out;
}

/** True when any bar in [from,to] reaches beyond the head (a higher high for a top, a lower low for a bottom). */
function beyondHead(price:PriceColumns,head:Pivot,from:number,to:number):boolean {
  const series=head.kind==='high'?price.high:price.low;
  for(let i=Math.max(0,from);i<=to&&i<series.length;i++)if(head.kind==='high'?series[i]>head.value:series[i]<head.value)return true;
  return false;
}
/** The index in `pivots` of the most extreme pivot of `kind` in [from,to) (a later one wins a tie), or -1. */
function extreme(pivots:readonly Pivot[],kind:Pivot['kind'],sign:1|-1,from:number,to:number):number {
  let best=-1;
  for(let i=Math.max(0,from);i<to;i++)if(pivots[i].kind===kind&&(best<0||sign*(pivots[i].value-pivots[best].value)>=0))best=i;
  return best;
}
const other=(kind:Pivot['kind'])=>kind==='high'?'low':'high';
const neckAt=(setup:Setup,index:number)=>setup.neckline!.slope*index+setup.neckline!.intercept;

/** Labels: the five anchors keep their classic names, every other pivot is numbered. */
function label(pivots:readonly Pivot[],anchors:Record<string,Pivot|undefined>):string[] {
  let extra=0;
  return pivots.map(pivot=>Object.entries(anchors).find(([,anchor])=>anchor===pivot)?.[0]??`s${++extra}`);
}

/** The five anchors of a head with `h` as its head over the pivots [l..end]: null when a shoulder or trough is missing. */
function anchorsOf(stack:readonly Pivot[],kind:Pivot['kind'],sign:1|-1,h:number,reach:number,end:number):{l:number;n1:number;n2:number}|null {
  const l=extreme(stack,kind,sign,reach,h);
  if(l<0||!(sign*(stack[h].value-stack[l].value)>0))return null;
  const n1=extreme(stack,other(kind),-sign as 1|-1,l+1,h),n2=extreme(stack,other(kind),-sign as 1|-1,h+1,end);
  return n1<0||n2<0?null:{l,n1,n2};
}

/** Complex shoulders. The newest pivot is the right shoulder R; the head is the nearest earlier pivot on the same
 * side that lies beyond it, so R is the strictly highest (lowest) point right of the head. */
function complexShoulders(stack:Pivot[],radius:number,tolerance:number,price:PriceColumns,out:Setup[]):void {
  const length=stack.length,R=stack.at(-1)!,kind=R.kind,sign:1|-1=kind==='high'?1:-1;
  let h=-1;
  // Pivots alternate, so same-side pivots sit two apart; a head further back cannot keep L … R within 11 pivots.
  for(let i=length-3;i>=0&&i>=length-COMPLEX_MAX_PIVOTS+2;i-=2){
    const gap=sign*(stack[i].value-R.value);
    if(gap>0){h=i;break;}
    if(gap===0)return;
  }
  if(h<2)return;
  const found=anchorsOf(stack,kind,sign,h,length-COMPLEX_MAX_PIVOTS,length-1);
  if(!found)return;
  const {l,n1,n2}=found,trimmed=stack.slice(l);
  // Exactly the five anchors in a row is the ordinary template; only interior pivots make a complex shoulder.
  if(trimmed.length<=5)return;
  const H=stack[h],base=headShoulders([stack[l],stack[n1],H,stack[n2],R],radius,tolerance);
  if(!base||!base.neckline)return;
  // A pullback inside a shoulder that already went through the neckline is a break, not a shoulder.
  const slack=base.tolerance*NECKLINE_SLACK;
  if(trimmed.some(p=>p.kind===other(kind)&&p!==stack[n1]&&p!==stack[n2]&&sign*(neckAt(base,p.index)-p.value)>slack))return;
  if(beyondHead(price,H,stack[l].index,R.index))return;
  const headAt=h-l,left=headAt-2,right=trimmed.length-headAt-3;
  const setup:Setup={...base,pivots:trimmed,headAt,stop:R.value,
    labels:label(trimmed,{L:stack[l],N1:stack[n1],H,N2:stack[n2],R}),
    ratios:[...base.ratios,{label:'肩部内部拐点数',value:trimmed.length-5,expected:'≥ 1'}],
    notes:[`复杂肩部：左肩区 ${left} 个、右肩区 ${right} 个内部拐点，两肩锚点取各自一侧的最高（低）点，内部回撤均未跌破颈线。`]};
  out.push(setup,{...setup,continuation:true,direction:base.direction==='bullish'?'bearish':'bullish',
    name:base.direction==='bullish'?'头肩中继下破':'头肩中继上破'});
}

/** Composite: the pivots after a head form a triangle / wedge / channel. Every earlier pivot on the same side
 * that stands out over everything after it is tried as the head. */
function compositeStructures(stack:Pivot[],radius:number,tolerance:number,price:PriceColumns,out:Setup[]):void {
  const length=stack.length,reach=COMPOSITE_SIZES[1]+2;
  for(const kind of ['high','low'] as const){
    const sign:1|-1=kind==='high'?1:-1;
    // `best` is the most extreme same-side pivot right of the current candidate: that candidate's right shoulder.
    let best=-1;
    for(let h=stack[length-1].kind===kind?length-1:length-2;h>=0&&length-1-h<=reach;h-=2){
      if(best>=0&&!(sign*(stack[h].value-stack[best].value)>0))continue;
      const shoulder=best,count=length-1-h;
      best=h;
      if(shoulder<0||count<COMPOSITE_SIZES[0])continue;
      const found=anchorsOf(stack,kind,sign,h,h-LEFT_REACH,length);
      if(!found)continue;
      const {l,n1,n2}=found,H=stack[h];
      const base=headShoulders([stack[l],stack[n1],H,stack[n2],stack[shoulder]],radius,tolerance);
      if(!base||!base.neckline)continue;
      const pivots=stack.slice(l),slack=base.tolerance*NECKLINE_SLACK;
      if(pivots.some(p=>p.kind===other(kind)&&sign*(neckAt(base,p.index)-p.value)>slack))continue;
      if(beyondHead(price,H,stack[l].index,stack[length-1].index))continue;
      // The sub-structure is a right shoulder: it starts after the head, at most two pivots on.
      // The sub-structure IS the right shoulder, so the shoulder's peak belongs to it: a consolidation far below
      // the shoulder, near the neckline, is a different formation.
      for(let size=Math.max(COMPOSITE_SIZES[0],count-2,length-shoulder);size<=Math.min(COMPOSITE_SIZES[1],count);size++){
        const sub=stack.slice(-size),inner=envelope(sub,radius,tolerance);
        if(!inner||inner.family==='huzi-flag'||!(inner.height<base.height*MAX_SUB_HEIGHT))continue;
        out.push({...inner,pivots,family:'huzi-head-shoulders',name:`${base.name} + ${inner.name}`,radius,formation:'complete',
          headAt:h-l,envelopeFrom:sub[0].index,
          labels:label(pivots,{L:stack[l],N1:stack[n1],H,N2:stack[n2],R:stack[shoulder]}),
          ratios:[...base.ratios,...inner.ratios,{label:'子结构高度 / 头部高度',value:inner.height/base.height,expected:`< ${MAX_SUB_HEIGHT.toFixed(3)}`}],
          notes:[`右肩区形成${inner.name}，突破方向由该子结构的收盘突破决定，不预设头肩形态必然反转。`]});
      }
    }
  }
}
