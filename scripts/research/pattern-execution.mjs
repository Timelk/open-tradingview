/**
 * Deterministic OHLC execution for research. entryIndex is the EXECUTION bar:
 * the caller must discover the signal on the preceding closed prefix.
 *
 * Returns are per one unit of initial raw-open notional, without leverage.
 * Quantity = 1 / raw entry open. Fees use actual adverse-slippage fill notionals.
 * Partial targets keep the original stop for their entire bar; break-even at
 * the entry fill becomes effective on the NEXT bar and excludes exit costs.
 * Funding exactly at entry is treated as before the new order. At a possible
 * intrabar exit, debit adverse funding but do not invent a favorable credit.
 * Funding coverage cannot be inferred from an array of events alone.
 */

const finite = value => typeof value === 'number' && Number.isFinite(value);
const bar = row => Array.isArray(row)
  ? {time:+row[0],open:+row[1],high:+row[2],low:+row[3],close:+row[4],volume:+row[5]}
  : row;
const validBar = b => b && [b.time,b.open,b.high,b.low,b.close].every(finite)
  && b.open>0 && b.low>0 && b.close>0 && b.high>=Math.max(b.open,b.close)
  && b.low<=Math.min(b.open,b.close) && b.high>=b.low;

function exclusion(signal, reason, detail) {
  return {status:'excluded',valid:false,excluded:true,id:signal?.id,entryIndex:signal?.entryIndex,
    direction:signal?.direction,reason,detail,net:null,netReturn:null,equityPath:[]};
}

