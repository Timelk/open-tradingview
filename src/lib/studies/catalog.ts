import type { IndicatorDef } from '../core/types';
import {translate} from '../i18n';

export type StudyKind = 'indicator' | 'strategy';
export type StudySource = 'builtin' | 'custom';
export type StudySection = StudySource | 'all' | 'favorites' | 'pattern'|'analysis'|'structure'|'wyckoff'|'flow'|'candlestick'|'wave';
export type StudyLibrarySection = 'all'|'builtin'|'pattern'|'analysis'|'favorites';
export interface StudyTag {id:string;label:string;description:string;tone?:'default'|'editable'|'muted'}

/** Older deep links remain valid without recreating a second category tree. */
export function normalizeStudySection(section?:StudySection|string):StudyLibrarySection {
  if(section==='builtin'||section==='pattern'||section==='analysis'||section==='favorites')return section;
  return ['structure','wyckoff','flow','candlestick','wave'].includes(section??'')?'analysis':'all';
}

export interface StudyEntry {
  id: string;
  name: string;
  title: string;
  description: string;
  tags: string[];
  kind: StudyKind;
  category?: IndicatorDef['category'];
  analysisFamily?:IndicatorDef['analysisFamily'];
  source: StudySource;
  target: IndicatorDef['target'];
  searchText: string;

}

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
export type StudyTranslator=(message:string)=>string;
const unchanged:StudyTranslator=message=>message;
/** Registry-owned built-ins may be localized. Extension names remain opaque. */
export function studyDisplayTitle(entry:StudyEntry,localize:StudyTranslator):string {
  return entry.source==='builtin'?localize(entry.title):entry.title;
}
export function studyDisplayName(entry:StudyEntry,localize:StudyTranslator):string {
  return entry.source==='builtin'?localize(entry.name):entry.name;
}
export function studyDisplayDescription(entry:StudyEntry,localize:StudyTranslator):string {
  return entry.source==='custom'?entry.description:localize(entry.description);
}
function searchableEntry(entry:StudyEntry,extra:readonly string[]=[]):StudyEntry {
  const english:StudyTranslator=message=>translate(message,undefined,'en-US');
  entry.searchText=normalize([entry.id,entry.name,entry.title,entry.description,...entry.tags,...studyTags(entry).map(tag=>tag.label),...extra,
    studyDisplayTitle(entry,english),studyDisplayName(entry,english),studyDisplayDescription(entry,english),
    ...studyTags(entry,english).map(tag=>tag.label),...(entry.source!=='custom'?entry.tags.map(english):[]),
  ].join(' '));
  return entry;
}

/** The registry is the catalog. Unannotated plugins remain discoverable as custom indicators. */
export function studyCatalog(definitions: IndicatorDef[]): StudyEntry[] {
  return definitions.map(definition => {
    const entry = {
      id: definition.id,
      name: definition.name,
      title: definition.title?.trim() || definition.name,
      description: definition.description?.trim() || '',
      tags: definition.tags ?? [],
      kind: definition.kind ?? 'indicator',
      category: definition.category,
      analysisFamily:definition.analysisFamily,
      source: definition.source ?? 'custom',
      target: definition.target,
    };
    return searchableEntry({...entry,searchText:''},entry.category==='pattern'?['形态策略','pattern']:[]);
  });
}

const familyLabels:Record<NonNullable<StudyEntry['analysisFamily']>,{label:string;description:string}>={
  classic:{label:'经典形态',description:'识别价格结构与确认条件；观察结构不等于成交委托。'},
  harmonic:{label:'谐波形态',description:'检查摆动与比例关系，区分候选和已确认结构。'},
  confluence:{label:'量价共振',description:'融合顺势收敛突破与双背离极值反转，内置量能点火与初始盈亏比门控。'},
  candlestick:{label:'K线形态',description:'描述蜡烛几何与背景条件，不直接代表交易指令。'},
  structure:{label:'市场结构',description:'分析已确认摆动、结构突破与相关事件。'},
  wyckoff:{label:'威科夫',description:'分析区间和量价事件，保留阶段假设与确认边界。'},
  'supply-demand':{label:'供需区域',description:'按价格行为识别区域；不宣称识别到真实挂单身份。'},
  vsa:{label:'量价分析',description:'展示成交量、振幅和收盘位置的观察证据。'},
  smc:{label:'SMC / ICT',description:'展示结构、区域及会话条件；不推断机构身份或自动下单。'},
  wave:{label:'波浪分析',description:'区分完成结构、发展中计数与备选解释。'},
  cycle:{label:'周期 / 价时',description:'以明确窗口或手动锚点测量周期、时间和价格关系。'},
  flow:{label:'成交分析',description:'根据模块说明区分真实成交统计与K线数据可提供的量能信息。'},
};

