/** Offline acceptance runner. Reads public OHLC only. No keys, model calls or
 * orders. Run: node scripts/analysis-acceptance.ts [--packets-only] */
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const root=process.cwd(),outDir=resolve('docs/technical-analysis-plan-2026-09-23'),fixtureDir=resolve('tests/fixtures');
const implementationDigests:Record<string,string>={};
async function moduleFrom(path:string){const output=await build({entryPoints:[path],bundle:true,format:'esm',platform:'node',write:false});implementationDigests[path]=createHash('sha256').update(output.outputFiles[0].text).digest('hex');return import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));}
const harmonic=await moduleFrom('src/lib/patterns/harmonic.ts'),classic=await moduleFrom('src/lib/patterns/huzi.ts');
const cycleModule=await moduleFrom('src/lib/analysis/cycles.ts'),gannModule=await moduleFrom('src/lib/analysis/gann.ts');
const candles=await moduleFrom('src/lib/analysis/candlesticks.ts'),waves=await moduleFrom('src/lib/analysis/waves.ts'),smart=await moduleFrom('src/lib/analysis/smart-money.ts'),pointFigure=await moduleFrom('src/lib/analysis/point-figure.ts');
const seed=0x20260923;let rngState=seed;const random=()=>{rngState=(Math.imul(rngState,1664525)+1013904223)>>>0;return rngState/4294967296;};
const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
type Rows=number[][];
const keys=['time','open','high','low','close','volume'];
function view(rows:Rows,closed=rows.length,intervalMs=60_000){const arrays=Object.fromEntries(keys.map((key,i)=>[key,Float64Array.from([...rows,...(closed===rows.length?[[rows.at(-1)?.[0]+intervalMs,NaN,NaN,NaN,NaN,NaN]]:[])],r=>+r[i])]));return {length:Math.min(arrays.time.length,closed+1),closedLength:closed,intervalMs,col:(name:string)=>arrays[name]};}
const detectorConfig={lookback:1500,pivotStrength:3,multiScale:true,maxPatterns:1000,maxObservations:300,showInvalidated:true};
function detectAll(rows:Rows,ms:number){const v=view(rows,rows.length,ms);return [
 ...harmonic.detectHarmonics(v,detectorConfig).map((p:any)=>({module:'harmonic',id:p.id,family:p.family,state:p.status,time:p.points.at(-1).time,availableAt:p.confirmedAt,points:p.points,direction:p.direction})),
 ...classic.detectHuzi(v,detectorConfig).map((p:any)=>({module:'classic',id:p.id,family:p.family,state:p.status,time:p.points.at(-1).time,availableAt:p.confirmedAt,points:p.points,direction:p.direction})),
 ...[['candlestick',candles.detectCandlesticks],['wolfe',waves.detectWolfeWaves],['elliott',waves.detectElliottWaves],['ict',smart.detectIctSetups]].flatMap(([module,detect]:any)=>detect(v,detectorConfig).map((p:any)=>({module,id:p.id,family:p.name,state:p.state,time:p.time,availableAt:p.availableAt,points:p.points,direction:p.direction}))),
 ];}
