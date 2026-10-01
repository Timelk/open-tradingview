"""Render signal-following results and explicitly labelled post-run controls."""
from __future__ import annotations
import base64,html,itertools,statistics
from datetime import datetime,timezone,timedelta
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from jev_follow_eval import OUT
from jev_follow_backtest import replay
from jev_eval import read_json,write_json

DIR=OUT.parent
CN=timezone(timedelta(hours=8))
NAMES={'source_next_open':'原策略 · 下一根开盘','source_delayed':'原策略 · 同等延迟','jev_neutral':'Jev 中性问法过滤','jev_conservative':'Jev 保守问法过滤','always_skip':'始终跳过','long_only':'只跟做多信号（补充对照）','short_only':'只跟做空信号（补充对照）'}
REASONS={'TREND_SUPPORT':'趋势支持','CHOP':'震荡反复','COUNTERTREND':'与区间趋势相反','EXTENDED':'追价偏晚','COST':'成本偏高','UNCLEAR':'区分度不足','NO_OBJECTION':'未见突出反对因素'}
def f(v,n=2):return '—' if v is None else f'{v:,.{n}f}'
def pct(v):return '—' if v is None else f'{v*100:.1f}%'
def clock(ms):return datetime.fromtimestamp(ms/1000,CN).strftime('%m-%d %H:%M')
def esc(v):return html.escape(str(v))


def supplemental(cases,rows,markets):
    controls={side:replay(cases,markets,{c['id']:c['signal']['side']==side for c in cases},1) for side in ('long','short')}
    per_symbol={symbol:{arm:replay([c for c in cases if c['symbol']==symbol],{symbol:markets[symbol]},({r['case_id']:r['neutral_follow'] for r in rows} if arm=='jev' else {c['id']:True for c in cases}),1)['metrics'] for arm in ('baseline','jev')} for symbol in markets}
    # Exact combinations are valid for this batch only when independent trade
    # references and the stateful baseline agree (no overlapping pyramids).
    common=replay(cases,markets,{c['id']:True for c in cases},1)
    exact=None
    if all(r['reference'].get('status')=='closed' for r in rows) and abs(common['metrics']['total_net_pnl']-sum(r['reference']['net_pnl'] for r in rows))<1e-7 and all(r['neutral_follow'] for r in rows if r['side']=='long'):
        longs=sum(r['reference']['net_pnl'] for r in rows if r['side']=='long');choices=[]
        for symbol in ('BTCUSDT','ETHUSDT'):
            group=[r for r in rows if r['symbol']==symbol and r['side']=='short'];k=sum(r['neutral_follow'] for r in group)
            choices.append([sum(values) for values in itertools.combinations([r['reference']['net_pnl'] for r in group],k)])
        if len(choices[0])*len(choices[1])<100000:
            values=sorted(longs+a+b for a in choices[0] for b in choices[1]);observed=sum(r['reference']['net_pnl'] for r in rows if r['neutral_follow'])
            exact={'combinations':len(values),'observed':observed,'mean':statistics.mean(values),'median':statistics.median(values),'p05':values[int(len(values)*.05)],'p95':values[int(len(values)*.95)],'fraction_at_least_as_good':sum(v>=observed-1e-9 for v in values)/len(values)}
    extra={'note':'Post-run diagnostic controls, not new inference or tuned strategy parameters. Matched combinations preserve symbol and direction follow counts.', 'direction_ledgers':controls,'by_symbol':per_symbol,'matched_selection':exact}
    write_json(OUT/'supplemental.json',extra);return extra