// One semantic type per module. More specific measurements take precedence
// over shared aliases (volume MA is volume; RSI/KDJ are oscillators, not MACD).
const standardFamilies=[
  {id:'volume',label:'成交量',aliases:['成交量','量价'],description:'分析成交数量或成交量的平滑变化。'},
  {id:'volatility',label:'波动率',aliases:['波动率'],description:'衡量价格波动幅度、收缩或扩张。'},
  {id:'oscillator',label:'震荡',aliases:['震荡','超买超卖'],description:'在相对范围内衡量强弱或位置，不将超买超卖直接视为反转。'},
  {id:'moving-average',label:'均线',aliases:['均线'],description:'以移动平均展示平滑趋势或均线之间的关系。'},
  {id:'trend-momentum',label:'趋势动量',aliases:['趋势','动量'],description:'衡量趋势方向、变化速度或快慢序列的差异。'},
];

/** Compact capability labels are deliberately independent from search aliases. */
export function studyTags(entry:StudyEntry,localize:StudyTranslator=unchanged):StudyTag[]{
  const detail=studyDisplayDescription(entry,localize).trim(),describe=(meaning:string)=>detail?`${localize(meaning)} ${detail}`:localize(meaning);
  const type=entry.category==='pattern'?'pattern':entry.kind;
  const tags:StudyTag[]=[{id:`kind:${type}`,label:type==='pattern'?'形态分析':type==='strategy'?'策略':'指标',description:describe(type==='pattern'?'在图表识别和绘制形态，不是自动委托策略。':type==='strategy'?'提供策略逻辑或信号展示；挂载图表不会向交易所下单。':'计算并展示图表数据；不直接发出交易委托。'),tone:'default'}];
  const family=entry.analysisFamily??(entry.source==='builtin'&&entry.category==='pattern'?(entry.id==='pattern-harmonic'?'harmonic':entry.id==='pattern-huzi'?'classic':entry.id==='pattern-confluence'?'confluence':undefined):undefined);
  if(family&&familyLabels[family])tags.push({id:`family:${family}`,label:familyLabels[family].label,description:describe(familyLabels[family].description),tone:'default'});
  else if(!entry.category){
    const aliases=new Set(entry.tags.map(normalize)),standard=standardFamilies.find(item=>item.aliases.some(alias=>aliases.has(normalize(alias))));
    if(standard)tags.push({id:`family:${standard.id}`,label:standard.label,description:describe(standard.description),tone:'default'});
  }
  tags.push({id:`placement:${entry.target}`,label:entry.target==='main'?'主图':entry.target==='volume'?'成交量窗格':'副图',description:describe(entry.target==='main'?'叠加到当前价格主图。':entry.target==='volume'?'放置在成交量窗格。':'放置在独立指标窗格。'),tone:'muted'});
  tags.push({id:`source:${entry.source}`,label:entry.source==='builtin'?'内置':'扩展',description:describe(entry.source==='builtin'?'平台原生模块，可按模块提供的参数和样式调整。':'由已注册扩展提供，具体参数取决于扩展。'),tone:'muted'});
  return tags.map(tag=>({...tag,label:localize(tag.label)}));
}

export function filterStudies(entries: StudyEntry[], query: string, section: StudySection, kind: 'all' | StudyKind, favorites: readonly string[]): StudyEntry[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  return entries.filter(entry => (section === 'all'||(section === 'favorites' ? favorites.includes(entry.id) : section === 'pattern' ? entry.category === 'pattern' : section==='analysis'?entry.category==='analysis'||!!entry.analysisFamily&&entry.category!=='pattern':section==='wave'?['wave','cycle'].includes(entry.analysisFamily??''):section==='wyckoff'?['wyckoff','vsa','supply-demand'].includes(entry.analysisFamily??''):section==='structure'?['structure','smc'].includes(entry.analysisFamily??''):['flow','candlestick'].includes(section)?entry.analysisFamily===section:entry.source === section))
    && (kind === 'all' || entry.kind === kind)
    && words.every(word => entry.searchText.includes(word)));
}

export function studyPlacement(target: IndicatorDef['target']): string {
  return target === 'main' ? '主图叠加' : target === 'volume' ? '成交量窗格' : '独立窗格';
}
