"""Render the frozen research output; no new model selection occurs here."""
from pathlib import Path
import json, math, statistics, collections
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime, timezone
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/research/pattern-audit-2026-09-27'
x=json.loads((OUT/'run/evaluation.json').read_text())
ledger=json.loads((OUT/'run/trade-ledger.json').read_text())
keys=['huzi','harmonic','hscp-v1','hscp-v2']
names={'huzi':'胡子','harmonic':'谐波','hscp-v1':'量价共振原版','hscp-v2':'量价共振语义修复版'}
en={'huzi':'Huzi','harmonic':'Harmonic','hscp-v1':'HSCP original','hscp-v2':'HSCP corrected'}
colors={'huzi':'#557FA5','harmonic':'#969044','hscp-v1':'#BB665D','hscp-v2':'#298A7C'}
pct=lambda n:f'{n*100:+.2f}%'
num=lambda n:'—' if n is None else f'{n:.2f}'
date=lambda t:datetime.fromtimestamp(t/1000,timezone.utc).strftime('%Y-%m-%d %H:%M')
plt.rcParams.update({'font.size':10,'axes.spines.top':False,'axes.spines.right':False,'axes.labelcolor':'#374151','text.color':'#17232C','savefig.facecolor':'white'})
fig,axs=plt.subplots(2,3,figsize=(15,8),layout='constrained')
for col,(frame,f) in enumerate(x['frames'].items()):
    for key in keys:
        ds=f['results']['all'][key]['dailyReturns'];capital=1;vals=[]
        for d in ds:capital*=1+d['return'];vals.append(100*(capital-1))
        axs[0,col].plot([datetime.fromisoformat(d['day']) for d in ds],vals,label=en[key],color=colors[key],lw=1.8)
        ss=f['costSensitivity'][key]
        axs[1,col].plot([2*(z['feeBps']+z['slippageBps']) for z in ss],[z['return']*100 for z in ss],color=colors[key],marker='o',lw=1.8)
    axs[0,col].set_title(frame+' | daily marked equity',loc='left',weight='bold')
    axs[0,col].xaxis.set_major_formatter(mdates.DateFormatter('%b %d'))
    axs[0,col].xaxis.set_major_locator(mdates.AutoDateLocator(minticks=3,maxticks=5))
    axs[1,col].set_title(frame+' | trading-cost sensitivity',loc='left',weight='bold')
    axs[1,col].set_xticks([0,6,12,24]);axs[1,col].set_xlabel('Nominal round-trip fee + slippage (bps)')
    for ax in axs[:,col]:ax.axhline(0,color='#67727E',ls='--',lw=.8);ax.grid(alpha=.14);ax.set_ylabel('Cumulative return (%)')
axs[0,0].legend(fontsize=8,frameon=False,loc='lower left')
fig.suptitle('Pattern audit | BTC + ETH, equal starting capital, 1x exposure\nNext-open entry, geometric stop / T1, 48-bar limit; actual funding included',fontsize=14,weight='bold')
fig.savefig(OUT/'performance.png',dpi=170);fig.savefig(OUT/'performance.svg');plt.close(fig)

# Failure rates describe realized execution outcomes, separate from geometry lifecycle.
groups=collections.defaultdict(list)
for t in ledger:
    groups[(t['frame'],t['method'],'all')].append(t)
    groups[(t['frame'],t['method'],t['signalFamily'])].append(t)
breakdown=[]
for (frame,method,family),ts in groups.items():
    wins=[t for t in ts if t['netReturn']>0]
    breakdown.append(dict(frame=frame,method=method,family=family,trades=len(ts),netWinRate=len(wins)/len(ts),grossPositiveNetNonPositive=sum(t['gross']>0 and t['netReturn']<=0 for t in ts),meanNetBps=10000*statistics.mean(t['netReturn'] for t in ts),meanR=statistics.mean(t['rMultiple'] for t in ts),exitReasons=dict(collections.Counter(t['reason'] for t in ts)),directionCounts=dict(collections.Counter(t['direction'] for t in ts))))
(OUT/'run/failure-breakdown.json').write_text(json.dumps(breakdown,ensure_ascii=False,indent=2))

