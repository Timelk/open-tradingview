"""Offline grouped diagnostics and report; no new inference requests."""
from __future__ import annotations
import base64,html,itertools,json,random,statistics
from datetime import datetime,timezone,timedelta
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from jev_eval import read_json,write_json
from jev_expanded_eval import OUT,pooled_metrics
from jev_follow_backtest import replay

DIR=OUT.parent;CN=timezone(timedelta(hours=8))
NAMES={'source_next_open':'原策略 · 下一根开盘','source_delayed':'原策略 · 同等延迟','availability_matched':'原策略 · 同延迟及网络可用性',
       'jev_neutral':'Jev 中性过滤','jev_conservative':'Jev 保守过滤','always_skip':'始终跳过','long_only':'仅跟多头','short_only':'仅跟空头'}
REASONS={'TREND_SUPPORT':'趋势支持','CHOP':'震荡反复','COUNTERTREND':'区间趋势相反','EXTENDED':'追价偏晚','COST':'成本偏高','UNCLEAR':'区分度不足','NO_OBJECTION':'未见突出反对因素'}
def f(v,n=2):return '—' if v is None else f'{v:,.{n}f}'
def pct(v):return '—' if v is None else f'{v*100:.1f}%'
def clock(ms):return datetime.fromtimestamp(ms/1000,CN).strftime('%m-%d %H:%M')
def esc(v):return html.escape(str(v))


def diagnostics(s,cases,rows):
    rng=random.Random(20260922);distributions=[];group_controls={};late={r['case_id'] for r in rows if r['late']}
    row_map={r['case_id']:r for r in rows};available_long=[];available_short=[]
    for group in s['group_results']:
        gid=group['id'];market=read_json(OUT/'market-data'/f'{gid}.json');sub=[c for c in cases if c['group_id']==gid]
        options=[]
        for side in ('long','short'):
            pool=[c['id'] for c in sub if c['signal']['side']==side and c['id'] not in late]
            count=sum(row_map[c]['neutral_follow'] for c in pool)
            options.append(list(itertools.combinations(pool,count)))
        values=[]
        for long_ids in options[0]:
            for short_ids in options[1]:
                accepted={key:True for key in (*long_ids,*short_ids)}
                values.append(replay(sub,{market['symbol']:market},accepted,1,late)['metrics']['total_net_pnl'])
        distributions.append(values)
        observed=group['ledgers']['jev_neutral']['total_net_pnl']
        group_controls[gid]={'combinations':len(values),'observed':observed,'mean':statistics.mean(values),'fraction_at_least_as_good':sum(v>=observed-1e-9 for v in values)/len(values)}
        available_long.append(replay(sub,{market['symbol']:market},{c['id']:c['signal']['side']=='long' for c in sub},1,late))
        available_short.append(replay(sub,{market['symbol']:market},{c['id']:c['signal']['side']=='short' for c in sub},1,late))
    combined=sorted(sum(rng.choice(values) for values in distributions) for _ in range(10000));observed=s['methods']['jev_neutral']['total_net_pnl']
    block_deltas=[a['methods']['jev_neutral']['total_net_pnl']-a['methods']['source_delayed']['total_net_pnl'] for a in s['aggregates'] if a['field']=='block']
    block_replicates=sorted(sum(sample) for sample in itertools.product(block_deltas,repeat=len(block_deltas)))
    source=s['methods']['source_delayed'];jev=s['methods']['jev_neutral']
    difference=jev['total_net_pnl']-source['total_net_pnl'];fee_saved=source['fees']-jev['fees'];funding_saved=source['funding_cost']-jev['funding_cost']
    extra={'note':'Descriptive controls only; no added inference or tuned thresholds. Sampling preserves each group, side and on-time FOLLOW count and uses the stateful replay.',
      'matched_selection':{'draws':10000,'mean':statistics.mean(combined),'median':statistics.median(combined),'p05':combined[499],'p95':combined[9499],
                           'observed':observed,'fraction_at_least_as_good':sum(v>=observed-1e-9 for v in combined)/len(combined)},
      'group_controls':group_controls,'availability_matched_long':pooled_metrics(available_long),'availability_matched_short':pooled_metrics(available_short),
      'cost_decomposition':{'net_delta':difference,'fees_saved':fee_saved,'funding_saved':funding_saved,'gross_pnl_after_slippage_delta':difference-fee_saved-funding_saved,'fee_share_of_improvement':fee_saved/difference if difference else None},
      'time_block_bootstrap':{'blocks':len(block_deltas),'observed_delta':sum(block_deltas),'descriptive_interval95':[block_replicates[int(len(block_replicates)*.025)],block_replicates[int(len(block_replicates)*.975)]],
                             'caveat':'Only five time blocks; resampling is descriptive, not proof of statistical significance.'}}
    write_json(OUT/'diagnostics.json',extra)
    return extra


