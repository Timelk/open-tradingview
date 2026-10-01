/** Fixed protocol: chronological 60/20/20; no threshold chosen on test returns. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,OUT,readDataset,baseMethods,candidates} from './pattern-features.mjs';
import {tradingSignal} from './pattern-features.mjs';
import {simulateTrade} from './pattern-execution.mjs';
const frames=process.argv.slice(2).length?process.argv.slice(2):['1m','5m','4h'];
const compact=t=>{const {equityPath,fundingLedger,assumptions,...rest}=t;return rest;};
export function replay(data,method,start,end,opts={}){
  const {rows,signals,manifest}=data,maxHoldBars=48,equity=new Float64Array(end-start+1).fill(1);
  const trades=[],excluded={},byIndex=new Map();let ignoredBusy=0,conflicts=0,late=0;
  for(const s of signals){if(s.entryIndex<start||s.entryIndex>end-maxHoldBars+1)continue;if(s.delayBars){late++;continue;}const signal=tradingSignal(s,method);if(!signal)continue;const list=byIndex.get(s.entryIndex)??[];list.push(signal);byIndex.set(s.entryIndex,list);}
  let capital=1,nextFree=start,cursor=start,gross=0,fees=0,slippage=0,funding=0;
  for(const [i,group] of [...byIndex].sort((a,b)=>a[0]-b[0])){
    if(i<nextFree){ignoredBusy+=group.length;continue;}
    if(new Set(group.map(s=>s.direction)).size>1){conflicts+=group.length;continue;}
    let trade;
    for(const signal of group.sort((a,b)=>a.id.localeCompare(b.id))){
      const t=simulateTrade(rows,signal,{feeBps:5,slippageBps:1,maxHoldBars,exitMode:'t1',funding:data.funding,intervalMs:manifest.interval,endIndex:end,...opts});
      if(t.excluded){excluded[t.reason]=(excluded[t.reason]??0)+1;continue;}
      trade={...t,signalFamily:signal.family,signalKind:signal.kind,branch:signal.branch};break;
    }
    if(!trade)continue;
    while(cursor<i){equity[cursor-start]=capital;cursor++;}
    const before=capital;
    for(const p of trade.equityPath)equity[p.index-start]=before*(1+p.netReturn);
    capital=before*(1+trade.netReturn);cursor=trade.exitIndex+1;nextFree=cursor;
    gross+=before*trade.gross;fees+=before*trade.fees;slippage+=before*trade.slippageCost;funding+=before*trade.fundingCost;
    trades.push({...compact(trade),capitalBefore:before,pnl:before*trade.netReturn});
    if(capital<=0)break;
  }
  while(cursor<=end){equity[cursor-start]=capital;cursor++;}
  let peak=1,dd=0;for(const value of equity){peak=Math.max(peak,value);dd=Math.max(dd,1-value/peak);}
  const wins=trades.filter(t=>t.netReturn>0),losses=trades.filter(t=>t.netReturn<0),profit=wins.reduce((s,t)=>s+t.pnl,0),loss=-losses.reduce((s,t)=>s+t.pnl,0);
  return {symbol:data.symbol,frame:data.frame,start,end,from:rows[start][0],to:rows[end][0]+manifest.interval-1,method:method.id,equity:Array.from(equity),trades,
    metrics:{trades:trades.length,return:capital-1,gross,fees,slippage,funding,drawdown:dd,winRate:trades.length?wins.length/trades.length:null,profitFactor:loss>0?profit/loss:null,meanR:trades.length?trades.reduce((s,t)=>s+t.rMultiple,0)/trades.length:null,meanNetBps:trades.length?10000*trades.reduce((s,t)=>s+t.netReturn,0)/trades.length:null,ambiguous:trades.filter(t=>t.ambiguous).length,holdBars:trades.reduce((s,t)=>s+t.holdingBars,0),ignoredBusy,conflicts,excluded,late}};
}
function combine(runs,datasets){
  if(!runs.length||runs.length!==datasets.length)throw new Error('Portfolio runs and datasets do not match');
  for(let k=0;k<runs.length;k++){
    const run=runs[k],base=runs[0];
    if(run.equity.length!==base.equity.length)throw new Error('Portfolio equity lengths differ');
    for(let j=0;j<run.equity.length;j++)if(datasets[k].rows[run.start+j][0]!==datasets[0].rows[base.start+j][0])
      throw new Error('Portfolio time axes differ; row-index averaging would misalign returns');
  }
  const eq=runs[0].equity.map((_,i)=>runs.reduce((s,r)=>s+r.equity[i],0)/runs.length),trades=runs.flatMap(r=>r.trades.map(t=>({...t,symbol:r.symbol,pnl:t.pnl/runs.length}))),m=runs.map(r=>r.metrics);
  let peak=1,dd=0;for(const v of eq){peak=Math.max(peak,v);dd=Math.max(dd,1-v/peak);}
  const profit=trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0),loss=-trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0),daily=new Map();
  for(let j=0;j<eq.length;j++){const time=datasets[0].rows[runs[0].start+j][0];daily.set(new Date(time).toISOString().slice(0,10),eq[j]);}
  let previous=1;const dailyReturns=[...daily].map(([day,value])=>{const r={day,return:value/previous-1};previous=value;return r;});
  const mean=dailyReturns.reduce((s,x)=>s+x.return,0)/dailyReturns.length;
  let seed=20260927;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32;};
  const means=[];for(let b=0;b<3000;b++){let sum=0,k=0;while(k<dailyReturns.length){const at=Math.floor(random()*dailyReturns.length);for(let z=0;z<3&&k<dailyReturns.length;z++,k++)sum+=dailyReturns[(at+z)%dailyReturns.length].return;}means.push(sum/dailyReturns.length);}means.sort((a,b)=>a-b);
  return {trades:trades.length,return:eq.at(-1)-1,gross:m.reduce((s,x)=>s+x.gross,0)/m.length,fees:m.reduce((s,x)=>s+x.fees,0)/m.length,slippage:m.reduce((s,x)=>s+x.slippage,0)/m.length,funding:m.reduce((s,x)=>s+x.funding,0)/m.length,drawdown:dd,winRate:trades.length?trades.filter(t=>t.netReturn>0).length/trades.length:null,profitFactor:loss>0?profit/loss:null,meanNetBps:trades.length?10000*trades.reduce((s,t)=>s+t.netReturn,0)/trades.length:null,meanR:trades.length?trades.reduce((s,t)=>s+t.rMultiple,0)/trades.length:null,ambiguous:m.reduce((s,x)=>s+x.ambiguous,0),dailyMean:mean,dailyMeanCI95:[means[75],means[2925]],dailyReturns,bySymbol:Object.fromEntries(runs.map(r=>[r.symbol,r.metrics]))};
}
const result={protocol:{version:'2026-09-27-v1',capital:'1x raw notional; each market independently compounds all equity; equal initial capital BTC/ETH',entry:'first visible confirmation, next bar open; stale backfilled signals excluded',exit:'T1 full exit, original geometric stop, 48 bars max; same-bar stop-first',feesBpsPerSide:5,slippageBpsPerSide:1,split:[.6,.2,.2],purgeBars:47,selection:'18 fixed candidates; training only, at least 30 pooled trades and >=10 per symbol, both symbol returns positive; maximize worst symbol train return then equal-capital return; otherwise cash',bootstrap:'3000 circular moving blocks of 3 calendar days, BTC/ETH jointly clustered; reused historical data, not untouched holdout',unknowns:['exact exchange tick/lot constraints','order book depth','latency/slippage variance','past Gemini trials and original training exposure']},frames:{}};
const ledger=[];
for(const frame of frames){
  const datasets=['BTCUSDT','ETHUSDT'].map(s=>readDataset(s,frame));
  const begin=datasets[0].manifest.start,n=datasets[0].rows.length,span=n-begin,t60=begin+Math.floor(span*.6),t80=begin+Math.floor(span*.8),splits={all:[begin,n-1],train:[begin,t60-1],validation:[t60,t80-1],test:[t80,n-1]};
  const frameResult={datasets:datasets.map(d=>({...d.manifest,fundingSource:d.fundingSource,diagnostics:d.diagnostics})),fundingBasis:datasets.every(d=>d.fundingSource.covered)?'covered-public-history':'missing-or-partial-history',splits,results:{},costSensitivity:{},management:{}};
  const evaluate=(method,range,opts={})=>{const runs=datasets.map(d=>replay(d,method,...range,opts));return {runs,combined:combine(runs,datasets)};};
  for(const [section,range] of Object.entries(splits)){
    frameResult.results[section]={};
    for(const method of baseMethods){const {runs,combined}=evaluate(method,range);frameResult.results[section][method.id]=combined;
      if(section==='all'&&['huzi','harmonic','hscp-v1','hscp-v2'].includes(method.id))for(const run of runs)for(const t of run.trades)ledger.push({frame,method:method.id,symbol:run.symbol,...t});
    }
  }
  const scores=candidates.map(c=>({candidate:c,...evaluate(c,splits.train).combined}));
  const eligible=scores.filter(s=>s.trades>=30&&Object.values(s.bySymbol).every(m=>m.trades>=10&&m.return>0));
  eligible.sort((a,b)=>Math.min(...Object.values(b.bySymbol).map(m=>m.return))-Math.min(...Object.values(a.bySymbol).map(m=>m.return))||b.return-a.return||a.candidate.id.localeCompare(b.candidate.id));
  const selected=eligible[0]?.candidate??null;
  const bestTrain=[...scores].sort((a,b)=>b.return-a.return||a.candidate.id.localeCompare(b.candidate.id))[0];
  frameResult.optimization={diagnosticBestTrain:{candidate:bestTrain.candidate,trainReturn:bestTrain.return,trainTrades:bestTrain.trades,validation:evaluate(bestTrain.candidate,splits.validation).combined,test:evaluate(bestTrain.candidate,splits.test).combined,accepted:eligible.some(s=>s.candidate.id===bestTrain.candidate.id),selectedByProtocol:!!selected&&selected.id===bestTrain.candidate.id},candidateCount:candidates.length,trainingScores:scores.map(({dailyReturns,...s})=>s),selected,validation:selected?evaluate(selected,splits.validation).combined:null,test:selected?evaluate(selected,splits.test).combined:null};
  frameResult.walkForward=[];
  for(let f=0;f<3;f++){
    const trainEnd=begin+Math.floor(span*(.6+f*.4/3))-1,testEnd=begin+Math.floor(span*(.6+(f+1)*.4/3))-1;
    const fit=candidates.map(c=>({candidate:c,...evaluate(c,[begin,trainEnd]).combined})).filter(s=>s.trades>=30&&Object.values(s.bySymbol).every(m=>m.trades>=10&&m.return>0));
    fit.sort((a,b)=>Math.min(...Object.values(b.bySymbol).map(m=>m.return))-Math.min(...Object.values(a.bySymbol).map(m=>m.return))||b.return-a.return||a.candidate.id.localeCompare(b.candidate.id));
    const choice=fit[0]?.candidate??null;frameResult.walkForward.push({fold:f+1,train:[begin,trainEnd],test:[trainEnd+1,testEnd],selected:choice,result:choice?evaluate(choice,[trainEnd+1,testEnd]).combined:null,default:evaluate(baseMethods.find(m=>m.id==='hscp-v2'),[trainEnd+1,testEnd]).combined});
  }
  for(const method of baseMethods.slice(0,4)){
    frameResult.costSensitivity[method.id]=[];
    for(const friction of [{feeBps:0,slippageBps:0},{feeBps:2,slippageBps:1},{feeBps:5,slippageBps:1},{feeBps:8,slippageBps:4}]){const {combined}=evaluate(method,splits.all,friction);frameResult.costSensitivity[method.id].push({...friction,...combined});}
  }
  for(const method of baseMethods.filter(m=>['hscp-v1','hscp-v2'].includes(m.id)))frameResult.management[method.id]={t1:frameResult.results.all[method.id],split:evaluate(method,splits.all,{exitMode:'split'}).combined,testSplit:evaluate(method,splits.test,{exitMode:'split'}).combined};
  frameResult.buyHoldPriceReturn=Object.fromEntries(Object.entries(splits).map(([key,[a,b]])=>[key,datasets.reduce((sum,d)=>sum+d.rows[b][4]/d.rows[a][1]-1,0)/datasets.length]));
  result.frames[frame]=frameResult;console.log(JSON.stringify({frame,all:Object.fromEntries(Object.entries(frameResult.results.all).slice(0,4).map(([k,v])=>[k,{trades:v.trades,return:v.return,pf:v.profitFactor}])),selected}));
}
result.sourceHashes=Object.fromEntries(['src/lib/patterns/confluence.ts','src/lib/patterns/huzi.ts','scripts/research/pattern-execution.mjs','scripts/research/pattern-signal-replay.mjs','scripts/research/pattern-features.mjs','scripts/research/pattern-evaluation.mjs','docs/research/pattern-audit-2026-09-27/run/baseline-detectors.mjs','docs/research/pattern-audit-2026-09-27/run/confluence-v1-source.txt'].map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,f))).digest('hex')]));
fs.writeFileSync(path.join(OUT,'evaluation.json'),JSON.stringify(result,null,2));fs.writeFileSync(path.join(OUT,'trade-ledger.json'),JSON.stringify(ledger));
const headers=['frame','method','symbol','id','direction','signalFamily','branch','entryTime','exitTime','entryIndex','exitIndex','entryPrice','exitPrice','gross','fees','slippageCost','fundingCost','netReturn','rMultiple','reason','ambiguous'];
fs.writeFileSync(path.join(OUT,'trades.csv'),headers.join(',')+'\n'+ledger.map(t=>headers.map(h=>JSON.stringify(t[h]??'')).join(',')).join('\n')+'\n');
