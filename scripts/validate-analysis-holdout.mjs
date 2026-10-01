import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
globalThis.crypto??=webcrypto;
const bundle=await build({entryPoints:['src/lib/analysis/validation.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {runAnalysisValidation}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const folder='docs/technical-analysis-plan-2026-09-23/validation-runs';await mkdir(folder,{recursive:true});
for(const [symbol,interval] of [['BTCUSDT','1m'],['ETHUSDT','5m']]){
  const rows=JSON.parse(await readFile(`docs/research/jev-expanded-2026-09-22/run/shared-data/${symbol}-${interval}-bars.json`,'utf8')).slice(-2501,-1);
  const dataset={source:'binance',symbol,interval,marketType:'usdm-perpetual',quoteCurrency:'USDT',bars:rows.map(r=>({time:+r[0],open:+r[1],high:+r[2],low:+r[3],close:+r[4],volume:+r[5]}))};
  const rates=JSON.parse(await readFile(`docs/research/jev-expanded-2026-09-22/run/shared-data/${symbol}-funding.json`,'utf8'))
    .map(point=>({time:+point.fundingTime,rate:+point.fundingRate,markPrice:+point.markPrice}));
  const request={dataset,closedLength:dataset.bars.length,studies:[{id:'analysis-candles'},{id:'analysis-order-blocks'},{id:'analysis-wyckoff'}],prefixProbes:16,maxHoldoutBars:128,holdoutFraction:.3,
    research:{initialCapital:10000,notional:1000,feeBps:5,slippageBps:1,stopAtr:1.5,takeAtr:2,maxHoldBars:24,responseBars:8},maxDurationMs:180000,
    // The cache itself has no fetch-coverage manifest. Do not pretend coverage
    // extends beyond its last observed funding timestamp.
    funding:{from:rates[0].time,to:rates.at(-1).time,rates}};
  const report=await runAnalysisValidation(request,{yieldControl:()=>Promise.resolve()});
  const file=`${folder}/${symbol}-${interval}-closed-holdout.json`;await writeFile(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({file,causality:report.causality.status,probes:report.causality.probes,signals:report.responses.signals,responses:report.responses.evaluated,responseRate:report.responses.positiveRate,
    trades:report.research.trades.length,net:report.research.net,conclusion:report.research.conclusion,funding:report.research.fundingBasis,durationMs:report.durationMs}));
}
