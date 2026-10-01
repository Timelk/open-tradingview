import { describe, expect, it } from 'vitest';
import type { IndicatorDef } from '../src/lib/core/types';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import { filterStudies, normalizeStudySection, studyCatalog, studyTags } from '../src/lib/studies/catalog';
import { loadStudyFavorites, saveStudyFavorites, STUDY_FAVORITES_KEY } from '../src/lib/studies/favorites';

const definition = (id: string, metadata: Partial<IndicatorDef> = {}): IndicatorDef => ({ id, name: id.toUpperCase(), target: 'main', inputs: [], calc: () => [], ...metadata });

describe('study library discovery', () => {
  const entries = studyCatalog([
    definition('ma', { title: '移动平均线', description: '观察价格趋势', tags: ['均线'], source: 'builtin' }),
    definition('cross', { title: '均线交叉', kind: 'strategy', source: 'builtin', tags: ['趋势信号'] }),
    definition('custom-study'),
  ]);

  it('searches names and tags across full-width input while respecting the selected kind', () => {
    expect(filterStudies(entries, ' ＭＡ 均线 ', 'builtin', 'indicator', []).map(entry => entry.id)).toEqual(['ma']);
    expect(filterStudies(entries, '趋势', 'builtin', 'strategy', []).map(entry => entry.id)).toEqual(['cross']);
    expect(filterStudies(entries, '均线', 'builtin', 'indicator', []).map(entry => entry.id)).toEqual(['ma']);
  });

  it('keeps unannotated plugins discoverable and favorites usable across catalog sources', () => {
    expect(filterStudies(entries, '', 'custom', 'indicator', []).map(entry => entry.id)).toEqual(['custom-study']);
    expect(filterStudies(entries, '', 'favorites', 'all', ['cross', 'custom-study', 'removed-plugin']).map(entry => entry.id)).toEqual(['cross', 'custom-study']);
    expect(filterStudies(entries, '', 'favorites', 'strategy', ['ma'])).toEqual([]);
  });

  it('discovers pattern strategies by category without losing strategy, search, or favorites behavior', () => {
    const patterns = studyCatalog([
      definition('pattern-huzi', { title: '胡子形态', category: 'pattern', kind: 'strategy', source: 'builtin' }),
      definition('pattern-harmonic', { title: '谐波形态', category: 'pattern', kind: 'strategy', source: 'builtin', tags: ['Gartley', 'Bat'] }),
      definition('cross', { kind: 'strategy', source: 'builtin' }),
    ]);
    expect(filterStudies(patterns, '', 'pattern', 'all', []).map(entry => entry.id)).toEqual(['pattern-huzi', 'pattern-harmonic']);
    expect(filterStudies(patterns, 'gartley', 'pattern', 'strategy', []).map(entry => entry.id)).toEqual(['pattern-harmonic']);
    expect(filterStudies(patterns, '形态策略', 'all', 'strategy', [])).toHaveLength(2);
    expect(filterStudies(patterns, '', 'favorites', 'strategy', ['pattern-huzi']).map(entry => entry.id)).toEqual(['pattern-huzi']);
    expect(filterStudies(patterns, '', 'builtin', 'strategy', [])).toHaveLength(3);
    expect(filterStudies(patterns, '', 'pattern', 'indicator', [])).toEqual([]);
    expect(filterStudies(patterns, '形态分析', 'all', 'all', [])).toHaveLength(2);
  });

  it('shows all three registered pattern families and keeps structure-volume modules in their own section',()=>{
    const registry=new IndicatorRegistry();registerBuiltins(registry);const registered=studyCatalog(registry.list());
    const patterns=filterStudies(registered,'','pattern','all',[]);expect(patterns.map(entry=>entry.id).sort()).toEqual(['pattern-confluence','pattern-harmonic','pattern-huzi']);
    expect(patterns.map(entry=>studyTags(entry).find(tag=>tag.id.startsWith('family:'))?.label).sort()).toEqual(['经典形态','谐波形态','量价共振'].sort());
    const analysis=filterStudies(registered,'','analysis','all',[]);expect(analysis.length).toBeGreaterThan(8);expect(analysis.every(entry=>entry.category!=='pattern')).toBe(true);
    for(const family of ['structure','smc','wyckoff','vsa','supply-demand','wave','cycle','candlestick','flow'])expect(analysis.some(entry=>entry.analysisFamily===family),family).toBe(true);
    expect(filterStudies(registered,'量价共振','pattern','all',[]).map(entry=>entry.id)).toEqual(['pattern-confluence']);
  });

  it('keeps patterns and analysis discoverable while normalizing retired entry points',()=>{
    expect(['all','builtin','pattern','analysis','favorites'].map(normalizeStudySection)).toEqual(['all','builtin','pattern','analysis','favorites']);
    for(const previous of ['structure','wyckoff','flow','candlestick','wave'])expect(normalizeStudySection(previous)).toBe('analysis');
    expect(normalizeStudySection('script')).toBe('all');
    expect(normalizeStudySection('custom')).toBe('all');expect(normalizeStudySection('unavailable')).toBe('all');
    expect(filterStudies(entries,'',normalizeStudySection('custom'),'all',[]).map(entry=>entry.id)).toContain('custom-study');
  });

  it('labels shapes as analysis and native capabilities accurately without exposing every search alias',()=>{
    const entry=studyCatalog([definition('pattern-harmonic',{category:'pattern',kind:'strategy',source:'builtin',description:'已确认的比例结构',tags:['Gartley','Bat','Butterfly','Crab','Cypher','Shark','ABCD']})])[0];
    const tags=studyTags(entry);
    expect(tags.map(tag=>tag.label)).toEqual(['形态分析','谐波形态','主图','内置']);
    expect(tags[0].description).toContain('不是自动委托');expect(tags[0].description).toContain(entry.description);
    expect(tags.find(tag=>tag.id==='source:builtin')?.description).toContain('参数和样式');
    expect(tags.some(tag=>tag.label==='可编辑'||tag.label==='Gartley')).toBe(false);
    expect(studyTags(entries[2]).map(tag=>tag.label)).toEqual(['指标','主图','扩展']);
    const volume=studyCatalog([definition('bar-delta',{source:'builtin',analysisFamily:'flow',target:'volume'})])[0];
    expect(studyTags(volume).map(tag=>tag.label)).toEqual(['指标','成交分析','成交量窗格','内置']);
  });

  it('assigns one concise semantic family using declared aliases and specific-type precedence',()=>{
    const modules=studyCatalog([
      definition('ma',{source:'builtin',tags:['趋势','均线','主图']}),
      definition('ema',{source:'builtin',tags:['趋势','均线','主图']}),
      definition('boll',{source:'builtin',tags:['波动率','通道','主图']}),
      definition('vol',{source:'builtin',tags:['成交量','均线','量价'],target:'volume'}),
      definition('macd',{source:'builtin',tags:['趋势','动量','交叉'],target:'sub'}),
      definition('rsi',{source:'builtin',tags:['震荡','超买超卖','动量'],target:'sub'}),
      definition('kdj',{source:'builtin',tags:['震荡','超买超卖','动量'],target:'sub'}),
      definition('explicit',{source:'builtin',analysisFamily:'flow',tags:['成交量','趋势','均线']}),
    ]);
    expect(modules.map(entry=>studyTags(entry).filter(tag=>tag.id.startsWith('family:')).map(tag=>tag.label))).toEqual([
      ['均线'],['均线'],['波动率'],['成交量'],['趋势动量'],['震荡'],['震荡'],['成交分析'],
    ]);
    for(const entry of modules)expect(studyTags(entry).length).toBeLessThanOrEqual(5);
  });
});