lines=['# 三类图表形态深度审计与收益复核','',
'2026-09-27 · 代码版本与输入 SHA 已冻结 · 结论基于本项目缓存及官方补齐的资金费','',
'**结论：本次没有找到足以采用的盈利参数。量价共振有可复现的规则错误；修正它们改善了短周期亏损，却没有创造稳定盈利，并且在 4 小时上明显退化。形态检测、历史状态和可执行策略必须分开评价。**','',
'主研究使用 BTC、ETH 的 1m、5m、4h 六组行情，共 120,502 根已闭 K 线，逐根记录首次出现的信号。不同周期覆盖重叠行情，不是六份独立市场样本。原版源文件和打包检测器已保留，比较没有把修改后规则冒充为原规则。','',
'## 结果如何读','',
'下面是明确执行模型的模拟净收益，不是图形“触及目标率”：每个币种各分一半初始资金；各自单仓、1 倍名义敞口、按自身权益复利。首次实时可知的确认信号在下一根开盘成交，双边各 5bp 手续费和 1bp 滑点，计入实际历史资金费。采用原几何风险位与 T1，48 根内离场，同柱止损止盈按先止损。同柱相反方向冲突放弃、同方向按固定 ID 顺序选一个可成交信号。未使用杠杆放大、D 点回填成交或最终幸存者筛选。','',
'胡子原“结构失效”有收盘语义，本研究统一采用几何风险位触及即止损。因此这些数字属于本报告执行方案，不代表形态作者完整交易方法。','',
'每个区间最后 47 根不再开新仓，确保完整 48 根评价期；训练/验证/测试也独立清仓开始，不能把分段百分比直接相加成全期结果。4h 的 48 根等于 8 天，和日内周期有不同经济含义；此处仅统一以柱数计时。','',
'| 方法 | 1 分钟：净收益 / 交易数 | 5 分钟：净收益 / 交易数 | 4 小时：净收益 / 交易数 |',
'|---|---:|---:|---:|']
for k in keys:lines.append('| '+names[k]+' | '+' | '.join(f"{pct(x['frames'][fr]['results']['all'][k]['return'])} / {x['frames'][fr]['results']['all'][k]['trades']}" for fr in x['frames'])+' |')
lines+=['','1m/5m 原数据覆盖 2026-08-19 至 09-22；4h 覆盖 01-15 至 09-22，剔除抓取时未闭的最后一根。每组前 250 根预热，4h 实际交易观察从约 02-26 开始。长期资金费通过 Binance 公开 API 补齐，每币种 753 个事件；manifest 保存边界、URL、时间和 SHA。','',
'4h 谐波的 +3.76% 只有 14 笔，最后测试段仅 2 笔且亏损，不能认定为稳定优势。4h 修复版 -11.16% 更说明：严格符合“双背离/确认柱放量”的语义，与“收益更好”是两个问题。本轮保留原默认阈值，没有将搜索出来的参数写进产品默认。','',
'![累计净值与成本敏感性](performance.png)','',
'图中 0bp 仅指手续费和滑点为零，资金费仍保留；曲线为每日末权益，最大回撤则由完整逐柱收盘权益计算，含未实现损益，不是仅按平仓时点。它仍不等同于分钟内或逐笔最大回撤。','',
'## 时间隔离检验与优化是否成立','',
'本轮按时间 60% 训练、20% 验证、20% 测试；候选在运行前固定为 18 组：确认量比 {1.2, 1.5} × 最低 T1 R {0.45, 0.75, 1.0} × 最低毛目标距离 {0, 12, 24}bp。没有根据测试集再回头改门槛。候选须训练期合计至少 30 笔、每币种至少 10 笔且各自净收益为正，再按最差币种收益优先排序。本轮这只是基本研究门槛，达到门槛也不等于统计显著。','',
'**三个周期均无候选通过这一资格门槛。** 另外做了 3 次扩展训练窗、随后向前检验，三个周期的各次选择也都没有合格候选；此时返回不交易，不为获得一个“最优策略”而强行挑出赢家。','',
'以下列出单纯按训练期总收益挑出的最高组合，仅用于展示选择偏差，不是推荐参数：','',
'| 周期 | 量比 / 最低R / 毛目标bp | 训练收益（交易数） | 验证收益（交易数） | 测试收益（交易数） |',
'|---|---|---:|---:|---:|']
for fr,f in x['frames'].items():
    z=f['optimization']['diagnosticBestTrain'];c=z['candidate'];v=z['validation'];t=z['test']
    lines.append(f"| {fr} | {c['minVolumeRatio']} / {c['minRiskReward']} / {c['minRewardBps']} | {pct(z['trainReturn'])}（{z['trainTrades']}） | {pct(v['return'])}（{v['trades']}） | {pct(t['return'])}（{t['trades']}） |")
