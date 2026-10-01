"""Render the completed experiment. This file never calls an inference API."""
from __future__ import annotations

import base64
from collections import Counter
from datetime import datetime, timezone, timedelta
import html
import json
from pathlib import Path
import random
import statistics

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

from jev_eval import DEFAULT_OUT, SEED, read_json, write_json, iso
from jev_backtest import simulate, trading_metrics

OUT=DEFAULT_OUT
REPORT=OUT.parent
CN=timezone(timedelta(hours=8))
LABELS={'Jev + selected exit':'Jev：筛选 + 自选出场','Jev + fixed B':'Jev：筛选 + 固定 B','Always buy + fixed B':'每次买入 + 固定 B',
        'EMA10 > SMA60 + fixed B':'EMA10 > SMA60 + 固定 B','Always buy + selected exit':'强制每次买入 + Jev 出场','Always wait':'始终观望',
        'Jev + target-first sensitivity':'Jev：同柱先止盈敏感性'}

def f(value,digits=2):return '—' if value is None else f'{value:,.{digits}f}'
def pct(value):return '—' if value is None else f'{value*100:.1f}%'
def local_time(value):return datetime.fromtimestamp(value/1000,CN).strftime('%m-%d %H:%M')
def e(value):return html.escape(str(value))


def supplemental(summary,rows,cases):
    valid=[r for r in rows if r['actual_profitable'] is not None]
    positive=[r for r in valid if r['actual_profitable']];negative=[r for r in valid if not r['actual_profitable']]
    auc=sum((a['p_profitable']>b['p_profitable'])+.5*(a['p_profitable']==b['p_profitable']) for a in positive for b in negative)/(len(positive)*len(negative)) if positive and negative else None
    common=[r for r in rows if r['chosen']['valid'] and r['reference']['valid']]
    differences=[r['chosen']['net_pnl']-r['reference']['net_pnl'] for r in common]
    rng=random.Random(SEED)
    samples=sorted(sum(rng.choices(differences,k=len(differences))) for _ in range(10000)) if differences else []
    attempts=[json.loads(line) for line in (OUT/'api-attempts.jsonl').read_text().splitlines()]
    total_latency=[]
    for row in rows:
        matching=[a for a in attempts if a['case_id']==row['case_id']]
        first=datetime.fromisoformat(matching[0]['started_at'].replace('Z','+00:00')).timestamp()
        last=datetime.fromisoformat(matching[-1]['started_at'].replace('Z','+00:00')).timestamp()+matching[-1]['latency_seconds']
        total_latency.append(last-first)
    result={'note':'Supplementary descriptive diagnostics, computed after main scoring; no new model calls and no retuned thresholds.',
        'probability_auc':auc,'probability_min':min(r['p_profitable'] for r in rows),'probability_max':max(r['p_profitable'] for r in rows),
        'choice_counts':dict(Counter(r['exit_plan'] for r in rows)),
        'paired_exit_comparison':{'n':len(common),'selected_net':sum(r['chosen']['net_pnl'] for r in common),'reference_b_net':sum(r['reference']['net_pnl'] for r in common),
            'difference':sum(differences),'bootstrap_sum95':[samples[249],samples[9749]] if samples else None,'bootstrap_caveat':'IID resampling is descriptive only; market windows can be correlated.'},
        'exploratory_fixed_plans':{plan:trading_metrics([simulate(case,plan) for case in cases]) for plan in ('A','B','C','D')},
        'api_attempts':len(attempts),'api_failures':sum(a['status']!=200 for a in attempts),'end_to_end_latency_median':statistics.median(total_latency),
        'end_to_end_latency_max':max(total_latency)}
    write_json(OUT/'supplemental.json',result)
    return result