function cleanRows(raw:any):Rows {return raw.map((r:any)=>r.slice(0,6).map(Number));}
function integrity(rows:Rows,ms:number){let invalid=0,gaps=0,duplicates=0;for(let i=0;i<rows.length;i++){const [t,o,h,l,c,v]=rows[i];if(![t,o,h,l,c,v].every(Number.isFinite)||h<Math.max(o,c)||l>Math.min(o,c)||h<l||v<0||c<=0)invalid++;if(i){if(t<=rows[i-1][0])duplicates++;else if(t-rows[i-1][0]!==ms)gaps++;}}return {invalid,gaps,duplicates,pass:!invalid&&!gaps&&!duplicates};}
function svg(rows:Rows,id:string,symbol:string,frame:string){
 const width=1400,height=680,left=64,right=112,top=48,bottom=125,plotW=width-left-right,plotH=height-top-bottom;
 const low=Math.min(...rows.map(r=>r[3])),high=Math.max(...rows.map(r=>r[2])),pad=(high-low)*.07||1,min=low-pad,max=high+pad;
 const x=(i:number)=>left+(i+.5)*plotW/rows.length,y=(p:number)=>top+(max-p)/(max-min)*plotH,maxVolume=Math.max(...rows.map(r=>r[5])),body=Math.max(1,plotW/rows.length*.64);
 let html=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#111820"/><g font-family="ui-monospace,monospace" font-size="12" fill="#9fafbd"><text x="20" y="25">${id} · ${symbol} · ${frame} · CLOSED OHLCV · UNLABELLED</text>`;
 for(let i=0;i<=6;i++){const p=min+(max-min)*i/6,py=y(p);html+=`<path d="M${left} ${py}H${width-right}" stroke="#27313b"/><text x="${width-right+10}" y="${py+4}">${p.toFixed(p<10?5:2)}</text>`;}
 rows.forEach((r,i)=>{const color=r[4]>=r[1]?'#38b5a3':'#ec7979',px=x(i),vy=maxVolume?r[5]/maxVolume*60:0;html+=`<path d="M${px} ${y(r[2])}V${y(r[3])}" stroke="${color}"/><rect x="${px-body/2}" y="${Math.min(y(r[1]),y(r[4]))}" width="${body}" height="${Math.max(1,Math.abs(y(r[1])-y(r[4])))}" fill="${color}"/><rect x="${px-body/2}" y="${height-43-vy}" width="${body}" height="${vy}" fill="${color}" opacity=".45"/>`;});
 for(let i=0;i<rows.length;i+=32)html+=`<text x="${x(i)-12}" y="${height-20}">${i}</text>`;
 return html+`<text x="${left}" y="${height-3}">${new Date(rows[0][0]).toISOString()} → ${new Date(rows.at(-1)![0]).toISOString()} · X = row index</text></g></svg>`;
}
async function makePackets(){
 const blind=resolve(outDir,'blind-review');await mkdir(blind,{recursive:true});await mkdir(fixtureDir,{recursive:true});
 const sources:any[]=[],selected:any[]=[];
 for(const symbol of ['BTCUSDT','ETHUSDT'])for(const frame of ['1m','5m','4h']){
  const ms=frame==='1m'?60_000:frame==='5m'?300_000:14_400_000;
  let path=frame==='4h'?resolve(fixtureDir,`analysis-benchmark-real-${symbol}-4h.json`):resolve(`docs/research/jev-expanded-2026-09-22/run/shared-data/${symbol}-${frame}-bars.json`);
  if(frame==='4h'){try{await readFile(path);}catch{await copyFile(`/tmp/pattern-half-year/${symbol}-4h.json`,path);}}
  const bytes=await readFile(path),rows=cleanRows(JSON.parse(bytes.toString())),usable=rows.slice(0,-1),summary={symbol,frame,path:path.slice(root.length+1),sha256:sha(bytes),rowCount:rows.length,excludedLastRow:true,fromTime:rows[0][0],throughTime:usable.at(-1)![0],integrity:integrity(usable,ms)};
  sources.push(summary);
  for(let partition=0;partition<4;partition++){
   const qStart=Math.floor(usable.length*partition/4),qEnd=Math.floor(usable.length*(partition+1)/4),width=Math.min(256,qEnd-qStart);
   let start=qStart+Math.floor(random()*Math.max(1,qEnd-qStart-width)),selection='random';
   if(partition%2===0){
    const poolStart=Math.max(qStart,qEnd-1500),pool=usable.slice(poolStart,qEnd),observed=detectAll(pool,ms).filter(p=>['harmonic','classic','wolfe'].includes(p.module)&&p.points.length>=3&&p.availableAt<=usable[qEnd-1][0]+ms);
    const possible=observed.filter(p=>{const a=Math.floor((p.points[0].time-usable[poolStart][0])/ms)+poolStart,b=Math.floor((p.availableAt-usable[poolStart][0])/ms)+poolStart;return b-a<width-24&&a>=qStart;});
    if(possible.length){const p=possible[Math.floor(random()*possible.length)],at=poolStart+Math.floor((p.points[0].time-usable[poolStart][0])/ms);start=Math.max(qStart,Math.min(qEnd-width,at-12));selection='detector-enriched';}
   }
   const data=usable.slice(start,start+width);selected.push({symbol,frame,ms,data,sourceSha256:summary.sha256,startIndex:start,endIndex:start+width,partition,selection});
  }
 }
 for(let i=selected.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[selected[i],selected[j]]=[selected[j],selected[i]];}
 const map:any[]=[],manifest:any[]=[];
 for(let i=0;i<selected.length;i++){
  const sample=selected[i],id=`window-${String(i+1).padStart(2,'0')}`,payload={id,symbol:sample.symbol,frame:sample.frame,columns:keys,groundTruth:'unknown',rows:sample.data};
  await writeFile(resolve(blind,`${id}.json`),JSON.stringify(payload));await writeFile(resolve(blind,`${id}.svg`),svg(sample.data,id,sample.symbol,sample.frame));
  manifest.push({id,symbol:sample.symbol,frame:sample.frame,data:`${id}.json`,chart:`${id}.svg`,groundTruth:'unknown'});
  map.push({id,symbol:sample.symbol,frame:sample.frame,sourceSha256:sample.sourceSha256,startIndex:sample.startIndex,endIndex:sample.endIndex,partition:sample.partition,selection:sample.selection,integrity:integrity(sample.data,sample.ms),predictions:detectAll(sample.data,sample.ms)});
 }
 await writeFile(resolve(blind,'manifest.json'),JSON.stringify({version:'blind-real-ohlcv/1',seed,source:'public Binance USD-M OHLCV',groundTruth:'unknown',windows:manifest},null,2));
 await writeFile(resolve(blind,'REVIEW-INSTRUCTIONS.md'),'# Independent blinded review\n\nReview only files in this directory. Do not open production detectors or held-out prediction maps. Ground truth is UNKNOWN. These are real closed OHLCV windows, selected by a mixture of fixed seeded random sampling and enrichment, then shuffled. No predictions or selected-family labels appear here.\n\nFor each window record: id, integrity concerns, positive geometric labels (from Gartley/Bat/Butterfly/Crab/Deep Crab/Shark/Cypher/AB=CD/Three Drives, head-shoulders/double/triangle/wedge/flag, Pin Bar/Engulfing/Doji/Morning Star, Wolfe/Elliott), anchor row indices and evidence; explicit absent labels only when actually checked; ambiguous/unreviewed labels separately. Distinguish a plausible outline from ratio-qualified harmonic and structural confirmation. Do not infer winning trades. Use JSON {reviewer, methodology, windows:[{id, labels:[{family, anchors, confidence, rationale}], checkedAbsent:[], uncertain:[], integrity:[]}]}. Every detection is an independent AI annotation, not an external human gold standard.\n');
 await writeFile(resolve(blind,'index.html'),`<!doctype html><meta charset="utf-8"><title>Blind public OHLCV windows</title><style>body{background:#0e141a;color:#d8e0e6;font:14px sans-serif;margin:24px}img{width:100%;max-width:1400px;border:1px solid #2c3946}a{color:#99cce7}section{margin-bottom:32px}</style><h1>24 unlabeled public OHLCV windows</h1><p>Ground truth unknown. Independent review only. X axis is row index.</p>${manifest.map(m=>`<section><h2>${m.id} · ${m.symbol} · ${m.frame}</h2><a href="${m.data}">OHLCV JSON</a><br><img src="${m.chart}" alt="Unlabelled OHLCV ${m.id}"></section>`).join('')}`);
 await writeFile(resolve(outDir,'acceptance-held-out-predictions.json'),JSON.stringify({version:'acceptance-held-out/1',seed,sources,windows:map},null,2));
 await writeFile(resolve(fixtureDir,'analysis-benchmark-real-manifest.json'),JSON.stringify({version:'public-source-freeze/1',sources},null,2));
 console.log(JSON.stringify({blindDirectory:blind,windows:manifest.length,predictionMap:resolve(outDir,'acceptance-held-out-predictions.json'),sourceCount:sources.length}));return {sources,windows:map};
}
let real:any;try{real=JSON.parse(await readFile(resolve(outDir,'acceptance-held-out-predictions.json'),'utf8'));if(process.argv.includes('--refresh-packets'))real=await makePackets();}catch{real=await makePackets();}

