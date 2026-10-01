import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const OUT=path.join(ROOT,'docs/research/pattern-audit-2026-09-27/run');
const legacySource=fs.readFileSync(path.join(OUT,'confluence-v1-source.txt'),'utf8')+'\nexport {buildCausalSeries as buildConfluenceSeries,evaluatePatternConfluence};';
const legacyBuild=await build({stdin:{contents:legacySource,loader:'ts',resolveDir:path.join(ROOT,'src/lib/patterns')},bundle:true,platform:'node',format:'esm',write:false});
export const legacy=await import('data:text/javascript;base64,'+Buffer.from(legacyBuild.outputFiles[0].text).toString('base64'));
const correctedBuild=await build({entryPoints:[path.join(ROOT,'src/lib/patterns/confluence.ts')],bundle:true,platform:'node',format:'esm',write:false});
export const corrected=await import('data:text/javascript;base64,'+Buffer.from(correctedBuild.outputFiles[0].text).toString('base64'));
export const defaultOptions={minVolumeRatio:1.2,minRiskReward:.45,emaPeriod:50,rsiDivergenceMin:1,requireDualDivergence:true};
export const baseMethods=[{id:'huzi',kind:'huzi'},{id:'harmonic',kind:'harmonic'},{id:'hscp-v1',version:1},{id:'hscp-v2',version:2},{id:'v2-no-volume',version:2,minVolumeRatio:0},{id:'v2-no-rr',version:2,minRiskReward:0},{id:'v2-single-divergence',version:2,requireDualDivergence:false},{id:'v2-continuation',version:2,branch:'顺势收敛突破'},{id:'v2-reversal',version:2,branch:'双背离极值反转'},{id:'v1-rules-v2-series',version:1,seriesVersion:2},{id:'v2-rules-v1-series',version:2,seriesVersion:1}];
export const candidates=[];
for(const volume of [1.2,1.5])for(const rr of [.45,.75,1])for(const rewardBps of [0,12,24])candidates.push({id:`candidate-v${volume}-r${rr}-b${rewardBps}`,version:2,minVolumeRatio:volume,minRiskReward:rr,minRewardBps:rewardBps});
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function loadFunding(symbol,frame,rows,manifest){
  const file=frame==='4h'?path.join(OUT,`${symbol}-long-funding.json`):path.join(ROOT,`docs/research/jev-expanded-2026-09-22/run/shared-data/${symbol}-funding.json`);
  if(!fs.existsSync(file))return {funding:[],fundingSource:{file:path.relative(ROOT,file),covered:false,reason:'missing-file'}};
  const bytes=fs.readFileSync(file),funding=JSON.parse(bytes),hash=sha256(bytes);
  if(!Array.isArray(funding)||!funding.length)throw new Error(`Empty or invalid funding: ${symbol}/${frame}`);
  for(let i=0;i<funding.length;i++){
    const f=funding[i];
    if(f.symbol!==symbol||![+f.fundingTime,+f.fundingRate,+f.markPrice].every(Number.isFinite)||+f.markPrice<=0||i&&+f.fundingTime<=+funding[i-1].fundingTime)
      throw new Error(`Invalid/duplicate/unsorted funding: ${symbol}/${frame}`);
  }
  const metadataFile=frame==='4h'?path.join(OUT,`${symbol}-long-funding-manifest.json`):path.join(ROOT,'docs/research/jev-expanded-2026-09-22/run/manifest.json');
  const metadataBytes=fs.readFileSync(metadataFile),metadata=JSON.parse(metadataBytes);
  if(frame==='4h'&&(metadata.sha256!==hash||metadata.symbol!==symbol||metadata.events!==funding.length||metadata.responseExhausted!==true))
    throw new Error(`Long funding snapshot differs from acquisition manifest: ${symbol}`);
  const from=frame==='4h'?metadata.requestedFrom:Date.parse(metadata.data_start),
    toExclusive=frame==='4h'?metadata.requestedToExclusive:Date.parse(metadata.data_end);
  if(!Number.isFinite(from)||!Number.isFinite(toExclusive)||funding.some(f=>+f.fundingTime<from||+f.fundingTime>=toExclusive))
    throw new Error(`Funding coverage metadata does not describe its events: ${symbol}/${frame}`);
  return {funding,fundingSource:{file:path.relative(ROOT,file),sha256:hash,events:funding.length,
    manifestFile:path.relative(ROOT,metadataFile),manifestSha256:sha256(metadataBytes),from,toExclusive,
    covered:from<=rows[manifest.start][0]&&toExclusive>=rows.at(-1)[0]+manifest.interval,
    coverageBasis:'bounded public REST acquisition manifest; event integrity checked'}};
}
export function readDataset(symbol,frame){
  const ledgerBytes=fs.readFileSync(path.join(OUT,`${symbol}-${frame}-signals.json`)),{manifest,signals}=JSON.parse(ledgerBytes);
  const sourceBytes=fs.readFileSync(path.join(ROOT,manifest.file));
  if(sha256(sourceBytes)!==manifest.sha256||manifest.symbol!==symbol||manifest.frame!==frame)
    throw new Error(`OHLCV source differs from frozen signal ledger: ${symbol}/${frame}`);
  let rows=JSON.parse(sourceBytes).map(r=>r.slice(0,6).map(Number));if(frame==='4h')rows=rows.slice(0,-1);
  if(rows.length!==manifest.bars||rows[0][0]!==manifest.from||rows.at(-1)[0]!==manifest.to)
    throw new Error(`OHLCV range differs from frozen signal ledger: ${symbol}/${frame}`);
  manifest.signalLedgerSha256=sha256(ledgerBytes);
  const cols=Object.fromEntries(['time','open','high','low','close','volume'].map((name,j)=>[name,Float64Array.from([...rows,[rows.at(-1)[0]+manifest.interval,NaN,NaN,NaN,NaN,NaN]],r=>r[j])]));
  const view={length:rows.length+1,closedLength:rows.length,intervalMs:manifest.interval,col:name=>cols[name]};
  // These recurrences use only current/past observations. Per-signal closedCount
  // below prevents future bars from entering an evaluation.
  const v1=legacy.buildConfluenceSeries(view,50),v2=corrected.buildConfluenceSeries(view,50,{requireContinuousTime:true});
  const v2WithLegacyIndicators={...v2};
  for(const k of ['rsi','macd','signal','hist','emaTrend'])
    v2WithLegacyIndicators[k]=Float64Array.from(v1[k],(v,j)=>Number.isFinite(v2[k][j])?v:NaN);
  const {funding,fundingSource}=loadFunding(symbol,frame,rows,manifest);
  const diagnostics={signals:signals.length,late:0,expiredT1:0,expiredT2:0,invalidRisk:0,volumeBypass:0,legacyPass:0,correctedPass:0,
    freshSignals:0,freshLegacyPass:0,freshCorrectedPass:0,freshVolumeBypass:0,
    allCountsBasis:'All-signal counts include delayed first sightings; observations and original confirmation can differ. Use fresh-only counts for executable gate pass rates and volume-bypass claims.',byKind:{}};
  for(const s of signals){
    const {match:m,entryIndex:i}=s,sign=m.direction==='bullish'?1:-1,price=rows[i-1][4];
    s.common={riskFraction:sign*(price-m.invalidation)/price,rewardFraction:sign*(m.targets[0]-price)/price,t2Fraction:sign*((m.targets[1]??price+(m.targets[0]-price)*1.618)-price)/price,volRatio:v1.vol[i-1]/v1.volSma20[i-1]};
    s.evals={};const limited={...view,length:i+1,closedLength:i};
    for(const method of [...baseMethods,...candidates]){
      if(method.kind)continue;
      const options={...defaultOptions,...method};
      let series=method.version===1?v1:v2;
      if(method.seriesVersion===2)series=v2;
      if(method.seriesVersion===1)series=v2WithLegacyIndicators;
      const result=(method.version===1?legacy:corrected).evaluatePatternConfluence(m,limited,{...series,closedCount:i},options);
      s.evals[method.id]=result&&(!method.branch||method.branch===result.branch)&&s.common.rewardFraction*10000>=(method.minRewardBps??0)?result:null;
    }
    diagnostics.byKind[s.kind]??={signals:0,late:0,expiredT1:0,invalidRisk:0,fresh:0,freshExpiredT1:0};const kd=diagnostics.byKind[s.kind];kd.signals++;
    if(s.delayBars){diagnostics.late++;kd.late++;}
    if(s.common.rewardFraction<=0){diagnostics.expiredT1++;kd.expiredT1++;}
    if(s.common.t2Fraction<=0)diagnostics.expiredT2++;
    if(s.common.riskFraction<=0){diagnostics.invalidRisk++;kd.invalidRisk++;}
    if(s.evals['hscp-v1']){diagnostics.legacyPass++;if(s.common.volRatio<1.2)diagnostics.volumeBypass++;}
    if(s.evals['hscp-v2'])diagnostics.correctedPass++;
    if(s.delayBars===0){
      diagnostics.freshSignals++;kd.fresh++;
      if(s.common.rewardFraction<=0)kd.freshExpiredT1++;
      if(s.evals['hscp-v1']){diagnostics.freshLegacyPass++;if(s.common.volRatio<1.2)diagnostics.freshVolumeBypass++;}
      if(s.evals['hscp-v2'])diagnostics.freshCorrectedPass++;
    }
  }
  return {symbol,frame,manifest,rows,signals,funding,fundingSource,diagnostics};
}
export function tradingSignal(s,method){
  if(s.delayBars>0)return null;
  const m=s.match;
  if(m.invalidatedAt!==undefined&&m.invalidatedAt<=s.observedAt)return null;
  if(method.kind&&method.kind!==s.kind)return null;
  const result=method.kind?null:s.evals[method.id];if(!method.kind&&!result)return null;
  return {id:m.id,entryIndex:s.entryIndex,direction:m.direction,stop:m.invalidation,t1:result?.t1??m.targets[0],t2:result?.t2??m.targets[1],kind:s.kind,family:m.family,branch:result?.branch};
}