lines+=['','5m 训练最优 +1.65%，验证 -0.74%、测试 -0.93%；4h 的训练 +11.39% 来自 6 笔，之后验证 -4.84%。这正是不能把 Gemini 从多个试验里找到的“最好结果”直接当作新形态优势的原因。没有找到其原始候选集合、尝试次数、切分和成交台账，因此本报告不猜测或复述它的原始收益率。','',
'默认规则在最后 20% 时间段的结果：','',
'| 方法 | 1m 测试收益 / 笔数 | 5m 测试收益 / 笔数 | 4h 测试收益 / 笔数 |','|---|---:|---:|---:|']
for k in keys:lines.append('| '+names[k]+' | '+' | '.join(f"{pct(x['frames'][fr]['results']['test'][k]['return'])} / {x['frames'][fr]['results']['test'][k]['trades']}" for fr in x['frames'])+' |')
lines+=['','这些历史行情已被之前的识别研究使用，所以只能称“本轮参数选择的时间隔离测试”，不能称从未触碰过的独立样本外。指标消融、18 组参数及多个退出方案共享行情，不是独立证据。三日时间块 bootstrap 的区间只是对日均收益波动的描述；没有把它包装成多重检验校正后的显著性，也没有在未知原始试验次数时声称计算出可信 PBO/DSR。','',
'## 三种形态各自的问题','',
'**胡子：更接近可交易的突破结构，但基础突破优势不足。** 它组合三角形、楔形、双顶底、头肩和通道旗形，使用确认拐点及收盘突破；多尺度/去噪让召回增加，也让相邻形态高度相关。在独立固定起点检查的 508 个样本中，16 个确认时已越目标；中位剩余 R 约 0.874。即便有足够剩余空间，5m 的零手续费/零滑点结果仍为 -6.64%，说明不能把全部失败归因于成本。','',
'**谐波：最主要的问题是确认延迟吞掉反转收益。** 末端 D 右侧 K 线闭合后才知道 D，几何目标却仍从 D 出发。独立固定起点 133 个真实样本中，70 个（52.6%）在可成交时已越 T1，28 个（21.1%）已越 T2；剩余 T1 R 中位 -0.013、T2 中位 0.392。D 点画得很准，不等于能在那里成交。提前 PRZ 触价交易可以另立假设，但必须把当时尚未成为谐波的失败候选也纳入；不能借最终完成形态反向选早期入场。','',
'**量价共振：是前两类结构的过滤器，尚未证实为独立盈利形态。** EMA、RSI、MACD 都来源于价格，彼此相关；“双指标同意”不等于两个独立概率证据。原版把一些头肩反转也划入顺势分支，并以宽松的任意锚点/任意量能事件增加通过率。更严格之后交易变少，短周期成本下降，但4h表现恶化，因此不存在本轮证据支持的跨周期统一最佳阈值。','',
'## 指标失效：哪些已经证实、哪些已经修复','',
'1. **伪双背离已修。** 原版只见 RSI/MACD 改善就可通过，未要求价格创新低/新高；还可能把两个不同极值对的证据拼成双背离。隔离例：价格低点 90→95，RSI 25→35，原版仍叫“双底背离”。新版要求同侧价格新极值、同一对锚点、RSI 差和 MACD 线同时满足。','',
'2. **量能门控绕过已修。** 原版允许确认柱/前柱/陈旧锚点三者最大量比，或相邻两柱增长 1.15 倍通过；即使用户设置 3 倍阈值，也可由相邻 10→12 的成交量绕过。新版仅以确认柱量/SMA20 执行所设阈值，文案同步。以下只计即时信号，迟现样本未混入分母：','',
'| 周期 | 原版即时过门数 | 其中确认量比 <1.2 | 占比 |','|---|---:|---:|---:|']
for fr,f in x['frames'].items():
    passed=sum(d['diagnostics']['freshLegacyPass'] for d in f['datasets']);bypass=sum(d['diagnostics']['freshVolumeBypass'] for d in f['datasets'])
    lines.append(f'| {fr} | {passed} | {bypass} | {bypass/passed:.1%} |')