def plots(summary,rows,extra):
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False,'figure.facecolor':'#f8fafc','axes.facecolor':'#f8fafc'})
    figure,axes=plt.subplots(2,2,figsize=(13,8),layout='constrained')
    ax=axes[0,0];c=summary['classification']['jev']
    matrix=[[c['tp'],c['fp']],[c['fn'],c['tn']]]
    ax.imshow(matrix,cmap='Blues',vmin=0,vmax=max(max(row) for row in matrix))
    for i in range(2):
        for j in range(2):ax.text(j,i,str(matrix[i][j]),ha='center',va='center',fontsize=27,color='white' if matrix[i][j]>20 else '#0f172a')
    ax.set_xticks([0,1],['Reference profitable','Reference unprofitable']);ax.set_yticks([0,1],['Jev BUY','Jev WAIT'])
    ax.set_title('38 executable reference cases · 2 gap-invalid cases excluded',loc='left',fontsize=11,pad=12)
    ax=axes[0,1]
    keys=['Jev + selected exit','Always wait','EMA10 > SMA60 + fixed B','Always buy + selected exit','Always buy + fixed B']
    names=['Jev (0 entries)','Always wait','EMA gate / fixed B','Forced entry / Jev exits','Always buy / fixed B']
    pnls=[summary['strategies'][key]['net_pnl'] for key in keys]
    ax.barh(names,pnls,color=['#475569','#94a3b8','#ca8a04','#4f46e5','#dc2626'],height=.6);ax.invert_yaxis();ax.axvline(0,color='#64748b',linewidth=.7)
    for i,v in enumerate(pnls):ax.text(v-1,i,f'{v:.2f}',va='center',ha='right',fontsize=9)
    ax.set_xlim(min(pnls)-21,8);ax.set_title('Net P&L · 1,000 USDT notional per trade',loc='left',fontsize=11,pad=12);ax.set_xlabel('USDT, after costs and funding')
    ax=axes[1,0]
    first=datetime.fromtimestamp(min(r['decision_time'] for r in rows)/1000,timezone.utc)
    last=datetime.fromtimestamp(max(r['decision_time'] for r in rows)/1000,timezone.utc)+timedelta(hours=4)
    for key,label,color in [('Always buy + fixed B','Always buy / B','#dc2626'),('EMA10 > SMA60 + fixed B','EMA gate / B','#ca8a04'),('Always buy + selected exit','Forced entry / Jev exits','#4f46e5')]:
        curve=summary['strategies'][key]['curve'];xs=[first]+[datetime.fromtimestamp(p['time']/1000,timezone.utc) for p in curve];ys=[0]+[p['equity']-10000 for p in curve]
        ax.step(xs,ys,where='post',label=label,color=color,linewidth=1.6)
    ax.plot([first,last],[0,0],color='#475569',label='Jev = cash',linewidth=1.5)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%m-%d'));ax.set_ylabel('Cumulative realized P&L (USDT)');ax.set_title('Sampled trades only · not continuous intrabar equity',loc='left',fontsize=11,pad=12);ax.legend(fontsize=8,loc='lower left');ax.grid(alpha=.17)
    ax=axes[1,1];rng=random.Random(SEED)
    for actual,color,label in [(False,'#dc2626','Unprofitable'),(True,'#059669','Profitable')]:
        selected=[r for r in rows if r['actual_profitable'] is actual]
        ax.scatter([r['p_profitable'] for r in selected],[int(actual)+rng.uniform(-.08,.08) for _ in selected],s=34,color=color,alpha=.7,label=label)
    ax.set_xlim(0,1);ax.set_ylim(-.2,1.2);ax.set_yticks([0,1]);ax.set_xlabel('Jev Noul probability');ax.set_ylabel('Realized reference outcome');ax.grid(alpha=.17)
    ax.set_title(f"Probability ranking AUC {extra['probability_auc']:.4f} · chance level 0.5",loc='left',fontsize=11,pad=12)
    figure.savefig(REPORT/'results.png',dpi=160);plt.close(figure)