def charts(s,extra):
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False,'figure.facecolor':'#f8fafc','axes.facecolor':'#f8fafc'})
    fig,axes=plt.subplots(2,2,figsize=(14,9),layout='constrained')
    ax=axes[0,0]
    keys=['source_delayed','jev_neutral','long_only','short_only','always_skip'];names=['Original / same delay','Jev neutral gate','Long-only control','Short-only control','Always skip']
    values=[s['methods'][k]['total_net_pnl'] for k in keys]
    ax.barh(names,values,color=['#64748b','#2563eb','#059669','#b45309','#94a3b8']);ax.invert_yaxis();ax.axvline(0,color='#64748b',linewidth=.7)
    for i,v in enumerate(values):ax.text(v-3 if v<0 else v+3,i,f'{v:.2f}',ha='right' if v<0 else 'left',va='center',fontsize=9)
    ax.set_xlim(min(values)-60,18);ax.set_xlabel('Sum of separate group P&Ls (USDT)');ax.set_title('200 new signals · same 1,000 USDT entry size',loc='left',fontsize=11)
    ax=axes[0,1];block_rows=sorted([a for a in s['aggregates'] if a['field']=='block'],key=lambda a:int(a['value'][1:]),reverse=True);x=np.arange(len(block_rows));width=.25
    for shift,key,label,color in [(-1,'source_delayed','Original / delayed','#64748b'),(0,'jev_neutral','Jev neutral','#2563eb'),(1,'long_only','Long only','#059669')]:
        ax.bar(x+shift*width,[a['methods'][key]['total_net_pnl'] for a in block_rows],width,label=label,color=color)
    dates={g['block']:clock(g['anchor']).split(' ')[0] for g in s['group_results']}
    ax.set_xticks(x,[dates[a['value']] for a in block_rows]);ax.axhline(0,color='#64748b',linewidth=.6);ax.set_ylabel('Group P&L sum (USDT)');ax.set_title('Five preselected historical blocks',loc='left',fontsize=11);ax.legend(fontsize=8)
    ax=axes[1,0];groups=s['group_results'];labels=[f"{clock(g['anchor']).split(' ')[0]} {g['symbol'][:3]} {g['interval']}" for g in groups]
    matrix=np.array([[g['ledgers'][key]['total_net_pnl'] for key in ['source_delayed','jev_neutral','long_only','short_only']] for g in groups])
    limit=max(abs(matrix.min()),abs(matrix.max()));ax.imshow(matrix,aspect='auto',cmap='RdYlGn',vmin=-limit,vmax=limit)
    ax.set_yticks(range(len(labels)),labels,fontsize=7);ax.set_xticks(range(4),['Original','Jev','Long only','Short only'],fontsize=8)
    for i in range(len(labels)):
        for j in range(4):ax.text(j,i,f'{matrix[i,j]:.1f}',ha='center',va='center',fontsize=7,color='#0f172a')
    ax.set_title('All 20 groups shown · no winning-period selection',loc='left',fontsize=11)
    ax=axes[1,1];follow=[s['by_side'][side]['follow'] for side in ('long','short')];skip=[s['by_side'][side]['n']-v for side,v in zip(('long','short'),follow)]
    ax.bar(['LONG','SHORT'],follow,color='#2563eb',label='FOLLOW',width=.55);ax.bar(['LONG','SHORT'],skip,bottom=follow,color='#cbd5e1',label='SKIP',width=.55)
    for i,v in enumerate(follow):ax.text(i,v/2,str(v),ha='center',va='center',fontsize=25,color='white')
    ax.set_ylim(0,110);ax.set_ylabel('Signals');ax.set_title('Directional preference persists',loc='left',fontsize=11);ax.legend(fontsize=8)
    fig.savefig(DIR/'results.png',dpi=160);plt.close(fig)


