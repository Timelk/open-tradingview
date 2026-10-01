import {build} from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
const entry=`export {IndicatorRegistry,registerBuiltins} from './src/lib/indicators/registry';export {IndicatorRuntime} from './src/lib/indicators/runtime';`;
const bundle=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
const {IndicatorRegistry,registerBuiltins,IndicatorRuntime}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const file='docs/research/jev-expanded-2026-09-22/run/shared-data/BTCUSDT-1m-bars.json',raw=fs.readFileSync(file),rows=JSON.parse(raw).slice(0,10031);
const keys=['time','open','high','low','close','volume'],arrays=Object.fromEntries(keys.map((key,i)=>[key,Float64Array.from(rows,r=>r[i])]));
const registry=new IndicatorRegistry();registerBuiltins(registry);
const ids=['pattern-huzi','pattern-harmonic','analysis-wyckoff','analysis-order-blocks','analysis-elliott','analysis-hurst'];
const reqs=ids.map(id=>({id,instanceId:id,params:registry.defaults(id),baseIntervalMs:60000}));
const runtime=new IndicatorRuntime(registry);runtime.set(reqs,true);
let length=10001;
const view=()=>({length,closedLength:length-1,intervalMs:60000,col:key=>arrays[key]});
const t=performance.now();runtime.compute(view(),0);const coldMs=performance.now()-t;
const quotes=[];let metadataReplacements=0,prior=runtime.compute(view(),length-1);
for(let i=0;i<1000;i++){
  arrays.close[length-1]+=(i%2?.01:-.01);const began=performance.now(),next=runtime.compute(view(),length-1);quotes.push(performance.now()-began);
  if(next.some((s,j)=>s.patterns!==prior[j]?.patterns||s.observations!==prior[j]?.observations||s.patternCandidates!==prior[j]?.patternCandidates))metadataReplacements++;
  prior=next;
}
const closes=[];
for(let i=0;i<30;i++){length++;const began=performance.now();runtime.compute(view(),length-2);closes.push(performance.now()-began);}
const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:values.length,medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],maxMs:sorted.at(-1)};};
const report={createdAt:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model},
  scope:'Actual production IndicatorRuntime, offline CPU computation. Worker isolates closed-bar scans in browser. This is not a GPU/frame-time benchmark or market accuracy.',
  source:{file,sha256:crypto.createHash('sha256').update(raw).digest('hex'),initialBars:10001},modules:reqs,coldMs,quotes:stats(quotes),quoteMetadataReplacements:metadataReplacements,closedBars:stats(closes)};
fs.writeFileSync('docs/technical-analysis-plan-2026-09-23/performance-generated.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({coldMs,quotes:report.quotes,quoteMetadataReplacements:metadataReplacements,closedBars:report.closedBars},null,2));
if(metadataReplacements)process.exitCode=1;