def charts(s,rows,extra):
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False,'figure.facecolor':'#f8fafc','axes.facecolor':'#f8fafc'})
    fig,axes=plt.subplots(2,2,figsize=(13,8),layout='constrained')
    ax=axes[0,0];n=s['count'];a=s['neutral_follow'];b=s['conservative_follow']
    ax.bar(['Neutral','Conservative'],[a,b],color='#3b82f6',label='FOLLOW',width=.55);ax.bar(['Neutral','Conservative'],[n-a,n-b],bottom=[a,b],color='#cbd5e1',label='SKIP',width=.55)
    for i,v in enumerate([a,b]):ax.text(i,max(1,v/2),str(v),ha='center',va='center',fontsize=23,color='white' if v else '#334155')
    ax.set_ylim(0,n+4);ax.set_ylabel('Same source signals');ax.set_title('Same input, different decision wording',loc='left',fontsize=11);ax.legend(loc='upper right',fontsize=8)
    ax=axes[0,1]
    stats=[s['ledgers']['source_next_open'],s['ledgers']['source_delayed'],s['ledgers']['jev_neutral'],extra['direction_ledgers']['long']['metrics'],s['ledgers']['jev_conservative']]
    names=['Original: next open','Original: same delay','Jev neutral gate','Long-only control','Jev conservative gate'];values=[m['total_net_pnl'] for m in stats]
    ax.barh(names,values,color=['#94a3b8','#64748b','#2563eb','#059669','#cbd5e1']);ax.invert_yaxis();ax.axvline(0,color='#64748b',linewidth=.7)
    for i,v in enumerate(values):ax.text(v+(1 if v>=0 else -1),i,f'{v:.2f}',ha='left' if v>=0 else 'right',va='center',fontsize=9)
    ax.set_xlim(min(values)-13,max(values)+13);ax.set_xlabel('Net P&L (USDT)');ax.set_title('1,000 USDT per entry · after costs',loc='left',fontsize=11)
    ax=axes[1,0];start=datetime.fromtimestamp(min(r['decision_time'] for r in rows)/1000,timezone.utc)
    for metric,label,color in [(s['ledgers']['source_delayed'],'Original / same delay','#64748b'),(s['ledgers']['jev_neutral'],'Jev / neutral','#2563eb'),(extra['direction_ledgers']['long']['metrics'],'Long only','#059669')]:
        curve=metric['curve'];xs=[start]+[datetime.fromtimestamp(p['time']/1000,timezone.utc) for p in curve];ys=[0]+[p['equity']-10000 for p in curve];ax.step(xs,ys,where='post',label=label,color=color,linewidth=1.5)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%m-%d %H:%M',tz=CN));ax.tick_params(axis='x',labelrotation=18,labelsize=8);ax.set_xlabel('Beijing time (UTC+8)');ax.set_ylabel('Closed-trade cumulative P&L');ax.set_title('Sampled signal interval · not full intrabar drawdown',loc='left',fontsize=11);ax.legend(fontsize=8);ax.grid(alpha=.15)
    ax=axes[1,1];long=[r for r in rows if r['side']=='long'];short=[r for r in rows if r['side']=='short']
    follow=[sum(r['neutral_follow'] for r in group) for group in [long,short]];skip=[len(group)-v for group,v in zip([long,short],follow)]
    ax.bar(['LONG signals','SHORT signals'],follow,color='#2563eb',label='FOLLOW',width=.55);ax.bar(['LONG signals','SHORT signals'],skip,bottom=follow,color='#cbd5e1',label='SKIP',width=.55)
    for i,v in enumerate(follow):ax.text(i,max(1,v/2),str(v),ha='center',va='center',fontsize=23,color='white' if v else '#334155')
    ax.set_title('Neutral gate reveals a directional preference',loc='left',fontsize=11);ax.set_ylabel('Signal count');ax.legend(fontsize=8)
    fig.savefig(DIR/'results.png',dpi=160);plt.close(fig)