const familyIds:Record<string,string>={'Head Shoulders':'huzi-head-shoulders',Double:'huzi-double',Triangle:'huzi-triangle',Wedge:'huzi-wedge',Flag:'huzi-flag'};
function runCase(test:any,closed=test.rows.length){
 const v=view(test.rows,closed),p={...test.params,lookback:1500};let output:any[]=[];
 if(test.module==='harmonic')output=harmonic.detectHarmonics(v,p).filter((m:any)=>m.family===test.label);
 if(test.module==='classic')output=classic.detectHuzi(v,p).filter((m:any)=>m.family===familyIds[test.label]);
 if(test.module==='candlestick')output=candles.detectCandlesticks(v,p).filter((m:any)=>m.name.includes(test.label)&&m.time===test.targetTime);
 if(test.module==='wolfe')output=waves.detectWolfeWaves(v,p).filter((m:any)=>m.points.length===5);
 if(test.module==='elliott')output=waves.detectElliottWaves(v,p).filter((m:any)=>m.ruleVersion==='elliott-impulse/1.0');
 if(test.module==='ict')output=smart.detectIctSetups(v,p).filter((m:any)=>m.time===test.targetTime);
 if(test.module==='point-figure'){
  const result=pointFigure.buildPointFigure(v,p),measurement=pointFigure.measurePointFigure(result,p);
  return {predicted:!!measurement,abstained:false,output:measurement?[{id:'point-figure-measurement',availableAt:measurement.availableAt,time:measurement.throughTime,measurement}]:[]};
 }
 const eligible=output.filter(m=>test.module==='ict'?m.events?.some((e:any)=>e.kind==='fvg'):test.module==='elliott'?m.state==='confirmed':true);
 return {predicted:eligible.length>0,abstained:!eligible.length&&output.some(m=>m.state==='observing'),output:eligible};
}
function summarizeCases(rows:any[]){
 const tp=rows.filter(r=>r.expected&&r.predicted).length,fp=rows.filter(r=>!r.expected&&r.predicted).length,fn=rows.filter(r=>r.expected&&!r.predicted).length,tn=rows.filter(r=>!r.expected&&!r.predicted).length;
 const delays=rows.flatMap(r=>r.delayBars===null?[]:[r.delayBars]).sort((a,b)=>a-b);
 return {N:rows.length,positiveTruth:tp+fn,negativeTruth:fp+tn,tp,fp,fn,tn,precision:tp+fp?tp/(tp+fp):null,recall:tp+fn?tp/(tp+fn):null,abstentions:rows.filter(r=>r.abstained).length,medianDelayBars:delays.length?delays[Math.floor(delays.length/2)]:null,prefixPass:rows.filter(r=>r.prefixCheck.pass).length,prefixTotal:rows.length};
}
async function synthetic(){
 const oracle=await moduleFrom('tests/fixtures/analysis-benchmark-oracle.ts'),cases=oracle.buildBenchmarkCases();
 await writeFile(resolve(fixtureDir,'analysis-benchmark-synthetic.json'),JSON.stringify({version:'independent-geometry/1',seed,provenance:'Independent deterministic construction and explicit mathematical/hand labels. No detector output is used to label a fixture. This is not a market gold standard.',cases}));
 const results=cases.map((test:any)=>{
  const result=runCase(test),earliest=result.output.reduce((a:number,p:any)=>Math.min(a,p.confirmedAt??p.availableAt),Infinity),record=result.output.find((p:any)=>(p.confirmedAt??p.availableAt)===earliest);
  let prefixCheck={pass:true,beforeAbsent:true,atPresent:true,futureIsolated:true};
  if(record&&test.module!=='point-figure'){
   const end=Math.round((earliest-test.rows[0][0])/60_000),before=runCase(test,Math.max(0,end-1)),at=runCase(test,Math.min(test.rows.length,end));
   prefixCheck.beforeAbsent=!before.output.some((p:any)=>p.id===record.id);prefixCheck.atPresent=at.output.some((p:any)=>p.id===record.id);
   const cut=Math.max(1,Math.min(test.rows.length-1,end)),mutated={...test,rows:test.rows.map((r:number[],i:number)=>i<cut?r:[r[0],9999,10000,9998,9999,9999])};
   prefixCheck.futureIsolated=JSON.stringify(runCase(test,cut))===JSON.stringify(runCase(mutated,cut));
   prefixCheck.pass=prefixCheck.beforeAbsent&&prefixCheck.atPresent&&prefixCheck.futureIsolated;
  }
  return {id:test.id,label:test.label,module:test.module,variant:test.variant,expected:test.expected,predicted:result.predicted,abstained:result.abstained,oracle:test.oracle,detected:result.output.map((p:any)=>({id:p.id,family:p.family??p.name,availableAt:p.confirmedAt??p.availableAt,state:p.status??p.state})),delayBars:Number.isFinite(earliest)&&test.targetTime!==undefined?(earliest-test.targetTime)/60_000:null,prefixCheck};
 });
 const summaries=Object.fromEntries([...new Set(results.map((r:any)=>r.label))].map(label=>[label,summarizeCases(results.filter((r:any)=>r.label===label))]));
 return {provenance:'synthetic independent-rule oracle, not market accuracy',independentBaseTemplates:22,relatedVariants:true,fixtureSha256:sha(await readFile(resolve(fixtureDir,'analysis-benchmark-synthetic.json'))),total:summarizeCases(results),families:summaries,results};
}
async function realChecks(){
 const checks:any[]=[];const sourceMetadata=real.sources;
 for(const entry of real.windows){
  const packet=JSON.parse(await readFile(resolve(outDir,'blind-review',`${entry.id}.json`),'utf8')),rows:Rows=packet.rows,ms=packet.frame==='1m'?60000:packet.frame==='5m'?300000:14400000;
  const split=Math.floor(rows.length*.75),observed=rows.slice(0,split),future=rows.slice(split),full=rows;
  const configs:any[]=[['harmonic',harmonic.detectHarmonics,detectorConfig],['classic',classic.detectHuzi,detectorConfig],['candlestick',candles.detectCandlesticks,detectorConfig],['wolfe',waves.detectWolfeWaves,detectorConfig],['elliott',waves.detectElliottWaves,detectorConfig],['ict',smart.detectIctSetups,detectorConfig],['point-figure',pointFigure.detectPointFigure,{...detectorConfig,boxSize:packet.symbol==='BTCUSDT'?25:1}]];
  for(const [module,detect,params] of configs){
   const prefix=detect(view(observed,observed.length,ms),params),hidden=detect(view(full,split,ms),params),changed=full.map((r,i)=>i<split?r:[r[0],r[1]*7,r[2]*7,r[3]*7,r[4]*7,r[5]*7]),mutated=detect(view(changed,split,ms),params),known=observed.at(-1)![0]+ms;
   const futureIsolation=JSON.stringify(prefix)===JSON.stringify(hidden)&&JSON.stringify(hidden)===JSON.stringify(mutated);
   const availableTimes=prefix.every((p:any)=>(p.confirmedAt??p.availableAt)<=known&&(p.events??[]).every((e:any)=>(e.knownAt??e.availableAt)<=known));
   const responses=prefix.filter((p:any)=>p.direction==='bullish'||p.direction==='bearish').slice(0,20).flatMap((p:any)=>{
    const knownAt=p.confirmedAt??p.availableAt,at=observed.findIndex(r=>r[0]>=knownAt);if(at<0||at+12<split)return [];
    const entryPrice=full[at]?.[1],end=full[at+12];if(!entryPrice||!end)return [];
    const side=p.direction==='bullish'?1:-1;return [{id:p.id,knownAt,reference:'next available open; descriptive 12-bar subsequent return, not an entry or win',responseBars:12,directionalReturn:side*(end[4]/entryPrice-1)}];
   });
   checks.push({id:entry.id,module,symbol:packet.symbol,frame:packet.frame,closedBars:observed.length,holdoutBars:future.length,sourceIntegrity:integrity(rows,ms),predictionCount:prefix.length,futureIsolation,availableTimes,pass:futureIsolation&&availableTimes,responses});
  }
 }
 return {provenance:'fixed disjoint public windows; no external human labels',sources:sourceMetadata,NWindows:real.windows.length,checks,total:{causalPassed:checks.filter(c=>c.pass).length,causalTotal:checks.length,integrityPassed:checks.filter(c=>c.sourceIntegrity.pass).length,marketPrecision:null,marketRecall:null,reason:'Independent blinded review is pending. Response statistics do not establish recognition accuracy.'}};
}
async function main(){
 const syntheticReport=await synthetic(),market=await realChecks(),report={version:'analysis-acceptance/1',implementationDigests,generatedAt:new Date().toISOString(),seed,scope:'Detection-rule correctness is measured on independent synthetic constructions; real windows have unknown labels until independent blinded AI review. Counts and test pass rates are not trading accuracy.',synthetic:syntheticReport,real:market,blindReview:{directory:'blind-review',windows:24,status:'awaiting independent reviewer',heldOutPredictions:'acceptance-held-out-predictions.json'}};
 await writeFile(resolve(outDir,'acceptance-generated.json'),JSON.stringify(report,null,2));
 const table=Object.entries(syntheticReport.families).map(([label,r]:any)=>`| ${label} | ${r.N} | ${r.tp}/${r.fp}/${r.fn}/${r.tn} | ${r.precision===null?'—':(r.precision*100).toFixed(1)+'%'} | ${r.recall===null?'—':(r.recall*100).toFixed(1)+'%'} | ${r.abstentions} | ${r.medianDelayBars??'—'} | ${r.prefixPass}/${r.prefixTotal} |`).join('\n');
 const mismatches=syntheticReport.results.filter((r:any)=>r.expected!==r.predicted||!r.prefixCheck.pass).map((r:any)=>`- ${r.id}：标注 ${r.expected} / 检测 ${r.predicted}；前缀 ${r.prefixCheck.pass?'通过':'失败'}`).join('\n');
 await writeFile(resolve(outDir,'acceptance-generated.md'),`# 实际自验收结果\n\n生成：${report.generatedAt}。复跑：\`node scripts/analysis-acceptance.ts\`。种子 ${seed}。\n\n合成集由独立规则文件先生成/标注，不导入生产 detector 进行真值判定。以下 precision/recall **仅针对受控合成几何窗口**，不是真实交易或完整理论准确率。观察态弃权单列；正例弃权仍计入漏检。目标是核对窗口内目标家族/指定末柱，不评价盈亏。\n\n| 标签 | N | TP/FP/FN/TN | 精确率 | 召回率 | 弃权 | 中位确认延迟/柱 | 前缀 |\n|---|---:|---|---:|---:|---:|---:|---|\n${table}\n\n## 不一致记录（没有为通过而调门槛）\n\n${mismatches||'无。'}\n\n## 真实公共数据\n\nBTC/ETH × 1m/5m/4h，24个不重叠固定窗口；逐源 SHA256 与时间范围记录在 JSON。因果前缀 ${market.total.causalPassed}/${market.total.causalTotal}；源OHLC完整性 ${market.total.integrityPassed}/${market.total.causalTotal}。未来12柱响应只是描述性读数，不是交易胜率。\n\n真实市场识别精确率/召回率暂未填：24个无标签图窗已交给独立AI盲审，真值不能用生产输出替代。盲审对照将另行列出有限样本 agreement/precision/recall，明确AI标注和歧义，不冒充外部真人金标准。\n\n盲包：\`blind-review/\`；根单独保管：\`acceptance-held-out-predictions.json\`。重复运行默认不改变已交审窗；只在明确传 \`--refresh-packets\` 时重新生成。\n`);
 console.log(JSON.stringify({output:resolve(outDir,'acceptance-generated.json'),synthetic:syntheticReport.total,real:market.total,mismatches:syntheticReport.results.filter((r:any)=>r.expected!==r.predicted).length}));
}