lines+=['','这一统计衡量原版名称/阈值语义与实际门控的差异，不代表这些被绕过的信号必然亏损。','',
'3. **预热、平盘 RSI、输出池与目标状态已修。** 平盘 RSI 原版第14柱可能从50跳100；新版保持50，未预热指标为不可用。HSCP 原来把展示层默认隐藏失败与最多200条抽样带入检测输出；新版与上游统一为可显式保留失败历史的检测池，最多1000条。为胡子扩出T2时不再继承原T1触及状态。原无对应执行实现的“T1减半推保本、T2追踪”建议已移除。','',
'4. **胡子 closedLength 边界已修。** 原接口可读取显式闭柱范围之后的数据；现在先规范为闭柱前缀加时间哨兵。本研究原版也用物理截断前缀，故未把这个错误用来抬高原版收益。','',
'5. **滑窗历史回填未完成架构修复，回测已经隔离。** 5m 合计156条、1m合计924条在后来的窗口才出现，却带过去的 confirmedAt。BTC Cypher 例中，旧低点76510被裁出后，先前不够低的76512.9成为新锚点；到第2329柱才出现，却标为第1055柱确认，晚1274柱。首次出现账本剔除全部 delayBars>0，绝不按旧时间回填交易。最终解决需持久化流式拐点/确认状态，并分开记录首次观察时间与结构参考时间；扩大lookback不构成证明。','',
'6. **真实缺柱与合法休市仍需市场日历。** 新增连续性规则如果无差别拒绝时间间隔，会破坏A股午休、跨夜和周末。本轮保留胡子合法交易柱行为；量价共振默认按交易柱推进，只在研究显式声明 requireContinuousTime=true 时按24/7检查。非法OHLC、重复/倒退时间仍阻断。完整跨市场缺口处理尚未解决，不能把加密币研究直接搬到A股。','',
'7. **结构最终失效 ≠ 交易亏损。** 固定起点样本中，胡子96条、谐波70条先触末目标，之后才结构失效；它们不能被直接记为“指标预测失败”。本报告另存真实执行退出原因、净胜率、成本侵蚀和形态家族明细。','',
'## 成本、门控和退出管理的具体影响','',
'5m 修复版在零手续费/零滑点（仍计资金费）时 +2.90%；名义往返6bp时 -1.69%，12bp时 -6.08%，24bp时 -14.28%。小的毛优势不足覆盖交易摩擦。门控改成“更高胜率”也不能跳过价格距离：在恰好R=0.45、只触T1或止损的简化模型中，零成本盈亏平衡胜率为 1/(1+0.45)=68.97%。若风险距离0.2%，T1只有0.09%，而往返成本约0.12%，连触及T1的单笔也可能净亏。','',
'5m 消融（全期，同一执行模型，单仓约束使不同分支收益不能相加）：','',
'| 配置 | 笔数 | 净收益 | 净胜率 | 盈利因子 |','|---|---:|---:|---:|---:|']
for k,label in [('hscp-v2','完整修复规则'),('v2-no-volume','去掉量能门槛'),('v2-no-rr','去掉最低R门槛'),('v2-single-divergence','双背离放宽为单指标'),('v2-continuation','只取顺势分支'),('v2-reversal','只取反转分支')]:
    z=x['frames']['5m']['results']['all'][k];lines.append(f"| {label} | {z['trades']} | {pct(z['return'])} | {z['winRate']:.1%} | {num(z['profitFactor'])} |")
lines+=['','量能门控在此5m样本有减亏作用，但4h去掉它反而减亏；最低R=0.45也没有显示稳定增益。RSI/MACD严格双背离在5m比单指标少亏，在4h却更差。不要把某一单元格的胜利当成通用指标有效性。初值对照分别交换原/新规则所用成熟指标序列，所有主结果完全相同，因此本轮收益变化主要来自门控语义，不是 EMA/RSI 初值差。','',
'分批退出专门按可执行规则复核：T1减半，剩余仓的保本止损从下一根起生效，保本价为入场成交价但仍需出场成本；T2固定目标，未伪造追踪逻辑。5m 原版从 -20.88% 变为 -20.20%，修复版从 -6.08% 变为 -6.17%；4h原版从 +0.15% 变为 +4.52%，修复版从 -11.16% 变为 -10.39%。收益不稳定，不能保留“这样管理必然更好”的暗示。','',
'| 周期 | 方法 | 实际交易数 | 毛盈利但净不盈利的笔数 | 实际净亏/持平率 |','|---|---|---:|---:|---:|']
for z in breakdown:
    if z['family']=='all':lines.append(f"| {z['frame']} | {names[z['method']]} | {z['trades']} | {z['grossPositiveNetNonPositive']} | {1-z['netWinRate']:.1%} |")
