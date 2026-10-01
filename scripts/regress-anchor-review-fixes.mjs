/** Post-unblinding regression only. Never rewrites the frozen review, score,
 * sample cards, or held-out mapping. The pre-fix outputs were captured before
 * adding the raw source-leg guard. */
import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const base='docs/technical-analysis-plan-2026-09-23';
const before=JSON.parse(await readFile(`${base}/anchor-regression-before.json`,'utf8'));
const load=async path=>{const result=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));};
const harmonic=await load('src/lib/patterns/harmonic.ts'),classic=await load('src/lib/patterns/huzi.ts'),keys=['time','open','high','low','close','volume'];
const frozenChecks=[];
for(const [path,expected] of Object.entries(before.frozenHashes)){
  const actual=createHash('sha256').update(await readFile(path)).digest('hex');frozenChecks.push({path,expected,actual,unchanged:expected===actual});
}
const records=[];
for(const prior of before.records){
  const card=JSON.parse(await readFile(`${base}/anchor-review-round2/${prior.id}.json`,'utf8')),ms=card.frame==='4h'?14400000:card.frame==='5m'?300000:60000;
  const rows=[...card.rows,[card.rows.at(-1)[0]+ms,NaN,NaN,NaN,NaN,NaN]],columns=Object.fromEntries(keys.map((key,i)=>[key,Float64Array.from(rows,r=>r[i])]));
  const cols={length:rows.length,closedLength:card.rows.length,intervalMs:ms,col:key=>columns[key]};
  const all=prior.module==='harmonic'?harmonic.detectHarmonics(cols,before.params):classic.detectHuzi(cols,before.params),found=all.find(item=>item.id===prior.predictionId);
  const after=found?{name:found.name,state:found.status,direction:found.direction,confirmedAt:found.confirmedAt,points:found.points,ratios:found.ratios,ruleVersion:found.ruleVersion,events:found.events}:null;
  records.push({id:prior.id,module:prior.module,predictionId:prior.predictionId,beforeFound:prior.found,afterFound:!!found,
    sameAnchors:found?JSON.stringify(found.points)===JSON.stringify(prior.points):null,sameConfirmation:found?found.confirmedAt===prior.confirmedAt:null,
    sameRatios:found?JSON.stringify(found.ratios)===JSON.stringify(prior.ratios):null,before:{name:prior.name,state:prior.state,direction:prior.direction,confirmedAt:prior.confirmedAt},after});
}
const removed=records.filter(r=>r.beforeFound&&!r.afterFound).map(r=>r.id);
const report={phase:'post-unblinding same-window regression; NOT a new independent validation',createdAt:new Date().toISOString(),
  patch:{scope:'Raw interior high/low must remain inside every harmonic leg. Shared by confirmed and candidate branches.',ratioProfilesChanged:false,huziCodeChanged:false},
  frozenChecks,summary:{preFixFound:records.filter(r=>r.beforeFound).length,postFixFound:records.filter(r=>r.afterFound).length,removed,
    retainedChangedAnchors:records.filter(r=>r.afterFound&&!r.sameAnchors).map(r=>r.id),retainedChangedConfirmation:records.filter(r=>r.afterFound&&!r.sameConfirmation).map(r=>r.id),
    retainedChangedRatios:records.filter(r=>r.afterFound&&!r.sameRatios).map(r=>r.id)},records,
  interpretation:['anchor-30 is an actual source-leg defect; removing it does not increase recall and does not prove profitability.',
    'The three Head Shoulders cards are explicitly named upward continuation and cross the head extreme, not a falsely confirmed downward neckline break.',
    'anchor-45 satisfies both the all-touch fitted wedge profile and a first-four-points plus fifth-point-overrun Wolfe interpretation; frozen family-disagreement score is retained.',
    'Frozen held-out states can reflect lifecycle after the displayed first-known prefix; this regression recomputes state strictly at each card cutoff.']};
await writeFile(`${base}/anchor-regression-after.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({frozenUnchanged:frozenChecks.every(v=>v.unchanged),...report.summary}));
if(frozenChecks.some(v=>!v.unchanged)||removed.length!==1||removed[0]!=='anchor-30'||records.some(r=>r.afterFound&&(!r.sameAnchors||!r.sameConfirmation||!r.sameRatios)))process.exitCode=1;
