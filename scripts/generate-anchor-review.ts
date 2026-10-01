/** New out-of-window proposal audit cards. No algorithm changes, network calls,
 * credentials or orders. Run once to freeze: node scripts/generate-anchor-review.ts */
import {build} from 'esbuild';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {createHash} from 'node:crypto';import {resolve} from 'node:path';
const root=process.cwd(),base=resolve('docs/technical-analysis-plan-2026-09-23'),destination=resolve(base,'anchor-review-round2'),mapPath=resolve(base,'anchor-review-round2-held-out.json');
try{await readFile(mapPath);console.log(JSON.stringify({frozen:true,destination,mapPath,message:'Already frozen; no files changed.'}));process.exit(0);}catch{}
const seed=0x73a90421;let state=seed;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};const sha=(value:any)=>createHash('sha256').update(value).digest('hex');
const implementation:Record<string,string>={};async function load(path:string){const out=await build({entryPoints:[path],bundle:true,format:'esm',platform:'node',write:false});implementation[path]=sha(out.outputFiles[0].text);return import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));}
const harmonic=await load('src/lib/patterns/harmonic.ts'),classic=await load('src/lib/patterns/huzi.ts'),candles=await load('src/lib/analysis/candlesticks.ts'),waves=await load('src/lib/analysis/waves.ts');
const old=JSON.parse(await readFile(resolve(base,'acceptance-held-out-predictions.json'),'utf8'));
const exclusions:any[]=[];for(const window of old.windows){const packet=JSON.parse(await readFile(resolve(base,'blind-review',window.id+'.json'),'utf8')),rows=packet.rows,ms=rows[1][0]-rows[0][0];exclusions.push({id:window.id,from:rows[0][0],to:rows.at(-1)[0]+ms});}
exclusions.sort((a,b)=>a.from-b.from);const merged:{from:number;to:number}[]=[];for(const interval of exclusions){const last=merged.at(-1);if(last&&interval.from<=last.to)last.to=Math.max(last.to,interval.to);else merged.push({from:interval.from,to:interval.to});}
const keys=['time','open','high','low','close','volume'];function view(rows:number[][],ms:number){const all=[...rows,[rows.at(-1)![0]+ms,NaN,NaN,NaN,NaN,NaN]],arrays=Object.fromEntries(keys.map((key,i)=>[key,Float64Array.from(all,r=>r[i])]));return {length:all.length,closedLength:rows.length,intervalMs:ms,col:(name:string)=>arrays[name]};}
const classicNames:Record<string,string>={'huzi-head-shoulders':'Head Shoulders','huzi-double':'Double','huzi-triangle':'Triangle','huzi-wedge':'Wedge','huzi-flag':'Flag','huzi-channel':'Channel'};
const allFamilies=['Gartley','Bat','Butterfly','Crab','Deep Crab','Shark','Cypher','AB=CD','Three Drives','Alternate Bat','5-0','Head Shoulders','Double','Triangle','Wedge','Flag','Channel','Pin Bar','Engulfing','Doji','Morning Star','Evening Star','Wolfe geometry','Elliott hard-rule skeleton'];
function proposals(rows:number[][],ms:number){const cols=view(rows,ms),p={lookback:2000,maxPatterns:1000,maxObservations:300,showInvalidated:true,pivotStrength:3,multiScale:true};return [
 ...harmonic.detectHarmonics(cols,p).map((o:any)=>({family:o.family,module:'harmonic',id:o.id,points:o.points,availableAt:o.confirmedAt,state:o.status,direction:o.direction,ruleVersion:o.ruleVersion??'harmonic-shared/1'})),
 ...classic.detectHuzi(cols,p).filter((o:any)=>classicNames[o.family]).map((o:any)=>({family:classicNames[o.family],module:'classic',id:o.id,points:o.points,availableAt:o.confirmedAt,state:o.status,direction:o.direction,ruleVersion:o.ruleVersion??'huzi/unknown'})),
 ...candles.detectCandlesticks(cols,{...p,maxObservations:300,requireTrend:false}).map((o:any)=>({family:['Pin Bar','Engulfing','Doji','Morning Star','Evening Star'].find(f=>o.name.includes(f)),module:'candlestick',id:o.id,points:o.points,availableAt:o.availableAt,state:o.state,direction:o.direction,ruleVersion:o.ruleVersion})),
 ...waves.detectWolfeWaves(cols,p).filter((o:any)=>o.points.length===5).map((o:any)=>({family:'Wolfe geometry',module:'wolfe',id:o.id,points:o.points,availableAt:o.availableAt,state:o.state,direction:o.direction,ruleVersion:o.ruleVersion})),
 ...waves.detectElliottWaves(cols,p).filter((o:any)=>o.ruleVersion==='elliott-impulse/1.0').map((o:any)=>({family:'Elliott hard-rule skeleton',module:'elliott',id:o.id,points:o.points,availableAt:o.availableAt,state:o.state,direction:o.direction,ruleVersion:o.ruleVersion})),
 ];}