describe('study favorites persistence', () => {
  it('survives save/reopen and deduplicates saved IDs without dropping unavailable plugins', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(saveStudyFavorites(['ma', 'ma', 'removed-plugin'], storage)).toBe(true);
    expect(loadStudyFavorites(storage)).toEqual(['ma', 'removed-plugin']);
    expect(values.has(STUDY_FAVORITES_KEY)).toBe(true);
  });

  it('recovers from invalid storage contents', () => {
    const storage = (value: string) => ({ getItem: () => value, setItem: () => {} });
    expect(loadStudyFavorites(storage('{broken'))).toEqual([]);
    expect(loadStudyFavorites(storage('{"ma":true}'))).toEqual([]);
    expect(loadStudyFavorites(storage('["ma",null,23,"","ma","rsi"]'))).toEqual(['ma', 'rsi']);
  });

  it('retains legacy favorites in storage while showing only registered entries',()=>{
    const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
    saveStudyFavorites(['ma','pine:retired-document','removed-plugin'],storage);const before=values.get(STUDY_FAVORITES_KEY);
    const favorites=loadStudyFavorites(storage),registered=studyCatalog([definition('ma',{source:'builtin'})]);
    expect(filterStudies(registered,'','favorites','all',favorites).map(entry=>entry.id)).toEqual(['ma']);expect(values.get(STUDY_FAVORITES_KEY)).toBe(before);expect(favorites).toContain('pine:retired-document');
  });

  it('reports unavailable persistence so the UI can keep working and explain the limitation', () => {
    const denied = { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('quota'); } };
    expect(loadStudyFavorites(denied)).toEqual([]);
    expect(saveStudyFavorites(['ma'], denied)).toBe(false);
  });
});
