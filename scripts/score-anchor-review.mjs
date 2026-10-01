import fs from 'node:fs';
import crypto from 'node:crypto';
const root='docs/technical-analysis-plan-2026-09-23/';
const heldPath=root+'anchor-review-round2-held-out.json';
const reviewPath=process.argv[2]??root+'anchor-review-round2/reviewer-independent.json';
const frozen=JSON.parse(fs.readFileSync(heldPath,'utf8'));
const review=JSON.parse(fs.readFileSync(reviewPath,'utf8'));
const hash=path=>crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
if(review.reviewer?.type!=='independent_ai'||review.reviewer?.humanGoldStandard!==false)throw Error('Review provenance must be explicit');
const lookup=new Map(review.cards.map(card=>[card.id,card]));
if(lookup.size!==frozen.cards.length||review.cards.length!==lookup.size)throw Error('Missing/duplicate review cards');
const rows=frozen.cards.map(card=>{
  const r=lookup.get(card.id);if(!r||!['accept','reject','uncertain'].includes(r.verdict))throw Error(`Invalid ${card.id}`);
  const compatible=[r.family,...(r.compatibleFamilies??[])];
  const match=r.verdict==='accept'&&r.anchorIntegrity==='correct'&&compatible.includes(card.expectedFamily);
  const state=r.verdict==='uncertain'||r.anchorIntegrity==='uncertain'?'uncertain':match?'accepted':'rejected';
  return {id:card.id,control:card.isControl,expectedFamily:card.expectedFamily,reviewFamily:r.family,state,verdict:r.verdict,anchorIntegrity:r.anchorIntegrity,
    availableAt:card.prediction?.availableAt,lastAnchorTime:Math.max(...card.anchors.map(a=>a.time)),
    delayMs:card.prediction?.availableAt-Math.max(...card.anchors.map(a=>a.time)),rationale:r.rationale};
});
function counts(data){const accepted=data.filter(r=>r.state==='accepted').length,rejected=data.filter(r=>r.state==='rejected').length,uncertain=data.length-accepted-rejected;return {total:data.length,accepted,rejected,uncertain,adjudicated:accepted+rejected,reviewCoverage:data.length?(accepted+rejected)/data.length:null,adjudicatedAgreement:accepted+rejected?accepted/(accepted+rejected):null,acceptedShareOfAll:data.length?accepted/data.length:null};}
const actual=rows.filter(r=>!r.control),controls=rows.filter(r=>r.control);
const summary={version:'anchor-review-score/1',createdAt:new Date().toISOString(),reviewer:review.reviewer,source:{heldPath,heldSha256:hash(heldPath),reviewPath,reviewSha256:hash(reviewPath)},
  method:'Frozen unseen proposal sample. Match requires accept, correct source anchors and the exact predicted family among independently compatible families. Uncertain is disclosed, never converted to a pass. Controls excluded from market denominator.',
  limits:['Independent AI review, not a human gold standard.','Stratified emitted proposals cannot estimate market-wide recall or true-negative false-positive rate.','Family counts are small and sampling is enriched; aggregate agreement is not a population accuracy estimate.','A geometrically valid pattern does not imply profitable trades.'],
  actual:counts(actual),families:Object.fromEntries([...new Set(actual.map(r=>r.expectedFamily))].sort().map(f=>[f,counts(actual.filter(r=>r.expectedFamily===f))])),
  controls:{total:controls.length,rejected:controls.filter(r=>r.verdict==='reject'||r.anchorIntegrity==='incorrect').length,uncertain:controls.filter(r=>r.verdict==='uncertain'||r.anchorIntegrity==='uncertain').length,accepted:controls.filter(r=>r.verdict==='accept'&&r.anchorIntegrity==='correct').length},
  overallMarketPrecision:null,overallMarketRecall:null,rows};
fs.writeFileSync(root+'anchor-review-round2-score.json',JSON.stringify(summary,null,2)+'\n');
const percentage=n=>n===null?'—':(n*100).toFixed(1)+'%';
const md=['# 第二轮真实锚点独立盲审','',`40 张真实提议、6 张控制卡；冻结样本与第一轮时间区间完全分离。审阅者：${review.reviewer.id}（独立 AI，非真人金标准）。`,'',
  `真实提议：接受 ${summary.actual.accepted}，拒绝/族不匹配 ${summary.actual.rejected}，不确定 ${summary.actual.uncertain}。已判定样本一致比例 ${percentage(summary.actual.adjudicatedAgreement)}；全部真实提议接受占比 ${percentage(summary.actual.acceptedShareOfAll)}。`,
  '', '这是有限分层提议抽样的审核结果，不能命名为总体市场准确率；没有用未标注窗口推算召回率或误报率。', '', '| 家族 | 真实提议 | 接受 | 拒绝/不匹配 | 不确定 |', '| --- | ---: | ---: | ---: | ---: |',
  ...Object.entries(summary.families).map(([f,c])=>`| ${f} | ${c.total} | ${c.accepted} | ${c.rejected} | ${c.uncertain} |`), '',
  `控制卡：拒绝 ${summary.controls.rejected}，不确定 ${summary.controls.uncertain}，接受 ${summary.controls.accepted}；与真实分母分开。`, '', '## 分歧记录','',
  ...actual.filter(r=>r.state!=='accepted').map(r=>`- **${r.id} / ${r.expectedFamily}**：${r.state}。${r.rationale}`), '',
  '原始独立判定、输入 SHA、规则版本、每卡实际锚点及确认延迟均在相邻 JSON。不得因看到此结果而改动冻结样本或独立标签。', ''].join('\n');
fs.writeFileSync(root+'anchor-review-round2-score.md',md);
console.log(JSON.stringify({actual:summary.actual,controls:summary.controls,families:summary.families},null,2));
