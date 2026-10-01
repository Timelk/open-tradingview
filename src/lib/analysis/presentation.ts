import type {AnalysisEvent,AnalysisObservation} from './types';

/** Presentation only. Never promote an observation or infer a missing event. */
export type AnalysisKind='order-block'|'fvg'|'zone'|'structure'|'vsa'|'candlestick'|'wyckoff'|'wave'|'cycle'|'ict';
export function analysisKind(item:AnalysisObservation):AnalysisKind {
  if(item.id.startsWith('order-block:'))return 'order-block';
  if(item.id.startsWith('ict:'))return 'ict';
  if(item.family==='supply-demand')return item.name.startsWith('FVG')?'fvg':'zone';
  if(item.family==='smc')return 'ict';
  return item.family;
}
export interface AnalysisStatus {key:string;label:string;description:string}
export function analysisStatus(item:AnalysisObservation):AnalysisStatus {
  const kind=analysisKind(item);
  if(item.state==='invalidated')return {key:'invalidated',label:kind==='fvg'?'已回补':'已失效',description:'已发生撤销条件；保留图形用于复盘。'};
  if(item.dataWarning)return {key:'limited',label:'覆盖受限',description:'后续数据或核验范围不足，当前有效性不能确定。'};
  if(item.trackingEndedAt!==undefined)return {key:'ended',label:'历史记录',description:'观察已经结束；这段记录不再持续跟踪。'};
  if(item.ruleVersion.startsWith('gann-'))return {key:'reference',label:'手动标尺',description:'由手动锚点与价时单位生成的参考线。'};
  if(item.ruleVersion.startsWith('hurst-'))return {key:'estimate',label:'周期估计',description:'历史窗口拟合结果，不表示未来确定发生。'};
  if(item.ruleVersion.startsWith('point-figure/'))return item.zone&&item.lines?.some(line=>line.role==='projection')
    ?{key:'reference',label:'计数测量',description:'固定格值下的区间测量，不代表目标已经确认。'}
    :{key:'observing',label:'已构列 · 待计数',description:'价格列已建立，但当前范围尚无合格水平计数。'};
  if(item.state==='observing')return {key:'observing',label:'观察中',description:'仍有条件待验证；请查看“接下来观察什么”。'};
  if(kind==='order-block'||kind==='ict'&&item.zone){
    if(item.events.some(event=>event.kind==='mitigation'))return {key:'mitigated',label:'达到回访深度',description:'已触及设定的区域深度，未触发失效条件。'};
    if(item.events.some(event=>event.kind==='revisit'))return {key:'revisited',label:'已回访',description:'价格已经进入区域，继续观察深度与远端边界。'};
    return {key:'fresh',label:'等待回访',description:'区域已建立；尚未记录到后续价格进入区域。'};
  }
  if(kind==='fvg')return {key:'established',label:'尚未完全回补',description:'三柱价差已成立；尚未记录完全回补。'};
  if(kind==='zone')return {key:'established',label:'区域已建立',description:'推进前基底形成参考区域，继续观察边界。'};
  if(kind==='wyckoff')return {key:'confirmed',label:'已观察到突破',description:'突破事件已记录；吸筹或派发仍是解释假设。'};
  return {key:'confirmed',label:kind==='vsa'?'量价已记录':'事件已记录',description:'已收盘数据符合该事件的规则，不代表后续方向确定。'};
}

export function analysisChartName(item:AnalysisObservation):string {
  const kind=analysisKind(item);
  if(kind==='order-block')return item.direction==='bullish'?'OB · 看涨订单块':'OB · 看跌订单块';
  if(kind==='fvg')return item.direction==='bullish'?'FVG · 看涨价差':'FVG · 看跌价差';
  if(kind==='vsa')return `VSA · ${item.name}`;
  return item.name;
}

export type AnalysisEventMarker='diamond'|'circle'|'square'|'cross';
export function analysisEventMarker(event:Pick<AnalysisEvent,'kind'>):AnalysisEventMarker {
  if(event.kind==='invalidation')return 'cross';
  if(event.kind==='mitigation')return 'square';
  if(['activation','breakout','mss','confirmation'].includes(event.kind))return 'diamond';
  return 'circle';
}