async function numericAcceptance(){
 const periodic:any[]=[],gann:any[]=[];
 for(const period of [19,31,47,73])for(let sample=0;sample<6;sample++){
  const amplitude=2+sample*.7,phase=sample*.47,values=Array.from({length:600},(_,i)=>300+.012*i+amplitude*Math.cos(2*Math.PI*i/period+phase));
  const result=cycleModule.estimateCausalCycles(values,{minPeriod:8,maxPeriod:100}),error=result.length?Math.abs(result[0].periodBars-period):null;
  periodic.push({kind:'known-sinusoidal-plus-trend',period,sample,predictedPeriod:result[0]?.periodBars??null,error,pass:error!==null&&error<=1,truth:'analytically specified periodic component, not a market forecast'});
 }
 for(let sample=0;sample<12;sample++){
  let state=0x4567+sample;const values=Array.from({length:600},(_,i)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return 300+i*.01+(state/4294967296-.5)*5;});
  const output=cycleModule.estimateCausalCycles(values,{minPeriod:8,maxPeriod:100});periodic.push({kind:'seeded-noise-plus-trend',sample,predictedPeriods:output.map((p:any)=>p.periodBars),pass:output.length===0,truth:'no deliberately embedded deterministic cycle; false-positive diagnostic only'});
 }
 for(const direction of [1,-1])for(const ratio of [.125,.5,1,2,8])for(const elapsed of [0,3,17]){
  const expected=100+direction*elapsed*2*ratio,actual=gannModule.gannPriceAt(1000+elapsed*60_000,1000,100,2,60_000,ratio,direction);
  gann.push({direction,ratio,elapsed,expected,actual,pass:Math.abs(expected-actual)<1e-10});
 }
 return {periodic:{N:periodic.length,passed:periodic.filter(p=>p.pass).length,meanAbsolutePeriodError:periodic.filter(p=>p.error!==undefined&&p.error!==null).reduce((s,p)=>s+p.error,0)/24,results:periodic},gann:{N:gann.length,passed:gann.filter(p=>p.pass).length,results:gann}};
}
function canonicalFamily(value:string):string|undefined {
 const text=value.toLowerCase().replace(/[ _-]/g,'');
 const list:Record<string,string>={gartley:'Gartley',bat:'Bat',butterfly:'Butterfly',crab:'Crab',deepcrab:'Deep Crab',shark:'Shark',cypher:'Cypher','ab=cd':'AB=CD',abcd:'AB=CD',threedrives:'Three Drives','huzheadshoulders':'Head Shoulders',huzidouble:'Double',huzitriangle:'Triangle',huziwedge:'Wedge',huziflag:'Flag',headshoulders:'Head Shoulders',double:'Double',triangle:'Triangle',wedge:'Wedge',flag:'Flag',pinbar:'Pin Bar',engulfing:'Engulfing',doji:'Doji',morningstar:'Morning Star',wolfe:'Wolfe',elliott:'Elliott hard rules'};
 if(list[text])return list[text];
 for(const token of ['deepcrab','threedrives','butterfly','gartley','cypher','shark','ab=cd','abcd','crab','bat'])if(text.includes(token))return list[token];
 if(text.includes('head')&&text.includes('shoulder')||text.includes('头肩'))return 'Head Shoulders';
 if(text.includes('double')||text.includes('双底')||text.includes('双顶'))return 'Double';
 if(text.includes('triangle')||text.includes('三角'))return 'Triangle';if(text.includes('wedge')||text.includes('楔形'))return 'Wedge';if(text.includes('flag')||text.includes('旗形'))return 'Flag';
 for(const [test,label] of [['pinbar','Pin Bar'],['engulfing','Engulfing'],['doji','Doji'],['morningstar','Morning Star'],['wolfe','Wolfe'],['elliott','Elliott hard rules']])if(text.includes(test))return label;
}
async function blindedScore(){
 const arg=process.argv.indexOf('--review');if(arg<0||!process.argv[arg+1])return undefined;
 const path=resolve(process.argv[arg+1]),review=JSON.parse(await readFile(path,'utf8')),scopes:any[]=[];
 for(const window of review.windows??[]){
  const entry=real.windows.find((w:any)=>w.id===window.id);if(!entry)continue;
  const truth=new Set((window.labels??[]).filter((v:any)=>v.confidence!=='low').map((v:any)=>canonicalFamily(v.family)).filter(Boolean));
  const absent=new Set((window.checkedAbsent??[]).map((v:any)=>canonicalFamily(typeof v==='string'?v:v.family)).filter(Boolean));
  const uncertain=new Set((window.uncertain??[]).map((v:any)=>canonicalFamily(typeof v==='string'?v:v.family)).filter(Boolean));
  const predicted=new Set(entry.predictions.filter((p:any)=>p.module!=='wolfe'||p.points.length===5).filter((p:any)=>p.module!=='elliott'||String(p.family).includes('五浪')).map((p:any)=>canonicalFamily(p.family)).filter(Boolean));
  for(const family of new Set([...truth,...absent]))if(!uncertain.has(family))scopes.push({window:window.id,family,truth:truth.has(family),predicted:predicted.has(family)});
 }
 const metric=(rows:any[])=>{const tp=rows.filter(r=>r.truth&&r.predicted).length,fp=rows.filter(r=>!r.truth&&r.predicted).length,fn=rows.filter(r=>r.truth&&!r.predicted).length,tn=rows.filter(r=>!r.truth&&!r.predicted).length;return {N:rows.length,tp,fp,fn,tn,precision:tp+fp?tp/(tp+fp):null,recall:tp+fn?tp/(tp+fn):null,agreement:rows.length?(tp+tn)/rows.length:null};};
 const regressions:any[]=[],anchored:any[]=[];
 for(const window of review.windows??[]){
  const scoped=scopes.filter(s=>s.window===window.id);if(!scoped.length)continue;
  const packet=JSON.parse(await readFile(resolve(outDir,'blind-review',window.id+'.json'),'utf8')),ms=packet.frame==='1m'?60_000:packet.frame==='5m'?300_000:14_400_000,current=detectAll(packet.rows,ms),baseline=real.windows.find((w:any)=>w.id===window.id).predictions;
  regressions.push({id:window.id,predictions:current});
  const nearest=(predictions:any[],label:any)=>predictions.filter(p=>canonicalFamily(p.family)===canonicalFamily(label.family)&&p.points.length===label.anchors.length&&(!label.direction||p.direction===label.direction)).map(p=>{const anchors=p.points.map((point:any)=>packet.rows.findIndex((r:any)=>r[0]===point.time)),errors=anchors.map((index:number,i:number)=>Math.abs(index-label.anchors[i]));return {id:p.id,anchors,prices:p.points.map((point:any)=>point.value),maxErrorBars:Math.max(...errors),meanErrorBars:errors.reduce((a:number,b:number)=>a+b,0)/errors.length};}).sort((a,b)=>a.meanErrorBars-b.meanErrorBars)[0]??null;
  for(const label of window.labels??[])if(scoped.some(s=>s.truth&&s.family===canonicalFamily(label.family))&&Array.isArray(label.anchors)&&label.anchors.length){const before=nearest(baseline,label),after=nearest(current,label);anchored.push({window:window.id,family:canonicalFamily(label.family),reviewerAnchors:label.anchors,reviewerConfidence:label.confidence,baselineNearest:before,regressionNearest:after,baselineExact:before?.maxErrorBars===0,baselineWithinOneBar:before!==null&&before.maxErrorBars<=1,regressionExact:after?.maxErrorBars===0,regressionWithinOneBar:after!==null&&after.maxErrorBars<=1});}
 }
 const anchorSummary={N:anchored.length,baselineExact:anchored.filter(a=>a.baselineExact).length,baselineWithinOneBar:anchored.filter(a=>a.baselineWithinOneBar).length,regressionExact:anchored.filter(a=>a.regressionExact).length,regressionWithinOneBar:anchored.filter(a=>a.regressionWithinOneBar).length,precision:null,falsePositiveRate:null,scope:'Positive annotated structures only. Exact anchor localization and one-bar sensitivity are distinct. Unreviewed predictions are not presumed false. Re-running known windows after repair is regression, not new holdout.'};
 await writeFile(resolve(outDir,'acceptance-regression-predictions.json'),JSON.stringify({generatedAt:new Date().toISOString(),scope:'Same formerly blinded windows after repairs: regression only, not new independent validation',baselineFile:'acceptance-held-out-predictions.json',implementationDigests,windows:regressions},null,2));
 return {reviewFile:path.slice(root.length+1),sha256:sha(await readFile(path)),reviewer:review.reviewer,methodology:review.methodology,scope:'family/window agreement against independent blinded AI annotations; ambiguous and unchecked classes excluded; not external-human gold-standard accuracy',reviewedWindows:new Set(scopes.map(s=>s.window)).size,inspectedWindows:(review.windows??[]).length,falsePositiveRate:null,falsePositiveRateReason:'No scored negative family/window labels: TN=FP=0, false-positive rate cannot be estimated.',total:metric(scopes),families:Object.fromEntries([...new Set(scopes.map(s=>s.family))].map(f=>[f,metric(scopes.filter(s=>s.family===f))])),scopes,anchorSummary,anchored};
}
if(!process.argv.includes('--packets-only')){
 await main();const path=resolve(outDir,'acceptance-generated.json'),report=JSON.parse(await readFile(path,'utf8'));report.numeric=await numericAcceptance();const blind=await blindedScore();if(blind){report.blindReview=blind;report.real.total.marketPrecision=null;report.real.total.marketRecall=null;report.real.total.reviewScopedPrecision=blind.total.precision;report.real.total.reviewScopedRecall=blind.total.recall;report.real.total.reason='Population recognition accuracy is not estimated. Review-scoped values are coarse family/window agreement on a positive-only AI-labelled subset; use anchorSummary for localization.';}
 report.real.responseSummary=Object.fromEntries([...new Set(report.real.checks.map((c:any)=>c.module))].map(module=>{const values=report.real.checks.filter((c:any)=>c.module===module).flatMap((c:any)=>c.responses.map((r:any)=>r.directionalReturn)).sort((a:number,b:number)=>a-b);return [module,{N:values.length,meanBps:values.length?values.reduce((a:number,b:number)=>a+b,0)/values.length*10000:null,medianBps:values.length?values[Math.floor(values.length/2)]*10000:null,meaning:'Descriptive orientation-aligned 12-bar response in an enriched/nonrepresentative sample. Not a trading win rate or signal accuracy.'}];}));
 await writeFile(path,JSON.stringify(report,null,2));
 const note=`\n## 附加数值自验收\n\n独立周期信号/噪声 ${report.numeric.periodic.passed}/${report.numeric.periodic.N}；已植入周期的平均绝对误差 ${report.numeric.periodic.meanAbsolutePeriodError.toFixed(3)} 柱。Gann 独立价时算术 ${report.numeric.gann.passed}/${report.numeric.gann.N}。\n\n合成几何 22 个基础模板采用镜像、缩放、边界与额外确定随机种子扰动；各窗口高度相关，不能将窗口数量当成同等数量的独立市场样本。\n${blind?`\n## 独立盲审对照\n\n仅在独立AI确实检查、非歧义的家族/窗口范围对照：${JSON.stringify(blind.total)}。独立审阅共完成 ${blind.inspectedWindows} 个窗口，实际可评分 ${blind.reviewedWindows} 个窗口 / ${blind.total.N} 项；TN=0，不能估计误报率。这里仅是粗粒度家族/窗口一致性（同家族可能出现在不同位置），不是同一结构命中。锚点级对照：修前精确 ${blind.anchorSummary.baselineExact}/${blind.anchorSummary.N}，±1柱敏感性 ${blind.anchorSummary.baselineWithinOneBar}/${blind.anchorSummary.N}；修后同窗回归精确 ${blind.anchorSummary.regressionExact}/${blind.anchorSummary.N}，±1柱敏感性 ${blind.anchorSummary.regressionWithinOneBar}/${blind.anchorSummary.N}。修后不是新的holdout。这里是有限真实样本上的AI标注一致性，不是外部真人金标准或交易胜率。详细逐项分歧在JSON的blindReview.scopes。\n`:''}`;
 let markdown=await readFile(resolve(outDir,'acceptance-generated.md'),'utf8');if(blind)markdown=markdown.replace('真实市场识别精确率/召回率暂未填：24个无标签图窗已交给独立AI盲审，真值不能用生产输出替代。盲审对照将另行列出有限样本 agreement/precision/recall，明确AI标注和歧义，不冒充外部真人金标准。',`独立AI已完成 ${blind.inspectedWindows} 个图窗审阅；实际可评分 ${blind.reviewedWindows} 个窗口、${blind.total.N} 项。总体 marketPrecision/marketRecall 仍为 null（总体未估计），局部粗粒度对照另记 reviewScopedPrecision/Recall；没有可评分TN，不能估计FPR。精确同结构命中必须另核对锚点，详见后文。修前冻结报告与预测保留；修后重跑同窗属于回归。`);
 await writeFile(resolve(outDir,'acceptance-generated.md'),markdown+note);
 if(report.synthetic.total.prefixPass!==report.synthetic.total.prefixTotal||report.real.total.causalPassed!==report.real.total.causalTotal||report.numeric.gann.passed!==report.numeric.gann.N)process.exitCode=1;
 console.log(JSON.stringify({numeric:{periodic:report.numeric.periodic.passed+'/'+report.numeric.periodic.N,gann:report.numeric.gann.passed+'/'+report.numeric.gann.N},blindReview:blind?.total??'pending independent review'}));
}
