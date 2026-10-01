/** Offline acceptance: hand-counted arithmetic plus held-out public OHLCV
 * prefix/future-isolation invariants. No API calls, credentials, or orders. */
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {resolve} from 'node:path';
const root=process.cwd();
async function moduleFrom(path){const output=await build({entryPoints:[path],bundle:true,format:'esm',platform:'node',write:false});return import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));}
const smart=await moduleFrom('src/lib/analysis/smart-money.ts'),pf=await moduleFrom('src/lib/analysis/point-figure.ts');
const keys=['time','open','high','low','close','volume'];
function view(rows,end=rows.length,intervalMs=60000){const arrays=Object.fromEntries(keys.map((key,i)=>[key,Float64Array.from(rows,r=>+r[i])]));return {length:rows.length,closedLength:end,intervalMs,col:key=>arrays[key]};}
const labelled=JSON.parse(await readFile('tests/fixtures/point-figure-manual-holdout.json','utf8'));
const manual=labelled.cases.map(test=>{const cols=view(test.prices.map((c,i)=>[Date.UTC(2026,0,1)+i*60000,c,c,c,c,1]));
  const actual=pf.buildPointFigure(cols,test).columns.map(c=>[c.direction,c.lowBox,c.highBox]);
  return {id:test.id,pass:JSON.stringify(actual)===JSON.stringify(test.expected),expected:test.expected,actual};});
const scans=[];
for(const symbol of ['BTCUSDT','ETHUSDT'])for(const interval of ['1m','5m']){
  const path=`docs/research/jev-expanded-2026-09-22/run/shared-data/${symbol}-${interval}-bars.json`;
  let rows;try{rows=JSON.parse(await readFile(path,'utf8'));}catch{continue;}
  const ms=interval==='1m'?60000:300000;
  for(let sample=0;sample<8;sample++){
    const end=Math.floor(3200+(rows.length-3200)*(sample+1)/9),subset=rows.slice(Math.max(0,end-3200),Math.min(rows.length,end+50)),closedLength=Math.min(3200,end),cols=view(subset,closedLength,ms);
    const prefix=view(subset.slice(0,closedLength),closedLength,ms);
    const configs=[['order-block',smart.detectOrderBlocks,{pivotStrength:2,lookback:3000}],
      ['ict',smart.detectIctSetups,{timeZone:'America/New_York',reference:'either',lookback:3000,killzoneOnly:true}],
      ['point-figure',pf.detectPointFigure,{boxSize:symbol==='BTCUSDT'?25:1,lookback:3000}]];
    for(const [module,detect,params] of configs){
      const began=performance.now(),output=detect(cols,params),elapsedMs=performance.now()-began,expected=detect(prefix,params);
      const futureInvariant=JSON.stringify(output)===JSON.stringify(expected),lastKnown=subset[closedLength-1][0]+ms;
      const timeInvariant=output.every(o=>o.availableAt<=lastKnown&&o.events.every(e=>e.availableAt<=lastKnown));
      scans.push({symbol,interval,sample,module,from:new Date(subset[0][0]).toISOString(),through:new Date(lastKnown).toISOString(),count:output.length,
        invalidated:output.filter(o=>o.state==='invalidated').length,elapsedMs:Number(elapsedMs.toFixed(2)),futureInvariant,timeInvariant});
    }
  }
}
const report={createdAt:new Date().toISOString(),scope:'Engineering correctness and causal timing. Counts are not accuracy or profitability.',
  manual,scans,summary:{manualPassed:manual.filter(v=>v.pass).length,manualTotal:manual.length,causalPassed:scans.filter(v=>v.futureInvariant&&v.timeInvariant).length,causalTotal:scans.length,
    marketPrecision:null,marketRecall:null,reason:'No independent human-labelled market ground truth is available in these public OHLCV files.'}};
const output=resolve(process.argv[2]??'docs/technical-analysis-plan-2026-09-23/smc-pnf-acceptance.json');await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({output,...report.summary}));
if(manual.some(v=>!v.pass)||scans.some(v=>!v.futureInvariant||!v.timeInvariant))process.exitCode=1;