const guides:Record<AnalysisKind,{title:string;description:string;reading:string}>={
  'order-block':{
    title:'Order Block 是怎样建立的？',
    description:'先有推进和收盘结构破位，再回看之前的反向蜡烛作为基底。矩形表示这个基底的价格范围。',
    reading:'虚边基底在左，实底区域从建立柱延伸；菱形是建立事件，圆点是回访，方块是达到设定深度，叉号是失效。'},
  fvg:{
    title:'FVG 是什么？',
    description:'第一根与第三根已收盘 K 线的影线区间没有重叠，形成三柱价格缺口。',
    reading:'斜纹矩形是价差范围；完全回补后显示“已回补”。向上或向下描述形成方向。'},
  zone:{
    title:'供需区域怎样读？',
    description:'以强推进之前的小实体基底划定价格范围，供给区与需求区分别记录向下和向上的推进。',
    reading:'边框和浅色底显示价格范围；收盘穿越区域远端后，该区域失效。'},
  structure:{
    title:'结构事件怎样读？',
    description:'BOS 表示收盘突破已知波段位；CHoCH 表示相对先前结构方向发生变化。扫过后回收只记录越界再返回。',
    reading:'水平线连接参考波段与事件柱，菱形表示破位；圆点表示扫过或波段点。HH/HL 是更高高点/低点，LH/LL 是更低高点/低点。'},
  vsa:{
    title:'量价观察在比较什么？',
    description:'比较相对成交量、K 线振幅与收盘位置，记录高量窄幅、高量宽幅或低量测试现象。',
    reading:'金色短柱标记对应事件 K 线。名称描述已发生的量价现象，后续反应在详情中继续观察。'},
  candlestick:{
    title:'K 线形态怎样读？',
    description:'根据已收盘蜡烛的实体、影线和先行趋势记录几何形态。',
    reading:'标记定位形态所在 K 线；向上、向下或中性是形态方向，具体条件在支持依据中。'},
  wyckoff:{
    title:'威科夫区间怎样读？',
    description:'把区间边界、测试、越界收回和突破串成事件序列，阶段名称表示一种解释。',
    reading:'框线显示区间，点标记实际事件；“观察中”表示假设仍待验证，突破后也不确认参与者意图。'},
  wave:{
    title:'波浪计数怎样读？',
    description:'将实际确认的波段点连接为计数，并保留主解释与备选解释。',
    reading:'结构线连接实际锚点，虚线用于未确认结构或投射；选中后查看锚点编号与后续条件。'},
  cycle:{
    title:'周期与价时标尺怎样读？',
    description:'Hurst 使用历史窗口估计周期；Gann 使用明确的手动锚点与价格时间单位建立标尺。',
    reading:'虚线表示估计或投射参考，不等于待成交信号；详情显示计算依据与适用范围。'},
  ict:{
    title:'ICT 事件组合怎样读？',
    description:'依次观察已完成会话参考位的越界收回、方向推进与结构转向，再记录 FVG 或 OB 区域。',
    reading:'观察中表示事件链尚未完成；区域建立后，再分别跟踪回访、设定深度与失效。'},
};
export function analysisGuide(item:AnalysisObservation){
  if(item.ruleVersion.startsWith('point-figure/'))return {
    title:'点数图计数怎样读？',
    description:'将收盘价格按固定格值构成 X 上涨列与 O 下跌列，再对共同价格行进行水平计数。',
    reading:'框线是计数区间，虚线是算术测量参考；列数不同于 K 线根数，测量不保证价格触及。'};
  return guides[analysisKind(item)];
}

export interface AnalysisBrief {
  summary:string;
  action:string;
  projection:string;
}