def render(s,rows,extra,manifest):
    order=['source_next_open','source_delayed','availability_matched','jev_neutral','jev_conservative','long_only','short_only']
    table='\n'.join(f"| {NAMES[k]} | {s['methods'][k]['trades']} | {pct(s['methods'][k]['win_rate'])} | {f(s['methods'][k]['total_net_pnl'])} | {f(s['methods'][k]['fees'])} |" for k in order)
    group_table='\n'.join(f"| {clock(g['anchor']).split(' ')[0]} | {g['symbol']} | {g['interval']} | {g['follow']}/{g['count']} | {f(g['ledgers']['source_delayed']['total_net_pnl'])} | {f(g['ledgers']['jev_neutral']['total_net_pnl'])} | {f(g['ledgers']['long_only']['total_net_pnl'])} | {f(g['delta_vs_delayed'])} |" for g in s['group_results'])
    c=s['classification']['neutral'];d=extra['cost_decomposition'];match=extra['matched_selection'];boot=extra['time_block_bootstrap'];jev=s['methods']['jev_neutral']
    n_unscored=s['count']-c['n'];unscored=[{'case_id':r['case_id'],'reason':r['reference'].get('reason',r['reference'].get('status'))} for r in rows if r['actual_profitable'] is None]
    write_json(OUT/'unscored-cases.json',unscored)
    md=f'''# Jev 跟随策略扩样：200 个新信号、20 组

**扩样后，减少亏损的现象在多数分组出现，但没有形成整体盈利，也没有表现出明显超过简单方向规则的收益。**

沿用上一轮两种问法、EMA10/SMA60/rangeLimit=100、资金与费用规则。40 个旧信号没有重复计入。本轮 BTC、ETH × 1m、5m × 5 个固定历史锚点，每组 10 个，共 200 个新信号，100 多、100 空。每次输入上一次源码信号到当前信号的完整区间，共 {manifest['segment_bars_range'][0]}–{manifest['segment_bars_range'][1]} 根，未裁剪。

## 结果

- 中性问法放行 **{s['neutral_follow']}/{s['count']}**，保守问法放行 **{s['conservative_follow']}/{s['count']}**。
- 中性组合实际成交 **{jev['trades']} 笔**，胜率 **{pct(jev['win_rate'])}**，合计净盈亏 **{f(jev['total_net_pnl'])} USDT**。
- 相对同延迟原策略，**{s['groups_improved_vs_delayed']}/{s['groups']} 组**改善；但仅 **{s['positive_jev_groups']}/{s['groups']} 组**自身盈利。
- 相对仅跟多头，仅 **{s['groups_improved_vs_long_only']}/{s['groups']} 组**改善。
- 方向偏好：多头放行 {s['by_side']['long']['follow']}/100，空头放行 {s['by_side']['short']['follow']}/100。

每笔新仓名义金额 1,000 USDT、1 倍、不复投；费用包括单边 5bp 手续费、1bp 不利滑点及历史资金费。各组从独立空仓账户开始，下面是各组利润的合计，不是一个账户的连续收益率。

| 方法 | 已平仓笔数 | 交易胜率 | 合计净盈亏 USDT | 手续费 USDT |
| --- | ---: | ---: | ---: | ---: |
{table}

同延迟原策略与 Jev 的净盈亏差为 {f(d['net_delta'])} U，其中手续费减少 {f(d['fees_saved'])} U，占差值约 {pct(d['fee_share_of_improvement'])}；其他部分来自交易选择后的毛盈亏与资金费变化。少交易确实节约成本，但不应全部算成预测准确性的提升。

## 网络与公平对照

{s['late_responses']} 个响应（含重试）超过一根周期，按预先规则不追认开仓。正常原策略没有远程 API 超时，因此另列相同网络可用性对照。按同样可用性限制，“只跟多头”净盈亏为 {f(extra['availability_matched_long']['total_net_pnl'])} U，“只跟空头”为 {f(extra['availability_matched_short']['total_net_pnl'])} U；Jev 为 {f(jev['total_net_pnl'])} U。

保持每组、品种、周期、多空方向和及时 FOLLOW 数量不变，用相同有仓位状态的撮合规则做 10,000 次组合选择对照：随机参考均值 {f(match['mean'])} U，5%–95% 范围 {f(match['p05'])}～{f(match['p95'])} U，{pct(match['fraction_at_least_as_good'])} 的组合达到或超过 Jev。这是本批固定数据的选择参照，不是未来收益概率。

## 不是只看一个总数

| 历史锚点 UTC+8 | 品种 | 周期 | FOLLOW | 原策略同延迟 | Jev | 只跟多头 | Jev 减亏/增益 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
{group_table}

最有利的 Jev 单组是 `{s['largest_jev_group']}`；剔除它后，其余组净盈亏仍为 {f(s['net_without_best_group'])} U。五个时间块聚合重采样的“相对原策略差值”描述性区间为 {f(boot['descriptive_interval95'][0])}～{f(boot['descriptive_interval95'][1])} U。只有 5 个时间块，不能将该区间当作稳健的显著性结论。

## 判断质量

可评分参考信号 {c['n']} 个；另有 {n_unscored} 个因入场前信号反转或观察截止而单列，不按盈亏补样。跟随正确且参考盈利 {c['tp']}，放行参考亏损 {c['fp']}，跳过参考亏损 {c['tn']}，错过参考盈利 {c['fn']}。

- 分类准确率：{pct(c['accuracy'])}；balanced accuracy：{pct(c['balanced_accuracy'])}。
- 盈利参考信号召回：{pct(c['recall'])}；单信号 FOLLOW 精确率：{pct(c['precision'])}。
- 盈利概率排序 AUC：{f(s['probability_auc'],3)}；方向读回：{s['readback_correct']}/{s['count']}。
- 分类参考与实际组合不同：已有同向仓位不加仓、过期响应不入场、反向信号先退出旧仓。不能把全部假设单笔直接相加当作组合。

## 解释与边界

200 个新样本使上轮单一时段的小额正收益不再能代表整体。Jev 有降低交易次数、减少部分损失的表现；目前缺乏它具有稳定额外选时优势的证据。只跟空头这类对照在本批更好，也不能因此改为推荐单向交易——方向优劣同样随市场时段变化。

这些仍是历史模拟；相邻信号和币种相关，不能按 200 个完全独立试验理解。提示词未调整，未来 K 线未传入模型，日期和品种名被隐藏，但这不能证明不存在任何预训练记忆影响。执行延迟、费用与当前交易规则属于明确研究假设。

实际模型 `{', '.join(s['model_versions'])}`，{s['count']} 次有效回答，{s['attempts']} 次 HTTP 尝试、{s['failures']} 次网络失败。已返回 usage 的费用合计 **${s['cost_usd']:.8f}**；未收到响应的超时请求是否计费以 OpenRouter 账单为准。成功请求中位数 {s['latency_median_seconds']:.2f}s、P95 {s['latency_p95_seconds']:.2f}s，含重试最长 {s['max_available_after_seconds']:.2f}s。正式图表与策略未改动，服务保持停止。

- [预先固定协议](protocol.md)
- [200 条信号 CSV](run/signals.csv)
- [全部对照交易清单 CSV](run/trades.csv)
- [汇总 JSON](run/summary.json)
- [组合选择与成本拆解](run/diagnostics.json)
- [不可评分案例](run/unscored-cases.json)
- [输入及源码校验清单](run/manifest.json)

![分组对照图](results.png)
'''
    (DIR/'report.md').write_text(md)
    methods_html=''.join(f'<tr><td>{esc(NAMES[k])}</td><td>{s["methods"][k]["trades"]}</td><td>{pct(s["methods"][k]["win_rate"])}</td><td class="num">{f(s["methods"][k]["total_net_pnl"])}</td><td>{f(s["methods"][k]["fees"])}</td></tr>' for k in order)
    groups_html=''.join(f'<tr><td>{clock(g["anchor"]).split(" ")[0]}</td><td>{g["symbol"]}</td><td>{g["interval"]}</td><td>{g["follow"]}/{g["count"]}</td><td class="num">{f(g["ledgers"]["source_delayed"]["total_net_pnl"])}</td><td class="num">{f(g["ledgers"]["jev_neutral"]["total_net_pnl"])}</td><td class="num">{f(g["ledgers"]["long_only"]["total_net_pnl"])}</td><td class="num">{f(g["delta_vs_delayed"])}</td></tr>' for g in s['group_results'])
    sample_html=''
    for r in rows:
        ref=r['reference'];value=ref.get('net_pnl');outcome='未评分' if r['actual_profitable'] is None else '盈利' if r['actual_profitable'] else '亏损'
        sample_html+=f'''<tr data-symbol="{r['symbol']}" data-interval="{r['interval']}" data-side="{r['side']}" data-follow="{'yes' if r['neutral_follow'] else 'no'}"><td><details><summary>{clock(r['decision_time'])}</summary><small>{r['case_id']}<br><a href="run/requests/{r['case_id']}.json">输入</a> · <a href="run/responses/{r['case_id']}.json">回答</a></small></details></td><td>{r['symbol']}</td><td>{r['interval']}</td><td>{'多' if r['side']=='long' else '空'}</td><td>{r['segment_bars']}</td><td>{'跟随' if r['neutral_follow'] else '跳过'}</td><td>{'跟随' if r['conservative_follow'] else '跳过'}</td><td>{pct(r['probability'])}</td><td>{outcome}</td><td class="num">{f(value)}</td><td>{'过期' if r['late'] else f(r['available_after_seconds'])+'s'}</td></tr>'''
    image=base64.b64encode((DIR/'results.png').read_bytes()).decode()
    page=f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Jev 扩样 · 200 个新信号</title><style>*{{box-sizing:border-box}}body{{margin:0;background:#10161d;color:#d9e4f1;font:14px/1.7 -apple-system,"PingFang SC",sans-serif}}main{{max-width:1290px;padding:34px 24px 60px;margin:auto}}h1{{font-size:30px;line-height:1.25;margin:8px 0}}h2{{font-size:18px;margin:30px 0 12px}}small,.muted{{color:#96a9c0}}a{{color:#8cb9f2}}.verdict{{border-left:3px solid #e5b261;background:#25282c;padding:14px 18px;margin:22px 0}}.cards{{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #354558;margin:22px 0}}.card{{padding:16px;border-right:1px solid #354558;background:#18222d}}.card strong{{display:block;font:600 30px ui-monospace,monospace;color:#eff5ff}}.links{{display:flex;gap:10px;flex-wrap:wrap}}.links a{{font-size:12px;padding:6px 11px;border:1px solid #425775;text-decoration:none}}.scroll{{overflow:auto;border:1px solid #344458}}table{{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}}th,td{{padding:8px 10px;text-align:left;border-bottom:1px solid #2d3b4d}}th{{background:#213045;color:#b4c8e1;font-weight:500}}.num{{font-family:ui-monospace,monospace;text-align:right}}img{{width:100%;height:auto;display:block}}.filters{{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}}select{{background:#1d2a3b;border:1px solid #445c7c;color:#d9e7fa;padding:7px;border-radius:0}}summary{{cursor:pointer}}footer{{border-top:1px solid #344458;margin-top:30px;padding-top:15px;color:#96a9c0;font-size:12px}}@media(max-width:700px){{main{{padding:22px 12px}}.cards{{grid-template-columns:repeat(2,1fr)}}h1{{font-size:24px}}}}</style><main>
<small>TVCHART / RESEARCH / 2026-09-22 · 新历史样本</small><h1>多测 20 组后，Jev 的改善能否重复？</h1><p>BTC / ETH × 1m / 5m × 5 个事先固定的历史锚点，每组 10 个新信号。沿用原问法、EMA10 / SMA60、rangeLimit=100 与交易成本。</p>
<div class="verdict"><b>多数分组减少亏损，整体仍亏损；方向偏好依然明显。</b><br>Jev 实际 {jev['trades']} 笔交易合计 {f(jev['total_net_pnl'])} U，同延迟原策略 {f(s['methods']['source_delayed']['total_net_pnl'])} U。{s['groups_improved_vs_delayed']}/20 组改善，只有 {s['positive_jev_groups']}/20 组自身盈利。</div>
<div class="cards"><div class="card"><small>新增信号 / 分组</small><strong>200 / 20</strong><small>无旧样本重复 · 100 多 / 100 空</small></div><div class="card"><small>中性 / 保守 FOLLOW</small><strong>{s['neutral_follow']} / {s['conservative_follow']}</strong><small>同输入、相同模型版本</small></div><div class="card"><small>Jev 合计净盈亏 U</small><strong>{f(jev['total_net_pnl'])}</strong><small>{jev['trades']} 笔 · 胜率 {pct(jev['win_rate'])}</small></div><div class="card"><small>多头 / 空头放行</small><strong>{s['by_side']['long']['follow']} / {s['by_side']['short']['follow']}</strong><small>分别以 100 个信号为分母</small></div></div>
<div class="links"><a href="report.md">详细分析</a><a href="run/signals.csv" download>200 条信号 CSV</a><a href="run/trades.csv" download>全部交易清单 CSV</a><a href="protocol.md">预先固定协议</a><a href="run/manifest.json">冻结清单</a></div>
<h2>同样条件下的对照</h2><p class="muted">每组独立从空仓开始，单次名义金额 1,000 USDT。这里是组间利润合计，不是一个连续账户的收益率。全部已扣费用、滑点及资金费。</p><div class="scroll"><table><thead><tr><th>方法</th><th>成交数</th><th>胜率</th><th>合计净盈亏 U</th><th>手续费 U</th></tr></thead><tbody>{methods_html}</tbody></table></div>
<p>相对同延迟原策略改善 {f(d['net_delta'])} U，其中手续费减少 {f(d['fees_saved'])} U，约占 {pct(d['fee_share_of_improvement'])}。减少交易节约了成本，不能全部解释为预测变准。</p>
<h2>每组都展示</h2><img src="data:image/png;base64,{image}" alt="整体盈亏、五个历史时段、二十组完整对照与多空跟随偏好"><div class="scroll"><table><thead><tr><th>锚点 UTC+8</th><th>品种</th><th>周期</th><th>FOLLOW</th><th>原策略同延迟</th><th>Jev</th><th>只跟多头</th><th>相对原策略差值</th></tr></thead><tbody>{groups_html}</tbody></table></div>
<h2>额外的公平检查</h2><p>{s['late_responses']} 个响应超出一根周期，未追认开仓。在同样网络可用性限制下，多头对照为 {f(extra['availability_matched_long']['total_net_pnl'])} U，空头对照为 {f(extra['availability_matched_short']['total_net_pnl'])} U。</p><p>按每组、多空、品种、周期和及时跟随数量做 10,000 次组合选择，参考均值 {f(match['mean'])} U，{pct(match['fraction_at_least_as_good'])} 的组合达到或超过 Jev；不能把该比例理解成未来胜率。</p>
<h2>逐信号明细</h2><p class="muted">参考盈亏是单信号假设跟随结果，实际是否开仓见组合交易清单。{n_unscored} 个入场前反转或观察截止案例单列，不补样。</p><div class="filters"><select id="symbol" aria-label="筛选品种"><option value="">全部品种</option><option>BTCUSDT</option><option>ETHUSDT</option></select><select id="interval" aria-label="筛选周期"><option value="">全部周期</option><option>1m</option><option>5m</option></select><select id="side" aria-label="筛选方向"><option value="">全部方向</option><option value="long">做多</option><option value="short">做空</option></select><select id="follow" aria-label="筛选决定"><option value="">全部决定</option><option value="yes">跟随</option><option value="no">跳过</option></select><span id="count">200 条</span></div><div class="scroll"><table id="signals"><thead><tr><th>信号时间 UTC+8</th><th>品种</th><th>周期</th><th>方向</th><th>区间柱数</th><th>中性</th><th>保守</th><th>盈利预测</th><th>参考结果</th><th>参考盈亏</th><th>可用耗时</th></tr></thead><tbody>{sample_html}</tbody></table></div>
<h2>解释边界</h2><p>中性分类准确率 {pct(c['accuracy'])}，balanced accuracy {pct(c['balanced_accuracy'])}，概率排序 AUC {f(s['probability_auc'],3)}。分类质量、交易胜率和净盈亏并非同一指标。</p><p>本轮没有调整提示或阈值，也没有依据盈亏挑日期。样本仍来自相关市场的五个历史时段，不能据此证明长期优势。现有证据支持“减少一些交易与成本”，尚不足以支持将 Jev 作为稳定获利的必要判断层。</p><footer>模型 {esc(', '.join(s['model_versions']))} · {s['attempts']} 次 HTTP 尝试 · 已返回用量费用 ${s['cost_usd']:.8f}（超时计费以平台账单为准）。所有输入、回答和数据 hash 已保存。正式图表未修改，开发服务保持停止。</footer></main><script>for(const s of document.querySelectorAll('select'))s.addEventListener('change',()=>{{let n=0;for(const r of document.querySelectorAll('#signals tbody tr')){{r.hidden=['symbol','interval','side','follow'].some(k=>document.getElementById(k).value&&r.dataset[k]!==document.getElementById(k).value);if(!r.hidden)n++;}}document.getElementById('count').textContent=n+' 条';}});</script></html>'''
    (DIR/'report.html').write_text(page)


if __name__=='__main__':
    s=read_json(OUT/'summary.json');rows=read_json(OUT/'scored-cases.json');cases=read_json(OUT/'cases.json');manifest=read_json(OUT/'manifest.json')
    extra=diagnostics(s,cases,rows);charts(s,extra);render(s,rows,extra,manifest)
    print(DIR/'report.html')
    print(json.dumps({'matched_selection':extra['matched_selection'],'cost_decomposition':extra['cost_decomposition'],'availability_long':extra['availability_matched_long']['total_net_pnl'],'availability_short':extra['availability_matched_short']['total_net_pnl'],'block_interval':extra['time_block_bootstrap']},ensure_ascii=False,indent=2))