def build_report(summary,rows,extra,manifest):
    if len(rows)!=40 or any(r['buy'] for r in rows):
        raise RuntimeError('This narrative describes the frozen 40-WAIT pilot only; write a new narrative for a different experiment.')
    c=summary['classification']['jev'];ci=c['accuracy_wilson95'];main=summary['strategies']['Jev + selected exit'];paired=extra['paired_exit_comparison']
    table='\n'.join(f"| {LABELS[key]} | {m['trades']} | {pct(m['win_rate'])} | {f(m['net_pnl'])} | {f(m['fees'])} | {f(m['closed_trade_drawdown'])} |" for key,m in summary['strategies'].items() if key!='Jev + target-first sensitivity')
    grouped='\n'.join(f"| {g['symbol']} | {g['interval']} | {g['window']} | {g['classification']['n']} | {pct(g['classification']['accuracy'])} | {g['classification']['fn']} |" for g in summary['cells'])
    md=f'''# Jev 纯 K 线判断实验：40 次实测

**结论：在本次预先固定的 OHLCV 配置下，没有观察到可用的买入择时能力，不建议据此接入自动买入。**

Jev 的 40 次有效回答全部为 WAIT。38 个可执行参考样本中，30 个亏损、8 个盈利；2 个因延迟后的入场价已越过原候选止盈/止损范围而单列排除。表面准确率 **{pct(c['accuracy'])}（30/38）** 完全等于“永远观望”基线。买入覆盖率 0%，盈利机会召回率 0%，balanced accuracy 50%。买入胜率无定义，不能写成 100%。

## 实验与限制

- 40 次判断：BTC、ETH USDT 永续，5m/15m，60/120 根窗口，每组 5 个时点。决策区间为北京时间 {local_time(min(r['decision_time'] for r in rows))} 至 {local_time(max(r['decision_time'] for r in rows))}。
- 模型只收到过去 OHLCV、周期、费用和预先计算的候选价位，没有日期、品种名或未来 K 线。提示词和样本在推理前固定，结果出来后没有调整。
- 实际模型：`{', '.join(summary['model_versions'])}`。40 次成功请求，{extra['api_attempts']} 次 HTTP 尝试，{extra['api_failures']} 次网络失败后重试；没有换模型，也没有挑选重试结果。
- 出场选择为 A/B/C/D：分别是止盈 1/2/3/4 ATR，止损 1/1/1.5/2 ATR。候选绝对价格由代码在决策前计算，Jev 从中选择，未让它自由生成精确价格。
- 延迟一根完整目标周期柱后，在第二根未来柱开盘入场；最多持有 12 根。每次 1,000 USDT 名义金额，初始 10,000 USDT，1 倍，不复投。单边 5bp 手续费、1bp 不利滑点，另计历史资金费。
- 这是 40 个抽样决策的研究回放，不是持续覆盖全部 K 线的策略回测。曲线回撤是已平仓账本回撤，没有冒充完整盘中回撤。

## 买入判断

| 指标 | 结果 |
| --- | --- |
| 有效模型回答 | 40 / 40 |
| BUY / WAIT | 0 / 40 |
| 可评分参考样本 | 38（另有 2 个跳空后不可执行） |
| 主准确率 | {pct(c['accuracy'])}（Wilson 95% 区间 {pct(ci[0])}–{pct(ci[1])}；样本相关性未校正） |
| 永远 WAIT 准确率 | {pct(summary['classification']['always_wait']['accuracy'])} |
| 盈利机会召回率 | 0 / 8 = 0% |
| Balanced accuracy | 50% |
| 预测盈利概率范围 | {pct(extra['probability_min'])}–{pct(extra['probability_max'])} |
| 概率 Brier score | {f(summary['brier_score'],4)}，越低越好 |
| 概率排序 AUC（补充诊断） | {f(extra['probability_auc'],4)}，接近随机排序的 0.5 |

观望并不一定是错误，本批数据确实多数费后亏损。但它也漏掉了全部 8 个盈利参考窗口，因此高准确率不能解释成择时能力。全样本都观望也可能受提示措辞、成本、持仓上限和数值理解能力影响；本实验不把结论推广到所有提示词、资产或行情。

## 交易结果

| 方法 | 实际交易数 | 交易胜率 | 净盈亏 USDT | 手续费 USDT | 已平仓回撤 USDT |
| --- | ---: | ---: | ---: | ---: | ---: |
{table}

“强制每次买入 + Jev 出场”是反事实出场诊断，**不是模型实际下单策略**。它用模型选出的价位回放了 37 笔可执行交易，净亏 {f(-summary['strategies']['Always buy + selected exit']['net_pnl'])} USDT。Jev 出场选择为 {extra['choice_counts']}。

为避免 37 笔与 38 笔直接比较造成偏差，只比较共同可执行的 {paired['n']} 个样本：Jev 出场 {f(paired['selected_net'])} USDT，固定 B {f(paired['reference_b_net'])} USDT，差值 {f(paired['difference'])} USDT。这表现为少亏，尚不是盈利优势。配对重采样的差值区间 {f(paired['bootstrap_sum95'][0])}–{f(paired['bootstrap_sum95'][1])} USDT 仅是补充描述，不能忽略行情样本的相关性。

## 周期与窗口

| 品种 | 周期 | 输入窗口 | 可评分数 | 准确率 | 错过的盈利窗口 |
| --- | --- | ---: | ---: | ---: | ---: |
{grouped}

所有分组的 BUY 数都为 0，所以这里的分组准确率主要反映各组亏损参考样本的占比，不能用它选“最适合 Jev 的周期”。每组仅 5 次判断。

## 成本与可复核资料

实际输入 {summary['input_tokens']:,} token，已返回用量合计 **${summary['api_cost_usd']:.8f}**。成功单次请求延迟中位数 {summary['latency_median_seconds']:.2f}s，P95 {summary['latency_p95_seconds']:.2f}s；含失败重试的单样本最长用时 {extra['end_to_end_latency_max']:.2f}s。

下一步如果继续研究，应另立样本外实验，比较更明确的任务表述、更长周期或经过代码计算的结构特征。本轮不继续改阈值寻找好看的结果，也不把回测结果接入下单逻辑。

- [预先固定协议](protocol.md)
- [逐样本明细 CSV](run/cases.csv)：`model_net_pnl` 是实际模型策略盈亏；`selected_plan_if_buy_pnl` / `reference_if_buy_pnl` 是假设买入的反事实结果。
- [完整结果 JSON](run/summary.json)
- [冻结样本与校验值](run/manifest.json)
- [原始回答目录](run/responses/)
- [补充诊断](run/supplemental.json)

![统计与模拟交易曲线](results.png)
'''
    (REPORT/'report.md').write_text(md)
    summary_rows=''.join(f'<tr><td>{e(LABELS[key])}</td><td>{m["trades"]}</td><td>{pct(m["win_rate"])}</td><td class="num {"loss" if m["net_pnl"]<0 else ""}">{f(m["net_pnl"])}</td><td>{f(m["fees"])}</td><td>{f(m["funding_cost"],4)}</td></tr>' for key,m in summary['strategies'].items() if key!='Jev + target-first sensitivity')
    group_rows=''.join(f'<tr><td>{g["symbol"]}</td><td>{g["interval"]}</td><td>{g["window"]}</td><td>{g["classification"]["n"]}</td><td>{pct(g["classification"]["accuracy"])}</td><td>{g["classification"]["fn"]}</td></tr>' for g in summary['cells'])
    sample_rows=''
    for row in rows:
        trade=row['chosen'];actual=row['actual_profitable'];reference=row['reference']
        answer='买入' if row['buy'] else '观望';outcome='不可执行' if actual is None else '盈利' if actual else '亏损'
        sample_rows+=f'''<tr data-symbol="{row['symbol']}" data-interval="{row['interval']}" data-window="{row['window']}" data-outcome="{outcome}"><td><details><summary>{e(local_time(row['decision_time']))}</summary><small>{e(row['case_id'])}<br><a href="run/requests/{e(row['case_id'])}.json">模型输入</a> · <a href="run/responses/{e(row['case_id'])}.json">原始回答</a></small></details></td><td>{row['symbol']}</td><td>{row['interval']}</td><td>{row['window']}</td><td>{answer}</td><td>{pct(row['p_profitable'])}</td><td>{row['exit_plan']}</td><td class="num">{f(row['planned_exit']['take_profit'])}</td><td class="num">{f(row['planned_exit']['stop_loss'])}</td><td>{outcome}</td><td class="num">{f(reference.get('net_pnl'))}</td><td class="num">{f(trade.get('net_pnl'))}</td></tr>'''
    image=base64.b64encode((REPORT/'results.png').read_bytes()).decode()
    page=f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Jev 纯 K 线实验 · 40 次实测</title>