const briefsByName:Record<string,AnalysisBrief>={
  'Pin Bar 下影':{
    summary:'长下影锤子线 / 看涨 Pin Bar，代表下方出现明显承接、空头下探受阻的拒绝信号。',
    action:'盘中价格一度大幅下探创出低点，但买盘在低位迅速反扑，将收盘价推回 K 线上部，留下修长下影线与较小实体。',
    projection:'常见于下跌末段或关键支撑位附近，预示短线止跌企稳或反抽。后续若突破该 K 线高点，反弹延续概率提高；若收盘跌破下影线最低点，则下探拒绝失效。',
  },
  'Pin Bar 上影':{
    summary:'长上影射击之星 / 看跌 Pin Bar，代表上方抛压沉重、多头冲高受阻的拒绝信号。',
    action:'盘中多头一度向上强力拉升，但在高位遭遇集中卖盘打压，收盘价大幅回落至 K 线下部，留下修长上影线与较小实体。',
    projection:'常见于上涨末段或关键阻力位附近，预示短线见顶回落或回调。后续若跌破该 K 线低点，调整往往延续；若收盘站上上影线最高点，则上方抛压被消化、形态失效。',
  },
  'Engulfing 看涨吞没':{
    summary:'阳包阴看涨吞没形态，代表多头力量在单根 K 线内彻底扭转前一根阴线的跌势。',
    action:'前一根 K 线收阴下跌，当前 K 线开盘后买盘强势发力，阳线实体完全包裹前一根阴线实体，并以接近高点收盘。',
    projection:'通常预示下跌动能衰竭、多头重新掌握主动权。常见走法是顺势开启波段反弹，或回踩吞没阳线实体中位不破后继续上行；若收盘跌破本形态最低点，则看涨反转失效。',
  },
  'Engulfing 看跌吞没':{
    summary:'阴包阳看跌吞没形态，代表空头力量在单根 K 线内彻底反噬前一根阳线的涨势。',
    action:'前一根 K 线收阳上涨，当前 K 线冲高乏力后卖盘集中涌出，阴线实体完全吞没前一根阳线实体，并以接近低点收盘。',
    projection:'通常预示上涨动能受阻、空头夺回短线主导权。常见走法是直接延续回落，或反抽吞没阴线实体中位受阻后再度下行；若收盘突破本形态最高点，则看跌反转失效。',
  },
  'Morning Star 晨星':{
    summary:'三 K 线底部反转组合（早晨之星），展现空头由强转弱、多头接管盘面的完整换手过程。',
    action:'第 1 根长阴顺势下杀；第 2 根实体明显收窄，显示低位抛压衰竭、多空短暂僵持；第 3 根长阳发力上攻，收盘深入第 1 根阴线实体中点上方。',
    projection:'属于经典的阶段见底形态，后市常伴随波段反弹或趋势转多。回调不破中间星线最低点时偏多看待；若收盘跌破星线低点，则底部结构失效。',
  },
  'Evening Star 暮星':{
    summary:'三 K 线顶部反转组合（黄昏之星），展现多头由强转衰、空头反扑控盘的完整转折过程。',
    action:'第 1 根长阳顺势拉升；第 2 根实体明显收窄，显示高位追涨乏力、滞涨信号显现；第 3 根长阴向下砸盘，收盘跌破第 1 根阳线实体中点下方。',
    projection:'属于经典的阶段见顶形态，后市常伴随波段回调或趋势转空。反抽不破中间星线最高点时偏空看待；若收盘突破星线高点，则顶部结构失效。',
  },
  'Doji 十字星':{
    summary:'开盘价与收盘价几乎持平的十字星，代表多空双方在该位置剧烈交锋后暂时达成平衡。',
    action:'盘中价格向上、向下均出现试探并留下上下影线，但多空均未能守住日内战果，最终收盘回到开盘价附近。',
    projection:'属于典型的犹豫与变盘信号。若出现在单边趋势末段，常预示原有动能放缓，需等待后续 K 线突破十字星高点（看多）或跌破十字星低点（看空）来确认方向。',
  },
  '扫过前高后回收':{
    summary:'前高流动性清扫 / 假突破（Liquidity Sweep High），代表价格刺穿前高后未能站稳便迅速跌回。',
    action:'K 线最高价向上越过前期波段高点（触发上方突破买单或空头止损），但买盘后继乏力，收盘价重新跌回前高水平线下方，留下上方刺穿影线。',
    projection:'常见于震荡区间上沿或阶段顶部，俗称“诱多假突破”。后续常向区间下沿或下方支撑位回落；若后续 K 线实体收盘重新站上前高，则假突破预期失效，转为真突破。',
  },
  '扫过前低后收复':{
    summary:'前低流动性清扫 / 假跌破（Liquidity Sweep Low），代表价格刺穿前低后迅速获得承接并收复。',
    action:'K 线最低价向下跌穿前期波段低点（触发下方止损单或追空盘），但低位承接买盘迅速涌入，将收盘价拉回前低水平线上方，留下下方刺穿影线。',
    projection:'常见于震荡区间下沿或阶段底部，俗称“诱空破底翻”。后续常向区间上沿或上方阻力位展开反弹；若后续 K 线实体收盘跌破该清扫低点，则止跌预期失效。',
  },
  'HH':{
    summary:'更高高点（Higher High），是上升趋势中波段峰值不断抬升的核心结构锚点。',
    action:'价格上攻创出高于前一个波段高点的新峰值，随后右侧 K 线回落，确认该高点成为阶段性拐点。',
    projection:'确认当前大结构偏多。冲高确认 HH 后通常伴随正常的获利回吐，重点观察回踩能否在前低上方企稳形成更高低点（HL），从而延续多头排列。',
  },
  'HL':{
    summary:'更高低点（Higher Low），是上升趋势中回调底部不断垫高的关键防守锚点。',
    action:'价格经历回调后在前一个波段低点上方止跌企稳，右侧 K 线重新回升，确认该低点成为有效支撑拐点。',
    projection:'表明买盘在更高价位积极承接。常见推测是依托该 HL 支撑继续向上冲击前高（尝试打出新的向上破位与 HH）；若后续收盘跌破该 HL，则会触发向下结构转向。',
  },
  'LH':{
    summary:'更低高点（Lower High），是下降趋势中反弹高点不断下移的关键压力锚点。',
    action:'价格反弹未能触及前一个波段高点便提前受阻，右侧 K 线掉头向下，确认该高点成为有效阻力拐点。',
    projection:'表明卖盘在更低价位主动压制。常见推测是受制于该 LH 压力继续向下击穿前低（尝试打出向下破位与 LL）；若后续收盘突破该 LH，则会触发向上结构转向。',
  },
  'LL':{
    summary:'更低低点（Lower Low），是下降趋势中波段谷底不断下探的核心结构锚点。',
    action:'价格下探创出低于前一个波段低点的新谷底，随后右侧 K 线反抽，确认该低点成为阶段性拐点。',
    projection:'确认当前大结构偏空。探底确认 LL 后常出现空头回补反抽，重点观察反抽是否在前高下方受阻形成更低高点（LH），从而延续空头排列。',
  },
  'EQH 等高':{
    summary:'等高双顶 / 相对等高点（Equal Highs），代表价格两次在同一水平附近受阻，上方累积了显著阻力与止损流动性。',
    action:'本轮波段高点与前一个波段高点处于极窄的容差范围内，买盘两次冲关均在此处停滞回落。',
    projection:'通常有两种典型演变：一是作为平顶阻力引发波段回落；二是作为上方“流动性池”吸引价格未来再次上冲刺穿（需防范扫过等高点后的假突破回落，或放量实体突破后的趋势加速）。',
  },
  'EQL 等低':{
    summary:'等低双底 / 相对等低点（Equal Lows），代表价格两次在同一水平附近企稳，下方累积了显著支撑与止损流动性。',
    action:'本轮波段低点与前一个波段低点处于极窄的容差范围内，卖盘两次下砸均在此处获得承接。',
    projection:'通常有两种典型演变：一是作为平底支撑引发波段反弹；二是作为下方“流动性池”吸引价格未来再次下探清扫（需观察刺穿等低点后能否快速收回形成破底翻，还是实体跌破打开下行空间）。',
  },
  '看涨 Order Block':{
    summary:'看涨订单块（Bullish OB），即一轮强势向上破位行情启动前的最后一根反向（阴线）蓄势基底。',
    action:'价格先收出一根下探阴线作为基底，紧接着多头连续发力拉升并向上打破前波段结构，证明该阴线区间存在强力买盘承接。',
    projection:'当未来价格首次回调重新进入该订单块区间（尤其是触及区间上沿或 50% 中位线）时，常作为关键支撑区引发二次企稳上攻；若 K 线实体收盘直接跌穿订单块下沿，则该支撑失效。',
  },
  '看跌 Order Block':{
    summary:'看跌订单块（Bearish OB），即一轮强势向下破位行情启动前的最后一根反向（阳线）派发基底。',
    action:'价格先收出一根上冲阳线作为基底，紧接着空头集中砸盘并向下击穿前波段结构，证明该阳线区间存在强力卖盘压制。',
    projection:'当未来价格首次反抽重新进入该订单块区间（尤其是触及区间下沿或 50% 中位线）时，常作为关键阻力区引发二次受阻回落；若 K 线实体收盘直接站上订单块上沿，则该阻力失效。',
  },
  'FVG 看涨价差区':{
    summary:'看涨公允价值缺口（Bullish FVG），由连续三根 K 线急速拉升留下的未充分换手买盘失衡区。',
    action:'中间第 2 根大阳线强势拔高，导致第 1 根 K 线的最高点与第 3 根 K 线的最低点之间没有发生影线重叠，在盘面上留出一段真空价差。',
    projection:'价格急涨后常有回踩修补失衡的需求。当行情回调进入该 FVG 区间且未跌破缺口下沿时，常获得支撑并延续涨势；若完全回补并收盘跌破缺口下沿，则多头失衡优势消失。',
  },
  'FVG 看跌价差区':{
    summary:'看跌公允价值缺口（Bearish FVG），由连续三根 K 线急速下杀留下的未充分换手卖盘失衡区。',
    action:'中间第 2 根大阴线猛烈下砸，导致第 1 根 K 线的最低点与第 3 根 K 线的最高点之间没有发生影线重叠，在盘面上留出一段下跌真空带。',
    projection:'价格急跌后常有反抽修补失衡的需求。当行情反弹进入该 FVG 区间且未突破缺口上沿时，常遭遇阻力并恢复跌势；若完全回补并收盘站上缺口上沿，则空头失衡压制解除。',
  },
  'Demand 需求区':{
    summary:'多头需求区（Demand Zone），代表强力拉升行情起跳前的窄幅换手筑底区间。',
    action:'价格先在窄幅小实体 K 线内蓄势整理，随后突发大阳线脱离基底向上强力推进，说明该整理区内买盘远大于卖盘。',
    projection:'后续价格回落重返该需求区时，常有买盘再次承接并推动反弹。防守位设在需求区下沿；一旦 K 线收盘跌穿下沿，说明需求已被耗尽，区域失效。',
  },
  'Supply 供给区':{
    summary:'空头供给区（Supply Zone），代表强力杀跌行情起跳前的窄幅换手滞涨区间。',
    action:'价格先在窄幅小实体 K 线内短暂盘整，随后突发大阴线脱离基底向下猛烈宣泄，说明该整理区内潜伏了密集抛压。',
    projection:'后续价格反抽重返该供给区时，常遭遇卖盘再次打压并引发回落。防守位设在供给区上沿；一旦 K 线收盘突破上沿，说明上方抛压已被消化，区域失效。',
  },
  'ICT 向上事件组合':{
    summary:'ICT 看涨猎杀与反转模型，串联了“清扫前一时段低点 → 强势拉升转向 → 留下看涨区域”的完整多头启动链条。',
    action:'价格先向下刺穿前一已完成交易时段（亚盘/伦盘/美盘）的低点完成诱空清扫，随后迅速收回并向上打出强位移与结构转向（MSS），同时在起涨段留下 FVG 或订单块。',
    projection:'属于高辨识度的反转做多结构。常见策略是在结构转向确认后，等待价格回调进入新形成的 FVG 或看涨 OB 区间企稳跟进，上方目标常指向前一时段高点；若跌破清扫低点则全套结构失效。',
  },
  'ICT 向下事件组合':{
    summary:'ICT 看跌猎杀与反转模型，串联了“清扫前一时段高点 → 强势下砸转向 → 留下看跌区域”的完整空头启动链条。',
    action:'价格先向上刺穿前一已完成交易时段（亚盘/伦盘/美盘）的高点完成诱多清扫，随后迅速跌回并向下打出强位移与结构转向（MSS），同时在起跌段留下 FVG 或订单块。',
    projection:'属于高辨识度的反转做空结构。常见策略是在结构转向确认后，等待价格反抽新形成的 FVG 或看跌 OB 区间受阻跟进，下方目标常指向前一时段低点；若突破清扫高点则全套结构失效。',
  },
  '高量窄幅':{
    summary:'高成交量配极窄振幅（Effort No Result 努力无果），代表多空在该价位剧烈换手但价格推进受阻。',
    action:'成交量显著放大（远超近期均量），但 K 线高低点振幅却异常狭小，说明主动进攻一方遭遇了体量相当的反向限价盘强力吸收。',
    projection:'常预示当前趋势动能受阻或正在构筑阶段拐点：若出现在大涨高位，多为抛压暗中派发，警惕滞涨回落；若出现在大跌低位，多为买盘主动承接吸筹，关注随后上破该柱高点的止跌信号。',
  },
  '低量测试候选':{
    summary:'缩量回踩测试（Low Volume Test），用于检验前期支撑或高量区下方的空头浮动抛压是否已经枯竭。',
    action:'价格向下回探前期低点或关键支撑区域，但成交量较近期均量明显萎缩，且 K 线收盘重新拉回中上部，显示下砸缺乏卖盘跟风。',
    projection:'缩量收高说明空头抛压显著减轻，是常见的洗盘结束或二次启动前兆。若随后跟进阳线突破测试柱高点，往往开启新一轮上涨；若随后放量跌穿测试柱最低点，则测试失败。',
  },
  '威科夫 · 吸筹假设':{
    summary:'威科夫底部吸筹模型（Accumulation），描述行情在急跌后通过箱体震荡消化浮筹、逐步构筑底部并向上突破的过程。',
    action:'先由恐慌抛售与自然反弹划定横盘箱体上下沿，随后经历二次测试，并在箱体下沿上演刺穿诱空后迅速收回的“弹簧效应（Spring）”，最终向上突破箱体上沿。',
    projection:'当出现下沿假跌破收回或向上突破箱体并伴随回踩上沿不破时，通常预示震荡筑底结束、波段升势开启；若价格重新跌回箱体深处甚至收盘跌破下沿极值，则吸筹假设失效。',
  },
  '威科夫 · 派发假设':{
    summary:'威科夫顶部派发模型（Distribution），描述行情在急涨后通过高位箱体震荡派发筹码、逐步构筑顶部并向下破位的过程。',
    action:'先由抢购冲高与自然回落划定高位箱体上下沿，随后经历二次测试，并在箱体上沿上演刺穿诱多后迅速跌回的“上冲回落（UTAD）”，最终向下跌破箱体下沿支撑。',
    projection:'当出现上沿假突破跌回或向下跌破箱体下沿且反抽无力时，通常预示高位盘整结束、波段跌势展开；若价格强势收复箱体上沿并站稳前高上方，则派发假设失效。',
  },
  'P&F 水平计数 · 独立测量':{
    summary:'点数图（P&F）箱体水平计数，过滤时间噪音，仅按固定价格格值将走势浓缩为上涨 X 列与下跌 O 列，并用横盘列数测算潜在波幅。',
    action:'价格在一段密集震荡区内反复达到转向标准，形成多列并排的 X 列与 O 列（反映筹码在该价格带充分换手），并在突破列向区间外展开推进。',
    projection:'遵循“横有多长，竖有多高”的因果测量逻辑：横盘累积的列数越多，突破后测算的潜在算术投射空间越大。图中虚线为理论测量参考位，若价格反向跌破或突破计数区间远端边界，则本次计数失效。',
  },
  'Wolfe 五点几何':{
    summary:'沃尔夫浪（Wolfe Wave）五点楔形反转结构，利用通道收敛与第 5 点越界后的回归动能捕捉反转行情。',
    action:'价格交替摆动形成 1-2-3-4 四个收敛通道锚点（1-3 线与 2-4 线构成楔形边界），第 5 点刺穿或贴近 1-3 延长线后出现反向收回信号。',
    projection:'第 5 点确认反转后，理论目标常指向连接第 1 点与第 4 点延伸出的目标斜线（图中虚线）。若价格在反转后重新收盘越过第 5 点极值并持续发散，则五点反转结构失效。',
  },
  'Wolfe 1–4 候选':{
    summary:'沃尔夫浪（Wolfe Wave）1–4 点前置候选结构，楔形通道已初步成型，正在等待第 5 点测试。',
    action:'盘面已依次走出 1、2、3、4 四个交替波段拐点，1-3 连线与 2-4 连线形成收敛楔形，但最后一段第 5 浪尚未完成触及与收回。',
    projection:'当前属于提前观察阶段，不宜过早抢跑。重点观察价格后续向 1-3 延长线靠近（寻找潜在第 5 点）时是否出现假突破收回或反转 K 线；若价格直接反向破坏第 4 点结构，则候选取消。',
  },
  'Elliott 五浪计数':{
    summary:'艾略特（Elliott）五浪推动结构（1-2-3-4-5），刻画顺应主趋势方向的三次推进（1、3、5 浪）与两次回调（2、4 浪）。',
    action:'价格自起点 0 出发，依次完成 5 段波浪推进，且满足核心规则：第 2 浪不破起点 0、第 3 浪不是最短推进浪、第 4 浪未进入第 1 浪价格领地。',
    projection:'完整的五浪推动走完后，通常意味着本级别顺势推进告一段落，后市大概率转入反向三浪（A-B-C）调整或更大级别的回撤修正，需留意第 5 浪末端的滞涨或背离信号。',
  },
  'Elliott ABC 修正':{
    summary:'艾略特（Elliott）三浪修正结构（A-B-C），刻画主趋势途中的逆向调整或阶段性反弹。',
    action:'价格自起点 0 走出 A 浪初段调整、B 浪反向回抽（未破起点 0），随后走出 C 浪完成三段式修正走势。',
    projection:'当 C 浪释放完毕并在关键支撑或比例位企稳时，整个 ABC 调整往往接近尾声，后市常恢复原先的主趋势方向；若 C 浪持续加速破坏结构，则可能演变为新的推动浪。',
  },
  'Elliott 推进计数中':{
    summary:'正在演变中的艾略特（Elliott）1–4 浪结构，前四浪已具雏形，正在观察第 5 浪推进。',
    action:'盘面已完成 1 浪启动、2 浪回撤、3 浪主推与 4 浪整理，当前正处于向第 5 浪方向延伸的阶段。',
    projection:'只要价格守住第 4 浪拐点且不侵入第 1 浪价格区间，顺势走出第 5 浪延续主趋势的概率较高；若价格反向击穿第 4 浪极值或进入第 1 浪领地，则主推动浪计数降级为备选修正浪。',
  },
  'Hurst 周期估计':{
    summary:'赫斯特（Hurst）主导周期拟合，通过对历史去趋势收盘价进行频谱回归，估算当前盘面最显著的韵律周期长度与相位。',
    action:'算法在最近固定闭柱窗口内提取振幅占比最高的周期分量，并在图上绘制历史拟合波形（实线）与向后延伸的参考相位（虚线）。',
    projection:'可用于辅助判断当前处于周期波峰（偏阻力/回调窗口）还是波谷（偏支撑/反弹窗口）。当主周期能量占比高且跨窗口相位漂移小时参考价值较高；若遇单边强趋势突破，周期波峰/波谷容易发生钝化。',
  },
  'Gann 显式价时标尺':{
    summary:'江恩（Gann）价格—时间几何角度线，从选定的关键波段锚点出发，按明确的“每根时间单位对应固定价格步长”绘制 1×1、2×1、1×2 等斜率标尺。',
    action:'以关键拐点为原点，将价格涨跌速度与时间流逝绑定：其中 1×1 线代表价格与时间 1:1 均衡推进的基准趋势线，2×1 线代表陡峭加速线，1×2 线代表缓步支撑/压力线。',
    projection:'价格运行在 1×1 均衡线上方（看涨标尺）或下方（看跌标尺）时代表趋势保持强势；回踩角度线常产生斜率支撑或阻力。若收盘有效跌破或突破某条角度线，往往会向下一级角度线寻求支撑。',
  },
};

