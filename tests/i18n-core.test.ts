import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {get} from 'svelte/store';
import {messages as core} from '../src/lib/i18n/messages-core';
import {messages as shell} from '../src/lib/i18n/messages-shell';
import {messages as library} from '../src/lib/i18n/messages-library';
import {messages as workspace} from '../src/lib/i18n/messages-workspace';
import {messages as analysis} from '../src/lib/i18n/messages-analysis';
const key='tvchart.locale.v1';
let cleanup:()=>void=()=>{};
beforeEach(()=>vi.resetModules());
afterEach(()=>{cleanup();cleanup=()=>{};vi.unstubAllGlobals();vi.restoreAllMocks();});
function storage(initial?:string){const values=new Map<string,string>(initial?[[key,initial]]:[]);const api={getItem:vi.fn((name:string)=>values.get(name)??null),setItem:vi.fn((name:string,value:string)=>{values.set(name,value);})};vi.stubGlobal('localStorage',api);return {values,api};}
async function module(){return import('../src/lib/i18n');}

describe('locale state, persistence and document integration',()=>{
  it('normalizes supported language families without turning arbitrary values into supported locales',async()=>{
    const i18n=await module();
    for(const value of ['zh','zh-CN','ZH-hans','zh-TW'])expect(i18n.normalizeLocale(value)).toBe('zh-CN');
    for(const value of ['en','en-US','EN-gb'])expect(i18n.normalizeLocale(value)).toBe('en-US');
    for(const value of ['',null,undefined,42,'fr-FR','english','zhuang'])expect(i18n.normalizeLocale(value)).toBeUndefined();
  });
  it('loads the stored preference, updates both derived translators immediately and writes only the locale key',async()=>{
    const saved=storage('EN-gb');saved.values.set('user.drawings','用户绘图');const i18n=await module();
    expect(i18n.getLocale()).toBe('en-US');expect(get(i18n.t)('关闭')).toBe('Close');
    const observed:string[]=[];const off=i18n.t.subscribe(t=>observed.push(t('关闭')));
    i18n.setLocale('zh-Hans');expect(i18n.getLocale()).toBe('zh-CN');expect(get(i18n.canonicalT)('关闭')).toBe('关闭');
    i18n.setLocale('en');expect(observed).toEqual(['Close','关闭','Close']);expect(saved.values.get(key)).toBe('en-US');expect(saved.values.get('user.drawings')).toBe('用户绘图');
    expect(saved.api.setItem.mock.calls.every(([written])=>written===key)).toBe(true);
    const calls=saved.api.setItem.mock.calls.length;i18n.setLocale('fr');expect(saved.api.setItem).toHaveBeenCalledTimes(calls);expect(i18n.getLocale()).toBe('en-US');off();
  });
  it('falls back safely with invalid or blocked storage and still allows in-memory switching',async()=>{
    storage('broken-value');let i18n=await module();expect(i18n.getLocale()).toBe('zh-CN');
    vi.resetModules();vi.stubGlobal('localStorage',{getItem(){throw Error('denied');},setItem(){throw Error('quota');}});i18n=await module();
    expect(i18n.getLocale()).toBe('zh-CN');expect(()=>i18n.setLocale('en-US')).not.toThrow();expect(i18n.getLocale()).toBe('en-US');expect(get(i18n.t)('关闭')).toBe('Close');
  });
  it('updates html lang and handles cross-tab changes without reloads, then removes its subscription on cleanup',async()=>{
    const saved=storage('en-US'),root={lang:'',dir:''},listeners=new Map<string,(event:any)=>void>();
    const browser={addEventListener:vi.fn((type:string,listener:(event:any)=>void)=>listeners.set(type,listener)),removeEventListener:vi.fn((type:string,listener:(event:any)=>void)=>{if(listeners.get(type)===listener)listeners.delete(type);}),location:{reload:vi.fn()}};
    vi.stubGlobal('document',{documentElement:root});vi.stubGlobal('window',browser);const i18n=await module();cleanup=i18n.initializeI18n();
    expect(root).toEqual({lang:'en-US',dir:'ltr'});i18n.setLocale('zh');expect(root.lang).toBe('zh-CN');
    listeners.get('storage')!({key:'user.drawings',newValue:'en-US'});expect(i18n.getLocale()).toBe('zh-CN');
    saved.values.set(key,'en-US');listeners.get('storage')!({key,newValue:'en-US'});expect(root.lang).toBe('en-US');
    saved.values.delete(key);listeners.get('storage')!({key:null,newValue:null});expect(root.lang).toBe('zh-CN');
    cleanup();cleanup=()=>{};i18n.setLocale('en-US');expect(root.lang).toBe('zh-CN');expect(listeners.has('storage')).toBe(false);expect(browser.location.reload).not.toHaveBeenCalled();
  });
  it('initializes safely during SSR and treats a blocked global storage getter as unavailable',async()=>{
    vi.stubGlobal('document',undefined);vi.stubGlobal('window',undefined);vi.stubGlobal('localStorage',undefined);
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('SecurityError');}});
    const i18n=await module();expect(()=>i18n.initializeI18n()()).not.toThrow();expect(()=>i18n.setLocale('en-US')).not.toThrow();expect(i18n.getLocale()).toBe('en-US');
  });
});