const pool:any[]=[],seen=new Set<string>(),sourceVersions:any[]=[];
for(const source of old.sources){
 const bytes=await readFile(resolve(source.path));if(sha(bytes)!==source.sha256)throw Error('Public source changed: '+source.path);const rows=JSON.parse(bytes.toString()).map((r:any)=>r.slice(0,6).map(Number)).slice(0,-1),ms=source.frame==='1m'?60000:source.frame==='5m'?300000:14400000;
 sourceVersions.push({...source,verifiedSha256:sha(bytes)});
 // Exclude any timestamp used in round one, across both symbols AND all frames.
 const segments:{start:number;end:number}[]=[];let start=-1;for(let i=0;i<rows.length;i++){
  const blocked=merged.some(range=>rows[i][0]<range.to&&rows[i][0]+ms>range.from);
  if(!blocked&&start<0)start=i;if((blocked||i===rows.length-1)&&start>=0){const end=blocked?i:i+1;if(end-start>=40)segments.push({start,end});start=-1;}
 }
 for(const segment of segments)for(let scanEnd=Math.min(segment.end,segment.start+1500);;scanEnd=Math.min(segment.end,scanEnd+1200)){
  const scanStart=Math.max(segment.start,scanEnd-2000),subset=rows.slice(scanStart,scanEnd);
  for(const item of proposals(subset,ms)){
   if(!item.family||!item.points.length||item.availableAt>rows[scanEnd-1][0]+ms)continue;
   const key=source.symbol+':'+source.frame+':'+item.id;if(seen.has(key))continue;seen.add(key);
   const firstTime=Math.min(...item.points.map((p:any)=>p.time)),first=rows.findIndex((r:any)=>r[0]===firstTime);let end=rows.findIndex((r:any)=>r[0]>=item.availableAt);if(end<0)end=rows.length;
   if(first<segment.start||end>segment.end||end<=first||end-first>220)continue;
   const cardStart=Math.max(segment.start,Math.min(first-16,end-80));if(end-cardStart<30||end-cardStart>260)continue;
   const data=rows.slice(cardStart,end),anchors=item.points.map((p:any,i:number)=>({label:'A'+i,row:data.findIndex((r:any)=>r[0]===p.time),time:p.time,price:p.value}));
   if(anchors.some((a:any)=>a.row<0))continue;
   pool.push({symbol:source.symbol,frame:source.frame,ms,sourcePath:source.path,sourceSha256:source.sha256,sourceStart:cardStart,sourceEnd:end,rows:data,anchors,expected:item.family,prediction:item,isControl:false,segment});
  }
  if(scanEnd===segment.end)break;
 }
}
for(let i=pool.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
const counts:Record<string,number>={},selected:any[]=[];
function acceptable(candidate:any){return !selected.some(s=>s.symbol===candidate.symbol&&s.frame===candidate.frame&&Math.max(s.sourceStart,candidate.sourceStart)<Math.min(s.sourceEnd,candidate.sourceEnd));}
// Round-robin quotas are fixed without looking at correctness or later returns.
for(let quota=1;quota<=8&&selected.length<40;quota++)for(const family of allFamilies){
 if((counts[family]??0)>=quota)continue;const next=pool.find(p=>p.expected===family&&!selected.includes(p)&&acceptable(p));if(!next)continue;
 selected.push(next);counts[family]=(counts[family]??0)+1;if(selected.length===40)break;
}
// If non-overlapping same-source cards are scarce, retain the honest shortfall.
const controls:any[]=[];const multi=selected.filter(s=>s.anchors.length>=3);
for(let i=0;i<6&&selected.length;i++){
 const source=i%3===0?selected[Math.floor(random()*selected.length)]:multi[Math.floor(random()*multi.length)];if(!source)continue;
 const card={...source,rows:source.rows.map((r:number[])=>r.slice()),anchors:source.anchors.map((a:any)=>({...a})),isControl:true,controlDefect:'',expected:'control-invalid-anchors',prediction:null};
 if(i%3===0){const a=card.anchors.at(-1),span=Math.max(...card.rows.map((r:number[])=>r[2]))-Math.min(...card.rows.map((r:number[])=>r[3]));a.price=card.rows[a.row][2]+Math.max(span*.25,1);card.controlDefect='Anchor price lies outside its source candle range; OHLC itself is unchanged.';}
 else if(i%3===1){card.anchors[2]={...card.anchors[1],label:'A2'};card.controlDefect='Duplicate time/price anchors collapse a required nonzero leg.';}
 else{const a=card.anchors[1],b=card.anchors[2];card.anchors[1]={...b,label:'A1'};card.anchors[2]={...a,label:'A2'};card.controlDefect='Numbered anchor order reverses time; OHLC itself is unchanged.';}
 controls.push(card);
}
const cards=[...selected,...controls];for(let i=cards.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[cards[i],cards[j]]=[cards[j],cards[i]];}
function drawing(card:any,id:string){
 const W=1440,H=720,L=62,R=128,T=45,B=145,rows=card.rows,anchors=card.anchors;
 const low=Math.min(...rows.map((r:number[])=>r[3]),...anchors.map((a:any)=>a.price)),high=Math.max(...rows.map((r:number[])=>r[2]),...anchors.map((a:any)=>a.price)),pad=(high-low)*.08||1;
 const x=(i:number)=>L+(i+.5)*(W-L-R)/rows.length,y=(v:number)=>T+(high+pad-v)/(high-low+2*pad)*(H-T-B),bw=Math.max(1,(W-L-R)/rows.length*.62),maxVol=Math.max(...rows.map((r:number[])=>r[5]));
 let out=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#111820"/><g font-family="Arial,sans-serif" font-size="13" fill="#adbbc8"><text x="18" y="24">${id} · ${card.symbol} · ${card.frame} · neutral anchors / no family or outcome shown</text>`;
 for(let i=0;i<=6;i++){const price=low-pad+(high-low+2*pad)*i/6;out+=`<path d="M${L} ${y(price)}H${W-R}" stroke="#26323d"/><text x="${W-R+8}" y="${y(price)+4}">${price.toFixed(price<10?5:2)}</text>`;}
 rows.forEach((r:number[],i:number)=>{const color=r[4]>=r[1]?'#38b5a3':'#e77679',px=x(i);out+=`<path d="M${px} ${y(r[2])}V${y(r[3])}" stroke="${color}"/><rect x="${px-bw/2}" y="${Math.min(y(r[1]),y(r[4]))}" width="${bw}" height="${Math.max(1,Math.abs(y(r[1])-y(r[4])))}" fill="${color}"/><rect x="${px-bw/2}" y="${H-50-(maxVol?r[5]/maxVol*50:0)}" width="${bw}" height="${maxVol?r[5]/maxVol*50:0}" fill="${color}" opacity=".4"/>`;});
 if(anchors.length>1)out+=`<polyline points="${anchors.map((a:any)=>`${x(a.row)},${y(a.price)}`).join(' ')}" fill="none" stroke="#aeb3ee" stroke-width="1.5" stroke-dasharray="5 3"/>`;
 anchors.forEach((a:any,i:number)=>{const px=x(a.row),py=y(a.price),dy=i%2?-17:21;out+=`<circle cx="${px}" cy="${py}" r="4" fill="#111820" stroke="#ced0ff" stroke-width="2"/><rect x="${Math.max(0,Math.min(W-205,px-80))}" y="${py+dy-13}" width="205" height="18" fill="#1f2940"/><text x="${Math.max(3,Math.min(W-202,px-77))}" y="${py+dy}">${a.label} [${a.row}] ${a.price.toFixed(4)}</text>`;});
 for(let i=0;i<rows.length;i+=Math.max(10,Math.ceil(rows.length/10)))out+=`<text x="${x(i)-8}" y="${H-25}">${i}</text>`;
 return out+`<text x="${L}" y="${H-5}">${new Date(rows[0][0]).toISOString()} → ${new Date(rows.at(-1)[0]).toISOString()} · X=row index · bars stop at card observation time</text></g></svg>`;
}
await mkdir(destination,{recursive:true});const manifest:any[]=[],expected:any[]=[];
for(let i=0;i<cards.length;i++){
 const card=cards[i],id=`anchor-${String(i+1).padStart(2,'0')}`,payload={id,symbol:card.symbol,frame:card.frame,columns:keys,rows:card.rows,anchors:card.anchors,groundTruth:'unreviewed',instructions:'Classify only the numbered anchors and their source candles; neutral names are not a family claim. No later outcome data are included.'};
 await writeFile(resolve(destination,id+'.json'),JSON.stringify(payload));await writeFile(resolve(destination,id+'.svg'),drawing(card,id));
 manifest.push({id,symbol:card.symbol,frame:card.frame,rows:card.rows.length,anchors:card.anchors.length,data:id+'.json',chart:id+'.svg'});
 expected.push({id,isControl:card.isControl,controlDefect:card.controlDefect??null,expectedFamily:card.expected,sourcePath:card.sourcePath,sourceSha256:card.sourceSha256,sourceStart:card.sourceStart,sourceEnd:card.sourceEnd,intervalSha256:sha(JSON.stringify(card.rows)),anchors:card.anchors,from:card.rows[0][0],through:card.rows.at(-1)[0]+card.ms,prediction:card.prediction});
}
const available=Object.fromEntries(allFamilies.map(f=>[f,pool.filter(p=>p.expected===f).length])),strata=Object.fromEntries(allFamilies.map(f=>[f,{available:available[f],selected:counts[f]??0,shortage:(counts[f]??0)<2?'Fewer than two selected genuine proposals; no synthetic real samples substituted.':null}]));
const overlapCheck=expected.filter(c=>!c.isControl).every(card=>merged.every(range=>card.from>=range.to||card.through<=range.from));if(!overlapCheck)throw Error('Forbidden round-one timestamp overlap');
const freeze={version:'anchor-proposal-review/2',createdAt:new Date().toISOString(),seed,realCount:selected.length,controlCount:controls.length,implementation,sourceVersions,exclusions,exclusionPolicy:'No timestamps overlap ANY original round-one window across either symbol or any timeframe. New genuine cards additionally do not overlap within the same symbol/timeframe.',overlapCheck,strata,cards:expected};
await writeFile(mapPath,JSON.stringify(freeze,null,2));await writeFile(resolve(destination,'manifest.json'),JSON.stringify({version:'neutral-anchor-cards/2',seed,groundTruth:'unknown until independent review',cards:manifest},null,2));
await writeFile(resolve(destination,'REVIEW-INSTRUCTIONS.md'),`# 独立锚点核验（盲审）\n\n仅查看本目录的 manifest / OHLC JSON / SVG。不打开其他目录、生产检测器或 held-out 映射。卡片已随机打乱，A0/A1…不透露算法名称、分类、置信或后续盈亏。请核验编号锚点，不把图中另一个位置的形态当作命中。部分卡可能包含刻意破坏的锚点；控制身份由协调者单独保管，不能按“算法既然画出来就应成立”推断。\n\n每卡检查：1. 价格/时间是否来自对应源柱，是否为该位置真实的极值或适合的收盘锚；2. 点序、局部几何与时间关系；3. 谐波必须计算实际比例，不凭W/M轮廓；4. 不足以证实时选 uncertain，明显不满足任何候选族时选 none；5. 仅用出现到最后已闭柱的信息，不能评价以后盈亏。\n\n允许分类：${allFamilies.join('、')}、none、uncertain。Elliott hard-rule skeleton 只核验普通五浪骨架的硬规则，不冒称内部5-3细分完整。Wolfe geometry 只核验五点收敛/超越/1-4投射的公开几何，不声称完整课程。K线类应说明符合的是哪些编号柱，吞没/晨暮星可核对其相邻原始柱。\n\n输出JSON：{reviewer:{id,type:'independent_ai',humanGoldStandard:false},methodology:{...},cards:[{id,verdict:'accept'|'reject'|'uncertain',family:'…或none或uncertain',anchorIntegrity:'correct'|'incorrect'|'uncertain',anchorRows:[...],measuredRatios:{...},rationale:'说明硬证据与不满足项',confidence:0..1}]}。允许记录多个合格类别 compatibleFamilies，但不要为了猜测隐藏输出而强选。没有稳定真值时应弃权。总体市场准确率不能从这个有限proposal抽样推断。\n`);
await writeFile(resolve(destination,'index.html'),`<!doctype html><meta charset="utf-8"><title>Neutral anchor review</title><style>body{background:#10171e;color:#d7e0e8;font:14px Arial;margin:20px}img{width:100%;max-width:1440px;border:1px solid #304151}section{margin-bottom:36px}a{color:#a9cae8}</style><h1>Neutral anchor audit cards</h1><p>Review numbered anchors only. Family and subsequent outcomes are withheld.</p>${manifest.map(c=>`<section><h2>${c.id} · ${c.symbol} ${c.frame}</h2><a href="${c.data}">OHLC + neutral anchors JSON</a><br><img src="${c.chart}" alt="Neutral anchors ${c.id}"></section>`).join('')}`);
console.log(JSON.stringify({destination,mapPath,real:selected.length,controls:controls.length,pool:pool.length,overlapCheck,strata}));