export function analysisBrief(item:AnalysisObservation):AnalysisBrief {
  if(item.name==='BOS 收盘破位'){
    return item.direction==='bullish'
      ?{
        summary:'向上结构破位（Bullish BOS），代表上升趋势中多头以实体收盘突破前波段高点，确认趋势延续。',
        action:'价格自波段低点发起上攻，不仅盘中越过前一个确认波段高点（Swing High），且 K 线收盘价稳稳站在该高点之上。',
        projection:'表明当前多头趋势健康延续。常见走法是突破后经历小幅回踩（回抽前高或下方新形成的支撑区），企稳后继续冲击更高高点；若快速深跌并跌破起涨波段低点，则转为假突破或结构转向。',
      }
      :{
        summary:'向下结构破位（Bearish BOS），代表下降趋势中空头以实体收盘跌破前波段低点，确认趋势延续。',
        action:'价格自波段高点向下打压，不仅盘中击穿前一个确认波段低点（Swing Low），且 K 线收盘价收在该低点之下。',
        projection:'表明当前空头趋势持续主导。常见走法是破位后出现技术性反抽（回测前低或上方新形成的压力区），受阻后继续创出更低低点；若强势拉回并突破起跌波段高点，则空头结构动摇。',
      };
  }
  if(item.name==='CHoCH 结构转向'){
    return item.direction==='bullish'
      ?{
        summary:'向上结构转向（Bullish CHoCH），代表原本偏空或震荡的结构首次被多头收盘向上打破，是潜在趋势反转的早期信号。',
        action:'此前行情处于低点下移、高点下移的空头节奏，但本轮反弹力度强劲，K 线实体收盘直接越过了最近一个关键波段高点。',
        projection:'意味着空头防线首次失守，盘面由单边下跌转入筑底或上升初期。常见走法是等待首次回调形成更高低点（HL）后开启主升段；若回调直接跌破前低，则本次转向失败。',
      }
      :{
        summary:'向下结构转向（Bearish CHoCH），代表原本偏多或震荡的结构首次被空头收盘向下击穿，是潜在趋势转空的早期信号。',
        action:'此前行情处于高点上移、低点上移的多头节奏，但本轮下杀力度猛烈，K 线实体收盘直接跌破了最近一个关键波段低点。',
        projection:'意味着多头防守位首次告破，盘面由单边上涨转入派发或下跌初期。常见走法是等待反抽形成更低高点（LH）后展开主跌段；若反抽直接收复并站稳前高，则本次转向失败。',
      };
  }
  if(item.name==='高量宽幅'){
    const closePct=Number(item.evidence.find(entry=>entry.startsWith('收盘位置 '))?.match(/\d+/)?.[0]??50);
    const up=item.direction==='bullish'||(item.direction==='neutral'&&closePct>=50);
    return up
      ?{
        summary:'放量长阳宽幅柱，代表资金大举入场推动价格强势上攻或低位放量反击。',
        action:'成交量显著放大，同时 K 线振幅宽阔且收盘价站稳在 K 线上半部分，呈现量增价涨的强力推进态势。',
        projection:'若出现在盘整突破处，通常确认多头有效突破，回踩该长阳中位或低点不破偏多延续；若出现在连续加速大涨末期，则需防范买盘高潮耗尽，观察次柱能否继续站稳高点。',
      }
      :{
        summary:'放量长阴宽幅柱，代表空头资金集中宣泄推动价格剧烈下杀或高位放量砸盘。',
        action:'成交量显著放大，同时 K 线振幅宽阔且收盘价压制在 K 线下半部分，呈现放量杀跌的强力冲击态势。',
        projection:'若出现在跌破支撑处，通常确认空头有效破位，反抽该长阴中位或高点受阻偏空延续；若出现在连续急跌末期，则需留意恐慌盘集中涌出后的卖盘高潮止跌可能。',
      };
  }
  const direct=briefsByName[item.name];
  if(direct)return direct;
  if(item.ruleVersion.startsWith('point-figure/'))return briefsByName['P&F 水平计数 · 独立测量'];
  const guide=analysisGuide(item);
  return {summary:guide.description,action:guide.reading,projection:analysisStatus(item).description};
}

