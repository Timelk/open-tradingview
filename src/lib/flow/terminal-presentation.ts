import type {ChartOrderFlowState} from './chart-order-flow';
import type {AggregatedBook,AggregatedBookLevel} from './orderbook-models';
import type {TradeFlowSessionSnapshot} from './types';

export type TerminalPhase='initial'|'loading'|'live'|'stale'|'error'|'unsupported'|'paused'|'history';
export function terminalStatus(state:ChartOrderFlowState):{phase:TerminalPhase;label:string;detail:string;showBook:boolean}{
  if(state.mode==='history'){
    if(state.archive?.pending)return {phase:'loading',label:'正在读取历史盘口',detail:'',showBook:false};
    return {phase:'history',label:'历史盘口',detail:state.error||state.archive?.frame?.book.warning||'',showBook:state.archive?.frame?.book.status==='available'&&state.book?.status==='live'};
  }
  if(!state.market)return {phase:'initial',label:'等待品种',detail:'',showBook:false};
  if(!state.running)return {phase:'paused',label:'盘口已暂停',detail:'',showBook:false};
  if(state.market.chartHistorical)return {phase:'paused',label:'图表处于历史快照',detail:'请选择深度档案或返回实时图表',showBook:false};
  if(state.book?.supported===false||state.market.source!=='binance'||state.market.marketType!=='usdm-perpetual')
    return {phase:'unsupported',label:'此市场暂不支持盘口',detail:'当前支持 Binance USDT 永续公开深度',showBook:false};
  if(state.error||state.book?.status==='error')return {phase:'error',label:'盘口连接失败',detail:state.error||state.book?.warning||'',showBook:false};
  if(state.book?.status==='stale')return {phase:'stale',label:'行情已过期，正在恢复',detail:state.book.warning??'',showBook:false};
  if(state.book?.status==='paused')return {phase:'paused',label:'盘口已暂停',detail:'',showBook:false};
  if(state.book?.status==='live')return {phase:'live',label:'实时盘口',detail:'',showBook:true};
  return {phase:state.market.tickSize>0?'loading':'initial',label:state.book?.status==='resyncing'?'盘口重同步中':'等待盘口快照',detail:state.book?.warning??'',showBook:false};
}

export interface TerminalLadderRow {price:number;bid:AggregatedBookLevel|null;ask:AggregatedBookLevel|null;buy:number|null;sell:number|null;atMid:boolean}
export interface TerminalLadder {rows:TerminalLadderRow[];tradeBasis:'observed'|'partial'|'coarse'|'unavailable';tradeFrom?:number;tradeThrough?:number}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const priceKey=(price:number,step:number)=>Math.round(price/step);
const priceAt=(index:number,step:number)=>Number((index*step).toPrecision(15));

/** A stable price grid, independent of how many nonempty levels are present.
 * Missing tape samples stay null; no row is assigned invented zero execution.
 * Buy prints map upward, sells downward; quote fields preserve source notional. */
export function buildTerminalLadder(book:AggregatedBook,trades?:TradeFlowSessionSnapshot,center=book.mid??0,count=31):TerminalLadder {
  if(!finite(center)||center<=0||!finite(book.priceStep)||book.priceStep<=0)return {rows:[],tradeBasis:'unavailable'};
  const step=book.priceStep,size=Math.max(5,Math.min(101,Math.round(count))),middle=priceKey(center,step),half=Math.floor(size/2),
    bids=new Map(book.bids.map(level=>[priceKey(level.price,step),level])),asks=new Map(book.asks.map(level=>[priceKey(level.price,step),level])),
    buys=new Map<number,number>(),sells=new Map<number,number>();
  let tradeBasis:TerminalLadder['tradeBasis']='unavailable',tradeFrom:number|undefined,tradeThrough:number|undefined;
  if(trades&&['live','partial'].includes(trades.status)&&trades.coverage.retainedTrades>0){
    const sourceStep=trades.effectivePriceStep,tick=trades.aggregation.tickSize,ratio=step/sourceStep;
    // Coarsened source bins can straddle an upward buy bucket. Without raw
    // trades there is no honest way to split that buy amount among DOM rows.
    if(!finite(sourceStep)||sourceStep<=0||!finite(tick)||tick<=0||sourceStep>tick*(1+1e-10)
      ||sourceStep>step*(1+1e-10)||Math.abs(ratio-Math.round(ratio))>1e-8||trades.aggregation.timeframeMs!==1000)tradeBasis='coarse';
    else{
      const now=book.changeWindow.throughTime,from=Math.floor(now/1000)*1000-29_000,
        blocks=trades.footprint.filter(block=>block.time>=from&&block.time<=now);
      tradeBasis=blocks.length?trades.coverage.continuous&&blocks.length===30&&!blocks.some(b=>b.partial)?'observed':'partial':'unavailable';
      tradeFrom=blocks[0]?.time;tradeThrough=blocks.length?Math.min(now,blocks.at(-1)!.endTime-1):undefined;
      for(const level of blocks.flatMap(block=>block.levels)){
        if(!finite(level.price)||level.price<=0)continue;
        const buy=book.unit==='quote'?level.buyQuote:level.buyBase,sell=book.unit==='quote'?level.sellQuote:level.sellBase,
          ratio=level.price/step,epsilon=Number.EPSILON*Math.max(1,Math.abs(ratio))*8;
        if(finite(buy)&&buy>0){const index=Math.ceil(ratio-epsilon);buys.set(index,(buys.get(index)??0)+buy);}
        if(finite(sell)&&sell>0){const index=Math.floor(ratio+epsilon);sells.set(index,(sells.get(index)??0)+sell);}
      }
    }
  }
  return {rows:Array.from({length:size},(_,i)=>{
    const index=middle+half-i;return {price:priceAt(index,step),bid:bids.get(index)??null,ask:asks.get(index)??null,
      buy:buys.get(index)??null,sell:sells.get(index)??null,atMid:book.mid!==null&&index===priceKey(book.mid,step)};
  }).filter(row=>row.price>0),tradeBasis,tradeFrom,tradeThrough};
}

export function terminalDeltaRows(book:AggregatedBook,side:'bids'|'asks',limit=30){
  // A price removed to zero is still an actual subtraction and must survive.
  return book.deltas[side].filter(row=>row.added>0||row.subtracted>0).slice(0,limit);
}
export function terminalPriceDigits(tickSize:number):number {
  if(!finite(tickSize)||tickSize<=0)return 2;
  return Math.min(10,(tickSize.toFixed(10).replace(/0+$/,'').split('.')[1]??'').length);
}
const amounts=new Map<string,Intl.NumberFormat>();
export function formatTerminalAmount(value:number|null|undefined,locale:string):string {
  if(!finite(value))return '—';
  const digits=Math.abs(value)>0&&Math.abs(value)<.001?8:Math.abs(value)<1?4:2,
    compact=Math.abs(value)>=10000,key=`${locale}:${digits}:${compact}`;
  let fmt=amounts.get(key);if(!fmt){fmt=new Intl.NumberFormat(locale,{maximumFractionDigits:digits,...(compact?{notation:'compact' as const}:{} )});amounts.set(key,fmt);}
  return fmt.format(value);
}