<style>*{{box-sizing:border-box}}body{{margin:0;background:#101419;color:#d7e0e9;font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}}main{{max-width:1260px;margin:auto;padding:36px 24px 60px}}h1{{font-size:30px;line-height:1.25;margin:6px 0 14px}}h2{{font-size:18px;margin:32px 0 12px}}p{{max-width:100ch}}a{{color:#91bdf2}}.eyebrow,small,.muted{{color:#8c9bae}}.verdict{{border-left:3px solid #f0b95c;background:#1f242b;padding:14px 18px;margin:22px 0}}.metrics{{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#35404d;border:1px solid #35404d;margin:24px 0}}.metric{{background:#171e26;padding:16px}}.metric strong{{font:600 30px ui-monospace,monospace;display:block;color:#ecf3fa}}.metric small{{display:block}}.actions{{display:flex;gap:10px;flex-wrap:wrap}}.actions a{{border:1px solid #3a4b5f;padding:6px 12px;text-decoration:none;font-size:12px}}img{{width:100%;height:auto;display:block;background:#f8fafc}}.scroll{{overflow-x:auto;border:1px solid #303b48}}table{{width:100%;border-collapse:collapse;white-space:nowrap;font-size:12px}}th,td{{padding:8px 11px;border-bottom:1px solid #293440;text-align:left}}th{{background:#202a35;color:#a8bbd2;font-weight:500}}td.num{{font-family:ui-monospace,monospace;text-align:right}}.loss{{color:#f39292}}.note{{font-size:12px;color:#a5b4c5}}.filters{{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}}select{{background:#1b2632;color:#dae6f3;border:1px solid #42556e;padding:7px;border-radius:0}}summary{{cursor:pointer}}small a{{font-size:11px}}footer{{margin-top:36px;padding-top:16px;border-top:1px solid #303b48;color:#8c9bae;font-size:12px}}@media(max-width:700px){{main{{padding:24px 14px}}.metrics{{grid-template-columns:repeat(2,1fr)}}h1{{font-size:24px}}}}</style>
<main><div class="eyebrow">TVCHART / RESEARCH / 2026-09-21 · 独立数据实验</div><h1>Jev 看 K 线，能找到买入时机吗？</h1><p>40 个固定历史窗口，真实 Binance USDT 永续行情。只给过去数据，回答保存后再对照未来行情。</p>
<div class="verdict"><b>本轮没有观察到可用的买入择时能力。</b><br>40 次全部观望。{pct(c['accuracy'])} 的准确率与“永远观望”完全一样，全部 8 个盈利参考窗口都被错过。没有实际买入，不能计算交易胜率。</div>
<div class="metrics"><div class="metric"><small>有效模型回答</small><strong>40 / 40</strong><small>{extra['api_attempts']} 次 HTTP 尝试 · {extra['api_failures']} 次网络重试</small></div><div class="metric"><small>买入 / 观望</small><strong>0 / 40</strong><small>买入覆盖率 0%</small></div><div class="metric"><small>主准确率</small><strong>{pct(c['accuracy'])}</strong><small>30 / 38 · 与始终观望相同</small></div><div class="metric"><small>盈利机会召回</small><strong>0 / 8</strong><small>另有 2 个跳空无效参考样本</small></div></div>
<div class="actions"><a href="report.md">详细结论</a><a href="run/cases.csv" download>下载 40 条明细 CSV</a><a href="protocol.md">预注册协议</a><a href="run/manifest.json">样本清单与校验值</a></div>
<h2>数据与执行规则</h2><p>BTC / ETH × 5m / 15m × 60 / 120 根窗口，每组 5 次。决策区间：北京时间 {local_time(min(r['decision_time'] for r in rows))}—{local_time(max(r['decision_time'] for r in rows))}。隐去日期和品种名，无未来 K 线输入。</p><p class="note">四组候选止盈／止损由历史 ATR 计算；Jev 选 A/B/C/D。延迟一根完整周期柱后入场，最多持仓 12 根，每笔 1,000 USDT 名义金额，单边手续费 5bp、滑点 1bp，计入历史资金费。不是实盘交易。</p>
<h2>统计与模拟交易曲线</h2><img src="data:image/png;base64,{image}" alt="混淆矩阵、各方法净盈亏、抽样交易曲线与预测概率分布"><p class="note">概率 AUC {extra['probability_auc']:.4f}，接近随机排序。曲线仅记录抽样交易的已平仓盈亏，不代表连续市场盘中净值。</p>
<h2>与简单方法对照</h2><div class="scroll"><table><thead><tr><th>方法</th><th>交易数</th><th>交易胜率</th><th>净盈亏 USDT</th><th>手续费</th><th>资金费</th></tr></thead><tbody>{summary_rows}</tbody></table></div><p class="note">强制入场行只检验出场选择，不能称为 Jev 实际策略。仅比较共同可执行的 {paired['n']} 个样本，Jev 出场 {f(paired['selected_net'])} USDT，固定 B {f(paired['reference_b_net'])} USDT；减亏不能直接等同盈利优势。</p>
<h2>周期与窗口</h2><div class="scroll"><table><thead><tr><th>品种</th><th>周期</th><th>窗口</th><th>可评分数</th><th>准确率</th><th>错过盈利窗口</th></tr></thead><tbody>{group_rows}</tbody></table></div><p class="note">全部分组都没有买入判断；分组准确率反映亏损样本占比，不能用于选择最优配置。</p>
<h2>逐样本回放明细</h2><p class="note">最后两列均为“假设买入”的反事实盈亏；实际 Jev 策略始终观望，盈亏为 0。点击时间可查看原始输入和回答。</p><div class="filters"><select id="symbol" aria-label="筛选品种"><option value="">全部品种</option><option>BTCUSDT</option><option>ETHUSDT</option></select><select id="interval" aria-label="筛选周期"><option value="">全部周期</option><option>5m</option><option>15m</option></select><select id="window" aria-label="筛选窗口"><option value="">全部窗口</option><option>60</option><option>120</option></select><select id="outcome" aria-label="筛选参考结果"><option value="">全部参考结果</option><option>盈利</option><option>亏损</option><option>不可执行</option></select><span id="count">40 条</span></div>
<div class="scroll"><table id="cases"><thead><tr><th>时间 UTC+8</th><th>品种</th><th>周期</th><th>窗口</th><th>判断</th><th>盈利预测</th><th>计划</th><th>止盈价</th><th>止损价</th><th>参考结果</th><th>固定 B 盈亏</th><th>所选出场盈亏</th></tr></thead><tbody>{sample_rows}</tbody></table></div>
<h2>可用性与结论边界</h2><p>实际模型 <code>{e(', '.join(summary['model_versions']))}</code>，共 {summary['input_tokens']:,} 输入 token，API 用量费用 ${summary['api_cost_usd']:.8f}。成功请求延迟中位数 {summary['latency_median_seconds']:.2f}s，P95 {summary['latency_p95_seconds']:.2f}s；含重试最长 {extra['end_to_end_latency_max']:.2f}s。</p><p>接口与结构化输出可用，当前纯数值任务的择时价值未得到支持。40 个市场样本较少且可能相关；结论仅适用于本次冻结的提示、候选出场与执行假设。后续若改变配置，应重新采样做独立验证。</p>
<footer>原始回答、请求、行情与成交计算均保存在本地报告目录。API key 不在任何报告或请求 JSON 中。应用服务保持停止。</footer></main>
<script>for(const s of document.querySelectorAll('select'))s.addEventListener('change',()=>{{let n=0;for(const r of document.querySelectorAll('#cases tbody tr')){{r.hidden=['symbol','interval','window','outcome'].some(k=>document.getElementById(k).value&&r.dataset[k]!==document.getElementById(k).value);if(!r.hidden)n++;}}document.getElementById('count').textContent=n+' 条';}});</script></html>'''
    (REPORT/'report.html').write_text(page)


if __name__=='__main__':
    summary,rows,cases,manifest=(read_json(OUT/name) for name in ('summary.json','scored-cases.json','cases.json','manifest.json'))
    extra=supplemental(summary,rows,cases)
    plots(summary,rows,extra)
    build_report(summary,rows,extra,manifest)
    print('Report: '+str(REPORT/'report.html'))