lines+=['','这是该固定执行模型的结果，不是形态自身的“自然失效率”；家族、方向、退出原因完整数据见 [failure-breakdown.json](run/failure-breakdown.json)。','',
'## 应采用的优化路线','',
'先修研究可信度：为图表输出补持久化首次观察时间/不可变流式确认状态，统一市场日历与缺柱语义，再谈实盘信号。绘图锚点、确认时间、首次发现时间和成交时间应作为四个独立字段。当前报告已提供反例与可复现脚本，不能把这一项记作已完成。','',
'把顺势突破和极值反转分开研究，并按市场/周期冻结规则。对谐波优先研究“确认后尚有多少可成交空间”，而不是进一步堆 RSI/MACD；若研究早期PRZ入场，必须从当时全部候选出发重新建样本。','',
'把绝对目标距离、预期手续费/滑点、波动与执行延迟纳入交易层。RR仅衡量比例，无法保护很小的目标距离。本轮24bp目标过滤+R1虽在5m比原版少亏，验证仍亏，暂不作为默认参数。资金管理可降低损失幅度，不能把负期望转正。','',
'下一次证据应来自未被现有研究使用的新时期和更多独立标的，并在查看结果前冻结候选、执行模型及失败判据。保留包括失败组合在内的全试验台账；当前没有充分信息恢复Gemini先前的尝试次数。对多次搜索后“最佳回测”的风险，参见原始研究 [Probability of Backtest Overfitting](https://carmamaths.org/resources/jon/backtest2.pdf) 与 [Deflated Sharpe Ratio](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)。本报告引用其研究原则，没有声称已计算这两个统计量。','',
'## 复现、代码和验证','',
'本轮代码修复集中于 `src/lib/patterns/confluence.ts` 与 `src/lib/patterns/huzi.ts`，保留默认阈值。未接实盘、未提交订单。研究以脚本和文件保存，原工作区其他未提交修改未被重置。','',
'- [逐笔交易 CSV](run/trades.csv) / [完整模拟交易](run/trade-ledger.json) / [汇总、分段、候选评分、时间块区间](run/evaluation.json)。',
'- [量价共振代码审计](../confluence-code-audit-2026-09-27.md)、[结构/历史回填审计](../pattern-structure-audit-2026-09-27.md)、[数据与原始证据审计](../pattern-data-audit-2026-09-27.md)。',
'- `run/*-signals.json` 保存首次观察信号账本，`baseline-manifest.json` 和源文件/数据hash支持复算。',
'- 数据/资金费hash、币种时间轴、闭柱边界均在研究脚本中校验；248次切断未来行情后的门控重算与全量因果特征逐字段相同。',
'- 15项成交模型手算测试；另有5000条随机路径检查费用分解/部分退出/最终净值守恒。',
'- 最终相关测试29文件331项通过；`npm run check` 无错误/无警告；`npm run build` 成功，保留现有打包体积提示。','',
'在仓库根目录复算：','',
'```bash',
'node scripts/research/pattern-signal-replay.mjs BTCUSDT 1m',
'node scripts/research/pattern-signal-replay.mjs ETHUSDT 1m',
'node scripts/research/pattern-signal-replay.mjs BTCUSDT 5m',
'node scripts/research/pattern-signal-replay.mjs ETHUSDT 5m',
'node scripts/research/pattern-signal-replay.mjs BTCUSDT 4h',
'node scripts/research/pattern-signal-replay.mjs ETHUSDT 4h',
'node scripts/research/pattern-evaluation.mjs',
'.jev-research.local/bin/python scripts/research/pattern-report.py',
'```','',
'若OHLC、冻结原版或资金费与manifest不一致，脚本会停止，而不会静默混用新旧数据。仍未建模真实盘口冲击、交易延迟分布、精确最小下单量/价格步进；5bp/1bp是研究假设，不代表用户账户实际费率。所有收益仅限上述市场、样本和规则；不外推到A股或其他资产。','']
(OUT/'report.md').write_text('\n'.join(lines))
print('Saved report.md, performance.png/svg, run/failure-breakdown.json')