const BOILERPLATE_COUNTER_EVIDENCE=new Set([
  '不推断未公开订单簿、成交明细或机构意图。',
  '不确认机构买卖意图或订单簿吸收。',
  '高量宽幅既可能为推进，也可能为高潮耗尽，需后续柱确认。',
  '不把几何参考线解释为价格必然触及的目标。',
  '周期估计随窗口变化，不代表未来必然转折。',
  '水平计数是独立价格测量，不确认吸筹 / 派发，不修改形态状态。',
  '算术参考线不是目标承诺；价格可能提前反转或直接穿过。',
  '使用线性价格/绝对时间标尺；它不是自动预测器。',
  '日历月不能用固定柱时长替代；需明确输入绝对 timeUnitMs。',
  '穿越线条只记录测量事件，不产生买入卖出指令。',
  '波段归类不是对未来方向的预测。',
  '这是本平台的波段结构定义；不推断机构意图或挂单。',
  '这是从价格推断的区域，不是已观察到的挂单或真实流动性缺口。',
  '量价现象不等于已识别吸收者身份；不使用成交量代替持仓量。',
  '十字星仅表示当前柱实体较小，不预设反转方向。',
  '长下影不能独立证明反转已经发生。',
  '长上影不能独立证明反转已经发生。',
  '吞没成立于本柱收盘；不等于之后必然上涨。',
  '吞没成立于本柱收盘；不等于之后必然下跌。',
  '三柱组合的方向性需要背景与后续行情验证。',
  '三柱组合不直接代表交易信号。',
  '本平台的可复现价格事件定义，不确认机构持仓、意图或真实挂单。',
  '这是明确规则的公开五点几何子集，未声称复制原作者完整课程。',
  '1–4 投射线不保证触及，也不是自动止盈或下单指令。',
  '浪级和备选计数存在歧义；比例指导不能替代硬规则。',
  '本模块是普通推进与简单 Zigzag 计数，不把对角线、平台或组合修正硬塞入该定义。',
  '周期估计与方向预测分开；分量可能漂移或被其他分量抵消。',
  '解释方差不是准确率；相位窗是启发式范围，不是统计置信区间。',
  '这是 Hurst 风格因果周期分析基础，不等同于原课程完整定相流程。',
]);
const BOILERPLATE_WAITING_FOR=new Set([
  '已收盘确认，无待未来 K 线补齐条件。',
  '结合所在区间与后续收盘反应；本模块不自动生成交易。',
  '结合此前区间与后续推进，验证而非直接推断涨跌。',
  '观察新计数和相反结构，不把完成五浪自动解释为买卖。',
  '继续观察结构边界；几何投射与交易决策分开。',
  '可调整手动锚点与价格/时间单位进行可重复研究。',
]);
export function meaningfulCounterEvidence(item:AnalysisObservation):string[] {
  return item.counterEvidence.filter(entry=>!BOILERPLATE_COUNTER_EVIDENCE.has(entry));
}
export function meaningfulWaitingFor(item:AnalysisObservation):string[] {
  return item.waitingFor.filter(entry=>!BOILERPLATE_WAITING_FOR.has(entry));
}

/** Named canvas tokens: the same geometry works with a user color override. */
export const ANALYSIS_PALETTE=Object.freeze({
  bull:'#64cbb0',bear:'#ef9aa7',neutral:'#9ab9db',volume:'#dec181',wave:'#b3a2e1',
  fvgBull:'#9cb9ee',fvgBear:'#c2a5e6',invalid:'#8e99a8',warning:'#d9b77b',
  ended:'#a1b1c2',background:'#17212b',text:'#e3edf8',markerBackground:'#151d23',
});