def render(s,rows,extra,manifest):
    metrics={**s['ledgers'],'long_only':extra['direction_ledgers']['long']['metrics'],'short_only':extra['direction_ledgers']['short']['metrics']}
    order=['source_next_open','source_delayed','jev_neutral','jev_conservative','long_only','short_only']
    table='\n'.join(f"| {NAMES[k]} | {metrics[k]['trades']} | {pct(metrics[k]['win_rate'])} | {f(metrics[k]['total_net_pnl'])} | {f(metrics[k]['closed_trade_drawdown'])} |" for k in order)
    neutral=s['classification']['neutral'];conservative=s['classification']['conservative'];exact=extra['matched_selection']
    long_follow=sum(r['neutral_follow'] for r in rows if r['side']=='long');short_follow=sum(r['neutral_follow'] for r in rows if r['side']=='short')
    begin=min(r['decision_time'] for r in rows);end=max(r['decision_time'] for r in rows)
    md=f'''# Jev 跟随均线信号实验

**流程已改为策略信号触发；本轮中性问法跟随 {s['neutral_follow']}/{s['count']}，保守问法跟随 {s['conservative_follow']}/{s['count']}。问法显著改变了决策，但这批数据没有证明模型优于简单的方向过滤。**

## 为什么上一轮全是观望

复查上一轮原始请求，WAIT 的定义确实包含 “unfavorable or uncertain”（不利或不确定）。同时，上轮要求随机时点的纯 K 线数据在固定 ATR 出场、12 根持仓期限、费用与执行延迟下支持做多。它与收到均线策略信号后决定是否跟随，是不同的任务。

40 个原始返回值都是真实 WAIT，BUY 概率为 0.08–0.17，独立的盈利预测概率为 0.26–0.36；客户端没有把 BUY 改成 WAIT。仅凭这些数值不能知道模型的全部内部原因。

本轮在同一输入上同时比较两种问法：保守问法继续将“不确定”纳入 SKIP；中性问法要求作概率性的跟随判断，不把一般预测不确定性直接当作跳过。{s['paired_disagreements']}/{s['count']} 次回答发生分歧。这是本批信号上的措辞敏感性证据，不能把上一轮所有观望都单独归因于提示词。

## 新实验的输入

- ETHUSDT、BTCUSDT 永续 1m，各最近连续 20 个源码信号，共 40 个：20 多、20 空。信号时间为北京时间 {clock(begin)} 至 {clock(end)}。
- 使用项目完整策略的交易计算段，原生 PineTS {manifest.get('engine_version','0.9.33')} 执行 EMA10 / SMA60、rangeLimit=100；没有另造交叉信号，也没有改动原脚本区间状态逻辑。
- 每次提供完整的“上一次源码信号 → 当前信号”区间，共 {s['segment_bars_range'][0]}–{s['segment_bars_range'][1]} 根，包含 OHLCV、原脚本均线值和从已知数据计算的摘要。上次信号不是上次成交或上次 Jev 放行。
- 输入不包含品种名、真实日期、下一次反向信号或任何未来柱。固定样本、输入、问题与源码 hash 之后才调用模型。
- 判定 FOLLOW / SKIP 只影响新开仓；原策略下一次反向信号仍负责平旧仓。若模型放行该反向信号，再反手开仓。当前已有同向仓位则不加仓。
- 本轮取消固定 ATR 出场和 12 根持仓上限，完全按后续原始反向信号退出。参考执行延迟一根完整 1m 后入场，退出不等模型。所有方法统一 1,000 USDT 名义金额、1 倍、单边 5bp 手续费和 1bp 滑点，计入资金费。

信号由真实 Pine 源码计算；金额、费用与进出场回放由独立研究撮合器统一处理，不是账户实盘结果。

## 跟随结果

| 方法 | 平仓交易数 | 交易胜率 | 净盈亏 USDT | 已平仓回撤 USDT |
| --- | ---: | ---: | ---: | ---: |
{table}

同延迟比较，Jev 中性过滤相对原策略变化 {f(s['ledgers']['jev_neutral']['total_net_pnl']-s['ledgers']['source_delayed']['total_net_pnl'])} USDT。但它放行了全部 {long_follow} 个多头，只放行 {short_follow} 个空头；简单的“只跟多头”规则本轮净盈亏为 {f(metrics['long_only']['total_net_pnl'])} USDT，高于 Jev 的 {f(metrics['jev_neutral']['total_net_pnl'])} USDT。方向过滤是结果的重要组成部分，不能把正收益全部解释成模型识别了更好的具体入场。

“只做多/只做空”属于结果出来后的补充诊断，不是调出来的新策略，也不是下一轮的默认推荐。它们用于检查模型的增益是否超过简单方向偏好。

## 判断质量与问法对照

| 指标 | 中性问法 | 保守问法 |
| --- | ---: | ---: |
| 跟随次数 | {s['neutral_follow']} / {s['count']} | {s['conservative_follow']} / {s['count']} |
| 分类准确率 | {pct(neutral['accuracy'])} | {pct(conservative['accuracy'])} |
| 放行的盈利信号 | {neutral['tp']} | {conservative['tp']} |
| 放行的亏损信号 | {neutral['fp']} | {conservative['fp']} |
| 错过的盈利信号 | {neutral['fn']} | {conservative['fn']} |
| 盈利信号召回 | {pct(neutral['recall'])} | {pct(conservative['recall'])} |
| Balanced accuracy | {pct(neutral['balanced_accuracy'])} | {pct(conservative['balanced_accuracy'])} |

中性问法的分类准确率和交易胜率是两个不同指标。方向读回 {s['readback_correct']}/{s['count']} 正确，说明请求中的多空方向被读取；这不等于有预测能力。独立盈利概率排序 AUC 为 {f(s['probability_auc'],3)}，仍缺乏强区分度。

保持每个品种、多空方向的跟随数量不变，枚举 {exact['combinations'] if exact else 0} 种选择组合，有 {pct(exact['fraction_at_least_as_good']) if exact else '—'} 的组合达到或超过 Jev 收益。这只是本样本的补充选择对照，不是独立市场上的显著性检验。

## 成本与后续判断

实际模型 `{', '.join(s['model_versions'])}`。{s['count']} 次有效回答，{s['attempts']} 次 HTTP 尝试，{s['failures']} 次网络失败后重试。费用 **${s['cost_usd']:.8f}**；成功调用延迟中位数 {s['latency_median_seconds']:.2f}s，含重试最大 {s['max_available_after_seconds']:.2f}s，超 60 秒响应 {s['late_responses']} 次。

本轮说明“全选观望”不是固定接口行为，输入任务与措辞会显著影响决定；也说明信号过滤更贴合我们的业务场景。当前样本仍少、相邻信号相关，且新实验同时改变了数据选择、双向交易和出场规则。尚不能确认 Jev 提供了稳定、独立于简单方向规则的预测优势。

如果继续，应在新的独立时间段沿用已经固定的协议，重点验证对纯规则的额外增益，而不是继续更改提示追求更高跟随率。本轮不修改正式图表策略或实盘执行。

- [预先固定协议](protocol.md)
- [40 条信号与原始区间明细](run/signals.csv)
- [逐笔组合交易清单](run/trades.csv)
- [汇总 JSON](run/summary.json)
- [冻结清单](run/manifest.json)
- [补充对照](run/supplemental.json)

![问法与跟随回放对照](results.png)
'''
    (DIR/'report.md').write_text(md)
    table_html=''.join(f'<tr><td>{esc(NAMES[k])}</td><td>{metrics[k]["trades"]}</td><td>{pct(metrics[k]["win_rate"])}</td><td class="num">{f(metrics[k]["total_net_pnl"])}</td><td>{f(metrics[k]["closed_trade_drawdown"])}</td></tr>' for k in order)
    row_html=''
    for r in rows:
        ref=r['reference'];value=ref.get('net_pnl');side='做多' if r['side']=='long' else '做空';decision='跟随' if r['neutral_follow'] else '跳过'
        row_html+=f'''<tr data-symbol="{r['symbol']}" data-side="{r['side']}" data-follow="{'yes' if r['neutral_follow'] else 'no'}"><td><details><summary>{clock(r['decision_time'])}</summary><small>{esc(r['case_id'])}<br><a href="run/requests/{r['case_id']}.json">输入</a> · <a href="run/responses/{r['case_id']}.json">原始回答</a></small></details></td><td>{r['symbol']}</td><td>{side}</td><td>{clock(r['previous_signal_time'])}</td><td>{r['segment_bars']}</td><td class="{'good' if r['neutral_follow'] else ''}">{decision}</td><td>{'跟随' if r['conservative_follow'] else '跳过'}</td><td>{pct(r['probability'])}</td><td>{REASONS[r['reason']]}</td><td class="num">{f(ref.get('entry_price'))}</td><td class="num">{f(ref.get('exit_price'))}</td><td class="num {'bad' if value is not None and value<0 else 'good'}">{f(value)}</td></tr>'''
    image=base64.b64encode((DIR/'results.png').read_bytes()).decode()
    page=f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Jev 跟随均线策略 · 对照实验</title><style>*{{box-sizing:border-box}}body{{margin:0;background:#10151b;color:#d6e2ef;font:14px/1.7 -apple-system,"PingFang SC",sans-serif}}main{{max-width:1250px;margin:auto;padding:34px 24px 60px}}h1{{font-size:30px;line-height:1.3;margin:8px 0}}h2{{font-size:18px;margin:30px 0 12px}}p{{max-width:102ch}}.muted,small{{color:#96a8bc}}a{{color:#8bb7ee}}.verdict{{border-left:3px solid #86b2ef;background:#1b2633;padding:14px 18px;margin:20px 0}}.cards{{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #354457;margin:22px 0}}.card{{padding:14px;border-right:1px solid #354457;background:#18212b}}.card strong{{display:block;font:600 30px ui-monospace,monospace;color:#eef6ff}}.links{{display:flex;gap:10px;flex-wrap:wrap}}.links a{{padding:6px 11px;border:1px solid #3c516c;font-size:12px;text-decoration:none}}img{{width:100%;height:auto;display:block}}.scroll{{overflow:auto;border:1px solid #334154}}table{{width:100%;border-collapse:collapse;white-space:nowrap;font-size:12px}}th,td{{padding:8px 10px;border-bottom:1px solid #2c3847;text-align:left}}th{{background:#202e3d;color:#afc2db;font-weight:500}}.num{{font-family:ui-monospace,monospace;text-align:right}}.good{{color:#70d6b5}}.bad{{color:#f2949a}}.filters{{display:flex;gap:8px;margin:12px 0;align-items:center}}select{{background:#1b2939;color:#d9e7f8;border:1px solid #445b78;padding:7px;border-radius:0}}summary{{cursor:pointer}}footer{{margin-top:30px;padding-top:14px;border-top:1px solid #334154;font-size:12px;color:#96a8bc}}@media(max-width:700px){{main{{padding:22px 12px}}.cards{{grid-template-columns:repeat(2,1fr)}}h1{{font-size:25px}}}}</style><main>
<small>TVCHART / RESEARCH / 2026-09-22</small><h1>从“现在买不买”改为“是否跟随这次信号”</h1><p>完整 EMA10 / SMA60 策略，ETH 与 BTC 永续 1m。每次只读取上一次源码信号至当前信号的已知数据。</p>
<div class="verdict"><b>这次会跟随了：中性问法 {s['neutral_follow']} 次 FOLLOW，保守问法 {s['conservative_follow']} 次。</b><br>同一输入有 {s['paired_disagreements']} 次决定因问法而不同。但本轮 Jev 净盈亏 {f(s['ledgers']['jev_neutral']['total_net_pnl'])} USDT，仍低于简单只做多规则的 {f(metrics['long_only']['total_net_pnl'])} USDT，尚未证明额外预测优势。</div>
<div class="cards"><div class="card"><small>原策略信号</small><strong>{s['count']}</strong><small>20 多 / 20 空 · 原生 Pine 执行</small></div><div class="card"><small>中性 / 保守跟随</small><strong>{s['neutral_follow']} / {s['conservative_follow']}</strong><small>相同输入，独立问题</small></div><div class="card"><small>Jev 费后净盈亏</small><strong>{f(s['ledgers']['jev_neutral']['total_net_pnl'])}</strong><small>USDT · {s['ledgers']['jev_neutral']['trades']} 笔 · 胜率 {pct(s['ledgers']['jev_neutral']['win_rate'])}</small></div><div class="card"><small>多 / 空信号放行</small><strong>{long_follow} / {short_follow}</strong><small>需要与简单方向过滤对照</small></div></div>
<div class="links"><a href="report.md">完整分析</a><a href="run/signals.csv" download>40 条信号 CSV</a><a href="run/trades.csv" download>交易清单 CSV</a><a href="protocol.md">实验协议</a></div>
<h2>为什么之前全部观望</h2><p>上一轮 WAIT 的定义包含“不确定”，并且要求随机时点在固定 ATR 出场、12 根持仓期限及成本约束下支持做多。原始模型确实返回了 40 个 WAIT，客户端没有改写。新一轮同样数据在保守问法下仍全部 SKIP，在中性问法下放行 {s['neutral_follow']} 个信号，表明问法是重要影响因素；它不是唯一被改变的实验因素。</p>
<h2>跟随流程与执行规则</h2><p>上次源码信号 → 当前信号，共 {s['segment_bars_range'][0]}–{s['segment_bars_range'][1]} 根 OHLCV、原均线值与已知数据摘要。Jev 决定是否开新仓；反向原始信号负责平旧仓，平仓不会被 AI 跳过。没有新加固定止盈止损或 12 根持仓限制。</p><p class="muted">信号时间：北京时间 {clock(begin)}—{clock(end)}。每次名义金额 1,000 USDT，单边手续费 5bp、滑点 1bp，计入资金费。主对照保守延迟一根完整 1m 后入场，原策略无 AI 基线同时展示。不是实盘交易。</p>
<h2>问法、方向和盈亏对照</h2><img src="data:image/png;base64,{image}" alt="问法对跟随次数的影响、盈亏基线、累计盈亏与多空偏好图"><div class="scroll"><table><thead><tr><th>方法</th><th>交易数</th><th>胜率</th><th>净盈亏 USDT</th><th>已平仓回撤 USDT</th></tr></thead><tbody>{table_html}</tbody></table></div><p class="muted">“只做多/空”是补充诊断，不能据这一小段行情推荐单向策略。保持币种、多空数量相同的 {exact['combinations'] if exact else 0} 种选择组合中，{pct(exact['fraction_at_least_as_good']) if exact else '—'} 达到或超过 Jev 收益。</p>
<h2>40 个信号的区间与回答</h2><p class="muted">最后一列是单信号“假设跟随”的参考盈亏；实际组合是否开仓见交易清单。理由类别是独立分类，不等于模型内部推理。点击时间查看原始输入和回答。</p><div class="filters"><select id="symbol" aria-label="筛选品种"><option value="">全部品种</option><option>ETHUSDT</option><option>BTCUSDT</option></select><select id="side" aria-label="筛选方向"><option value="">全部方向</option><option value="long">做多</option><option value="short">做空</option></select><select id="follow" aria-label="筛选决定"><option value="">全部决定</option><option value="yes">跟随</option><option value="no">跳过</option></select><span id="count">{s['count']} 条</span></div><div class="scroll"><table id="signals"><thead><tr><th>当前信号 UTC+8</th><th>品种</th><th>方向</th><th>上次信号</th><th>区间柱数</th><th>中性</th><th>保守</th><th>盈利预测</th><th>结构分类</th><th>参考入场</th><th>规则出场</th><th>参考盈亏</th></tr></thead><tbody>{row_html}</tbody></table></div>
<h2>验证与边界</h2><p>方向读回 {s['readback_correct']}/{s['count']} 正确；中性分类准确率 {pct(neutral['accuracy'])}、跟随信号胜率 {pct(neutral['precision'])}、盈利信号召回 {pct(neutral['recall'])}。概率排序 AUC {f(s['probability_auc'],3)}。这些指标与组合净收益各自回答不同的问题。</p><p>实际模型 <code>{esc(', '.join(s['model_versions']))}</code>，{s['attempts']} 次 HTTP 尝试、{s['failures']} 次网络重试，费用 ${s['cost_usd']:.8f}。输入、源码与协议均在调用前冻结。此批样本少且相邻相关，不能据此证明长期优势。</p><footer>独立数据实验。正式图表策略未修改；API key 留在本地私密配置中；开发服务保持停止。</footer></main><script>for(const s of document.querySelectorAll('select'))s.addEventListener('change',()=>{{let n=0;for(const r of document.querySelectorAll('#signals tbody tr')){{r.hidden=['symbol','side','follow'].some(k=>document.getElementById(k).value&&r.dataset[k]!==document.getElementById(k).value);if(!r.hidden)n++;}}document.getElementById('count').textContent=n+' 条';}});</script></html>'''
    (DIR/'report.html').write_text(page)


if __name__=='__main__':
    s=read_json(OUT/'summary.json');rows=read_json(OUT/'scored-cases.json');cases=read_json(OUT/'cases.json');manifest=read_json(OUT/'manifest.json')
    markets={symbol:read_json(OUT/'market-data'/f'{symbol}.json') for symbol in ('ETHUSDT','BTCUSDT')}
    extra=supplemental(cases,rows,markets);charts(s,rows,extra);render(s,rows,extra,manifest)
    print(DIR/'report.html')
