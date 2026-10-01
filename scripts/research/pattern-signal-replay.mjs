/** Causal first-seen signal ledger. No future-status filtering or backdated fills. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=path.join(root,'docs/research/pattern-audit-2026-09-27/run');
const detectors=await import(path.join(out,'baseline-detectors.mjs'));
const [symbol='BTCUSDT',frame='5m']=process.argv.slice(2);
const file=frame==='4h'?`tests/fixtures/analysis-benchmark-real-${symbol}-4h.json`:`docs/research/jev-expanded-2026-09-22/run/shared-data/${symbol}-${frame}-bars.json`;
const buffer=fs.readFileSync(path.join(root,file));
let rows=JSON.parse(buffer);if(!Array.isArray(rows))throw new Error('Expected row array');
// The benchmark's final candle was still forming at original acquisition.
if(frame==='4h')rows=rows.slice(0,-1);
const cols=Object.fromEntries(['time','open','high','low','close','volume'].map((name,j)=>[name,Float64Array.from(rows,r=>Number(r[j]))]));
const interval=rows[1][0]-rows[0][0];
for(let i=0;i<rows.length;i++){const [t,o,h,l,c,v]=rows[i].map(Number);if(![t,o,h,l,c,v].every(Number.isFinite)||l>Math.min(o,c)||h<Math.max(o,c)||l>h||v<0||i&&t-cols.time[i-1]!==interval)throw new Error(`Bad bar ${i}`);}
const start=250,seen={huzi:new Set(),harmonic:new Set()},signals=[],counts={huzi:0,harmonic:0},delayed={huzi:0,harmonic:0};
const params={pivotStrength:3,lookback:1500,multiScale:true,structuralSwings:true,tolerance:.04,showInvalidated:true,historyDisplay:'all',maxPatterns:1000};
const began=Date.now();
for(let entryIndex=start;entryIndex<rows.length;entryIndex++){
  // Only bars [0,entryIndex) are known. The extra row contains a timestamp and
  // NaN OHLCV, so even accidental reads cannot see the execution candle.
  const offset=Math.max(0,entryIndex-1561),length=entryIndex-offset+1;
  const pcols={};for(const [name,values] of Object.entries(cols)){pcols[name]=new Float64Array(length).fill(NaN);pcols[name].set(values.subarray(offset,entryIndex));}
  pcols.time[length-1]=cols.time[entryIndex];
  const view={length,closedLength:length-1,intervalMs:interval,col:name=>pcols[name]};
  for(const [kind,detect] of [['huzi',detectors.detectHuzi],['harmonic',detectors.detectHarmonics]]){
    const matches=detect(view,params);if(matches.length>=1000)throw new Error('Signal pool cap reached');
    for(const match of matches){
      if(seen[kind].has(match.id))continue;seen[kind].add(match.id);
      if(match.confirmedAt<cols.time[start])continue;
      if(match.confirmedAt>cols.time[entryIndex])throw new Error('Future confirmation');
      counts[kind]++;const delay=Math.round((cols.time[entryIndex]-match.confirmedAt)/interval);if(delay>0)delayed[kind]++;
      signals.push({kind,entryIndex,observedAt:cols.time[entryIndex],delayBars:delay,match});
    }
  }
  if(entryIndex%2500===0)console.log(JSON.stringify({symbol,frame,entryIndex,total:rows.length,signals:signals.length,seconds:Math.round((Date.now()-began)/1000)}));
}
const manifest={symbol,frame,file,sha256:crypto.createHash('sha256').update(buffer).digest('hex'),bars:rows.length,start,end:rows.length-1,from:cols.time[0],to:cols.time.at(-1),interval,params,counts,delayed,durationMs:Date.now()-began};
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,`${symbol}-${frame}-signals.json`),JSON.stringify({manifest,signals}));console.log(JSON.stringify(manifest));