/** @param {Array<any>} rows @param {any} signal @param {any} opts */
export function simulateTrade(rows, signal, opts = {}) {
  const entryIndex=signal?.entryIndex,side=signal?.direction==='bullish'?1:signal?.direction==='bearish'?-1:0;
  if(!Array.isArray(rows)||!Number.isInteger(entryIndex)||entryIndex<0||entryIndex>=rows.length)
    return exclusion(signal,'missing-entry-bar','entryIndex must identify an available next-open execution bar');
  if(!side)return exclusion(signal,'invalid-direction','Expected bullish or bearish');
  const entryBar=bar(rows[entryIndex]);
  if(!validBar(entryBar))return exclusion(signal,'invalid-entry-bar','Entry OHLC is not finite and valid');
  const feeBps=opts.feeBps??5,slippageBps=opts.slippageBps??1,maxHoldBars=opts.maxHoldBars??48,
    exitMode=opts.exitMode??'t1',endIndex=opts.endIndex??rows.length-1;
  if(!finite(feeBps)||feeBps<0||feeBps>=10000||!finite(slippageBps)||slippageBps<0||slippageBps>=10000
    ||!Number.isInteger(maxHoldBars)||maxHoldBars<1||!['t1','split'].includes(exitMode)
    ||!Number.isInteger(endIndex))throw new TypeError('Invalid execution options');
  if(endIndex<entryIndex)return exclusion(signal,'end-before-entry','The declared evaluation boundary precedes execution');
  const previous=entryIndex>0?bar(rows[entryIndex-1]):null,next=rows[entryIndex+1]?bar(rows[entryIndex+1]):null;
  const intervalMs=opts.intervalMs??(previous?entryBar.time-previous.time:next?next.time-entryBar.time:null);
  if(!finite(intervalMs)||intervalMs<=0)return exclusion(signal,'unknown-bar-duration','Provide intervalMs when no adjacent timestamp is available');
  if(previous && entryBar.time-previous.time!==intervalMs)
    return exclusion(signal,'entry-data-gap','Do not execute across a missing confirmation/entry boundary');
  const stop=+signal.stop,t1=+signal.t1,t2=+signal.t2,raw=entryBar.open,
    slip=slippageBps/10000,fee=feeBps/10000,fill=raw*(1+side*slip),quantity=1/raw;
  if(!finite(stop)||stop<=0||side*(fill-stop)<=0)
    return exclusion(signal,'invalid-initial-risk','Stop must remain beyond the actual next-open entry fill');
  if(!finite(t1)||t1<=0||side*(t1-fill)<=0)
    return exclusion(signal,'target-already-crossed','T1 must remain beyond the actual next-open entry fill');
  if(exitMode==='split'&&(!finite(t2)||t2<=0||side*(t2-t1)<=0))
    return exclusion(signal,'invalid-second-target','Split execution requires T2 beyond T1');
  const funding=(opts.funding??[]).map(event=>({time:+event.fundingTime,rate:+event.fundingRate,markPrice:+event.markPrice}));
  if(funding.some(event=>![event.time,event.rate,event.markPrice].every(finite)||event.markPrice<=0)
    ||new Set(funding.map(event=>event.time)).size!==funding.length)
    throw new TypeError('Funding events must be finite, uniquely timestamped and include positive markPrice');
  const horizon=entryIndex+maxHoldBars-1,limit=Math.min(horizon,endIndex,rows.length-1),parts=[];
  let remaining=1,partialAt=-1,ambiguous=false,reason='',dataQualityWarning;
  const favorable=(price,target)=>side*(price-target)>=0;
  const adverse=(price,level)=>side*(price-level)<=0;
  const finish=(index,price,fraction,why,execution)=>{
    const b=bar(rows[index]),portion=Math.min(remaining,fraction),exitFill=price*(1-side*slip);
    parts.push({index,barTime:b.time,time:execution==='open'?b.time:b.time+intervalMs-1,
      rawPrice:price,price:exitFill,fraction:portion,quantity:quantity*portion,reason:why,execution});
    remaining=Math.max(0,remaining-portion);reason=why;
  };
  for(let index=entryIndex;index<=limit&&remaining>0;index++){
    const b=bar(rows[index]),prior=index>entryIndex?bar(rows[index-1]):null;
    if(!validBar(b)||(prior&&b.time!==prior.time+intervalMs)){
      dataQualityWarning=!validBar(b)?'invalid-future-bar':'future-data-gap';
      // Explicit truncation at last observed close; never silently discard a loss.
      finish(index-1,prior.close,remaining,dataQualityWarning,'close');break;
    }
    const activeStop=partialAt>=0&&index>partialAt?fill:stop;
    if(adverse(b.open,activeStop)){
      finish(index,b.open,remaining,partialAt>=0&&index>partialAt?'gap-break-even':'gap-stop','open');break;
    }
    if(partialAt<0&&favorable(b.open,t1)){
      finish(index,t1,exitMode==='split'?.5:remaining,'gap-t1','open');
      if(exitMode==='split')partialAt=index;
    }
    if(remaining===0)break;
    if(partialAt>=0&&favorable(b.open,t2)){
      finish(index,t2,remaining,'gap-t2','open');break;
    }
    const adverseExtreme=side===1?b.low:b.high,favorableExtreme=side===1?b.high:b.low,
      hitStop=adverse(adverseExtreme,activeStop),nextTarget=partialAt>=0?t2:t1,
      hitTarget=favorable(favorableExtreme,nextTarget);
    if(hitStop){
      ambiguous ||= hitTarget;
      const breakeven=partialAt>=0&&index>partialAt;
      finish(index,activeStop,remaining,hitTarget?'both-hit-stop-first':breakeven?'break-even':'stop','intrabar');break;
    }
    if(partialAt<0&&favorable(favorableExtreme,t1)){
      finish(index,t1,exitMode==='split'?.5:remaining,'t1','intrabar');
      if(exitMode==='split')partialAt=index;
    }
    if(remaining>0&&partialAt>=0&&favorable(favorableExtreme,t2))
      finish(index,t2,remaining,'t2','intrabar');
    if(remaining>0&&index===limit){
      const endReason=limit===horizon?'max-hold':opts.endIndex!==undefined&&endIndex<=rows.length-1?'end-index':'data-end';
      finish(index,b.close,remaining,endReason,'close');
    }
  }
  const final=parts.at(-1);
  if(!final)return exclusion(signal,'no-exit-data','No available bar for a conservative close');
  const entryFee=quantity*fill*fee,entrySlippage=side*(fill-raw)*quantity,fundingLedger=[];
  let fundingCost=0,fundingAmbiguousCount=0;
  for(const event of funding){
    if(event.time<=entryBar.time||event.time>final.time)continue;
    let cost=0,eventAmbiguous=false;
    for(const part of parts){
      if(event.time>part.time)continue;
      const value=side*part.quantity*event.markPrice*event.rate,
        uncertain=part.execution==='intrabar'&&event.time>=part.barTime;
      cost+=uncertain?Math.max(0,value):value;eventAmbiguous ||= uncertain;
    }
    fundingCost+=cost;if(eventAmbiguous)fundingAmbiguousCount++;
    fundingLedger.push({...event,cost,ambiguous:eventAmbiguous});
  }
  const fees=entryFee+parts.reduce((sum,p)=>sum+p.quantity*p.price*fee,0),
    slippageCost=entrySlippage+parts.reduce((sum,p)=>sum+side*(p.rawPrice-p.price)*p.quantity,0),
    gross=parts.reduce((sum,p)=>sum+side*(p.rawPrice-raw)*p.quantity,0),net=gross-slippageCost-fees-fundingCost,
    riskFraction=side*(fill-stop)*quantity,equityPath=[];
  for(let index=entryIndex;index<=final.index;index++){
    const b=bar(rows[index]),exited=parts.filter(p=>p.index<=index),left=1-exited.reduce((sum,p)=>sum+p.fraction,0),
      time=index===final.index?final.time:b.time+intervalMs-1,
      realizedGross=exited.reduce((sum,p)=>sum+side*(p.rawPrice-raw)*p.quantity,0),
      unrealizedGross=side*(b.close-raw)*quantity*left,
      paidFees=entryFee+exited.reduce((sum,p)=>sum+p.quantity*p.price*fee,0),
      paidSlippage=entrySlippage+exited.reduce((sum,p)=>sum+side*(p.rawPrice-p.price)*p.quantity,0),
      paidFunding=fundingLedger.filter(event=>event.time<=time).reduce((sum,event)=>sum+event.cost,0),
      netReturn=realizedGross+unrealizedGross-paidFees-paidSlippage-paidFunding;
    equityPath.push({index,time,netReturn,equity:1+netReturn,realizedGross,unrealizedGross,
      fees:paidFees,slippageCost:paidSlippage,fundingCost:paidFunding,remainingFraction:left});
  }
  const truncated=['data-end','end-index','invalid-future-bar','future-data-gap'].includes(reason);
  return {status:'closed',valid:true,excluded:false,id:signal.id,direction:signal.direction,entryIndex,exitIndex:final.index,
    entryTime:entryBar.time,exitTime:final.time,entryRawPrice:raw,entryPrice:fill,
    exitPrice:parts.reduce((sum,p)=>sum+p.fraction*p.price,0),initialNotional:1,quantity,
    gross,grossReturn:gross,net,netReturn:net,fees,slippageCost,fundingCost,riskFraction,rMultiple:net/riskFraction,
    reason,ambiguous,holdingBars:final.index-entryIndex+1,partialTaken:partialAt>=0,exitParts:parts,equityPath,
    forcedExit:truncated||reason==='max-hold',truncated,dataQualityWarning,fundingAmbiguousCount,fundingLedger,
    fundingBasis:opts.funding===undefined?'not-provided':'events-provided-coverage-undeclared',
    assumptions:{notionalBasis:'raw-entry-open',stopTargetOrder:'stop-first',breakEvenActivation:'next-bar',
      breakEvenBasis:'entry-fill-before-exit-costs',fundingOnIntrabarExit:'adverse-only',entryAtFunding:'after-funding'}};
}
