import {describe,expect,it} from 'vitest';
import {build} from 'esbuild';
import {compile} from 'svelte/compiler';
import {readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {IndicatorRegistry,registerBuiltins} from '../src/lib/indicators/registry';
import {filterStudies,studyCatalog,studyTags,studyDisplayTitle,studyDisplayDescription} from '../src/lib/studies/catalog';
import {translate,translateCanonical} from '../src/lib/i18n';
const en=(text:string)=>translateCanonical(text,undefined,'en-US');
const zh=(text:string)=>translate(text,undefined,'zh-CN');
function builtins(){const registry=new IndicatorRegistry();registerBuiltins(registry);return registry;}

describe('bilingual study library with opaque user content',()=>{
  it('indexes both languages across the real registry without changing category, tag or entry IDs',()=>{
    const registry=builtins(),entries=studyCatalog(registry.list()),before=JSON.stringify(registry.list().map(({calc,createIncremental,...def})=>def));
    expect(entries.map(entry=>entry.id).sort()).toEqual(registry.list().map(def=>def.id).sort());
    for(const entry of entries){
      expect(studyDisplayTitle(entry,en)).not.toMatch(/[\u3400-\u9fff]/);expect(studyDisplayDescription(entry,en)).not.toMatch(/[\u3400-\u9fff]/);
      const canonical=studyTags(entry),english=studyTags(entry,en);
      expect(english.map(tag=>tag.id)).toEqual(canonical.map(tag=>tag.id));
      for(const tag of english){expect(tag.label).not.toMatch(/[\u3400-\u9fff]/);expect(tag.description).not.toMatch(/[\u3400-\u9fff]/);}
      expect(studyTags(entry,zh)).toEqual(canonical);
    }
    expect(filterStudies(entries,'moving average','builtin','indicator',[]).map(e=>e.id)).toContain('ma');
    expect(filterStudies(entries,'移动平均','builtin','indicator',[]).map(e=>e.id)).toContain('ma');
    expect(filterStudies(entries,'head shoulders','builtin','all',[]).map(e=>e.id)).toContain('pattern-huzi');
    expect(filterStudies(entries,'harmonic pattern','builtin','all',[]).map(e=>e.id)).toContain('pattern-harmonic');
    expect(filterStudies(entries,'ＧＡＲＴＬＥＹ','favorites','all',['pattern-harmonic']).map(e=>e.id)).toEqual(['pattern-harmonic']);
    expect(JSON.stringify(registry.list().map(({calc,createIncremental,...def})=>def))).toBe(before);
  });

  it('preserves custom extension metadata while localizing owned capability tags',()=>{
    const custom=studyCatalog([{id:'custom',name:'保存',title:'双 EMA 指标',description:'我的说明：保存',source:'custom',target:'main',inputs:[],calc:()=>[]}])[0];
    expect(studyDisplayTitle(custom,en)).toBe(custom.title);expect(studyDisplayDescription(custom,en)).toBe(custom.description);expect(studyTags(custom,en)[0].description).toContain(custom.description);
    expect(studyTags(custom,en).find(tag=>tag.id==='source:custom')?.label).toBe('Extension');
  });

  it('renders all real built-ins in English and preserves renamed chart layers with translated controls',async()=>{
    const directory=decodeURIComponent(new URL('../src/',import.meta.url).pathname);
    const result=await build({stdin:{contents:"import Library from './components/studies/StudyLibrary.svelte';import Legends from './components/studies/ChartStudies.svelte';import{render}from'svelte/server';import{locale}from'./lib/i18n';export const draw=(type,props,language='en-US')=>{locale.set(language);return render(type==='library'?Library:Legends,{props}).body};",resolveDir:directory},bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'library-i18n-ssr',setup(builder){builder.onLoad({filter:/\.svelte$/},async args=>({contents:compile(await readFile(args.path,'utf8'),{filename:args.path,generate:'server'}).js.code,loader:'js',resolveDir:dirname(args.path)}));}}]});
    const {draw}=await import(/* @vite-ignore */ 'data:text/javascript,'+encodeURIComponent(result.outputFiles[0].text));
    const registry=builtins(),doc={indicators:[{instanceId:'mine',id:'ma',params:{period:20},timeframe:'chart'},{instanceId:'canonical',id:'strategy-ma-cross',params:{fast:10,slow:50},timeframe:'chart'}],layers:[{id:'mine',kind:'indicator',name:'保存',paneId:'main',visible:true},{id:'canonical',kind:'indicator',name:'均线交叉',paneId:'main',visible:true}]};
    const controller={registry,drawing:{document:doc,state:{scene:{document:doc,selectedIds:[]}}},getDiagnostics:()=>({source:'mock',symbol:'TESTUSD',interval:'1m'}),getPatternStudies:()=>[],getAnalysisStudies:()=>[],layerStatus:()=>({visible:true,locked:false,reason:''})};
    const library=draw('library',{controller,onClose(){}});
    for(const id of ['pattern-huzi','pattern-harmonic','pattern-confluence'])expect(library).toContain(`data-study-key="${id}"`);expect(library).toContain('Built-in');expect(library).toContain('Three pattern families');expect(library).toContain('Structure &amp; volume');expect(library).not.toMatch(/Pine|backtest|My scripts/i);
    const text=(html:string)=>html.replace(/<style[\s\S]*?<\/style>/g,'').replace(/<[^>]*>/g,'');
    expect(text(library)).not.toMatch(/[\u3400-\u9fff]/);
    const legends=draw('legends',{controller,chartState:{readings:[]},panes:[{id:'main',top:0,width:1000,height:400}],onOpenProperties(){},onReveal(){}});
    expect(legends).toContain('>保存</strong>');expect(legends).toContain('aria-label="More actions for 保存"');expect(legends).toContain('data-study-id="canonical"');
    expect(text(legends).replaceAll('保存','')).not.toMatch(/[\u3400-\u9fff]/);
    expect(draw('library',{controller,onClose(){}},'zh-CN')).toContain('指标与策略');expect(doc.layers[0].name).toBe('保存');expect(doc.indicators[0].id).toBe('ma');
  });
});