describe('presentation-only translation contracts',()=>{
  it('keeps explicit user parameters and runtime captures opaque, including names matching a known UI phrase',async()=>{
    const {translate}=await module(),name='关闭。我的 {source}';
    expect(translate('删除 {0}',{0:name},'en-US')).toBe(`Delete ${name}`);
    expect(translate('删除 主图',undefined,'en-US')).toBe('Delete 主图');
    expect(translate('删除 {0}',{0:name},'zh-CN')).toBe(`删除 ${name}`);
    expect(translate('未知模板 {name}',{name},'en-US')).toBe(`未知模板 ${name}`);
    expect(translate('untouched user code: close[1]',undefined,'en-US')).toBe('untouched user code: close[1]');
  });
  it('matches dynamic templates across placeholder boundaries and translates nested canonical facts separately from user messages',async()=>{
    const {translate,translateCanonical}=await module();
    expect(translateCanonical('参考已知波段高点 114.32',undefined,'en-US')).toBe('Known swing High reference: 114.32');
    expect(translate('参考已知波段高点 114.32',undefined,'en-US')).toBe('Known swing 高 reference: 114.32');
    expect(translateCanonical('Elliott ABC 修正 · 浪级 L12 · 硬规则匹配 · 主计数 · 0-A-B-C · 起点 2026-09-06T12:00:00.000Z',undefined,'en-US')).not.toMatch(/[\u3400-\u9fff]/);
    expect(translateCanonical('Error: 初始平衡分钟数应为 1–1440',undefined,'en-US')).toContain('Initial balance');
    expect(translateCanonical('未知领域消息',undefined,'en-US')).toBe('未知领域消息');
  });
  it('preserves explicit time zones and formatting options while following locale changes',async()=>{
    storage();const i18n=await module(),time=Date.UTC(2026,8,24,0,30),options:Intl.DateTimeFormatOptions={year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'UTC'};
    i18n.setLocale('en');expect(i18n.formatDate(time,options)).toBe(new Intl.DateTimeFormat('en-US',options).format(time));
    i18n.setLocale('zh');expect(i18n.formatDate(time,options)).toBe(new Intl.DateTimeFormat('zh-CN',options).format(time));
    expect(i18n.formatDate(time,{...options,timeZone:'Asia/Shanghai'},'en-US')).toContain('08:30');
    expect(i18n.formatNumber(1234.567,{maximumFractionDigits:2},'en-US')).toBe('1,234.57');expect(i18n.formatDate(NaN)).toBe('—');expect(i18n.formatNumber(NaN)).toBe('—');
  });
  it('retains interpolation identifiers in every catalog and in the merged public lookup',async()=>{
    const holes=(text:string)=>[...new Set([...text.matchAll(/(?<!\$)\{([\w.-]+)\}/g)].map(match=>match[1]))].sort();
    const all={core,shell,library,workspace,analysis};
    for(const [catalog,entries] of Object.entries(all))for(const [source,target] of Object.entries(entries))expect(holes(target),`${catalog}: ${source}`).toEqual(holes(source));
    const {englishMessages}=await module();expect(Object.isFrozen(englishMessages)).toBe(true);
    for(const [source,target] of Object.entries(englishMessages))expect(holes(target),source).toEqual(holes(source));
  });
});
