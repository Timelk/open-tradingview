import {beforeAll,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {build} from 'esbuild';
import {compile,parse} from 'svelte/compiler';
import {messages} from '../src/lib/i18n/messages-analysis';
import {translate,translateCanonical} from '../src/lib/i18n';
import {ColumnStore} from '../src/lib/core/datastore';
import {detectHuzi} from '../src/lib/patterns/huzi';
import {detectHarmonics} from '../src/lib/patterns/harmonic';
import {analysisIndicators} from '../src/lib/analysis/registry';
import sol from './fixtures/solusdt-4h-zoom-2026-09.json';
const han=/[\u3400-\u9fff]/;
let draw:(kind:'candidates'|'canvas',props:unknown,language:'zh-CN'|'en-US')=>string;
beforeAll(async()=>{
  const directory=resolve('src/components/studies');
  const result=await build({stdin:{contents:"import Candidates from './PatternCandidates.svelte'; import Canvas from './FlowCanvas.svelte'; import {locale} from '../../lib/i18n'; import {render} from 'svelte/server'; export function draw(kind,props,language){locale.set(language);return render(kind==='candidates'?Candidates:Canvas,{props}).body;}",resolveDir:directory},bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'analysis-i18n-ssr',setup(builder){builder.onLoad({filter:/\.svelte$/},args=>({contents:compile(readFileSync(args.path,'utf8'),{filename:args.path,generate:'server'}).js.code,loader:'js',resolveDir:dirname(args.path)}));}}]});
  ({draw}=await import(/* @vite-ignore */'data:text/javascript,'+encodeURIComponent(result.outputFiles[0].text)));
});
it('has English translations and preserves every numeric template placeholder in the analysis dictionary',()=>{
  for(const [source,target] of Object.entries(messages)){
    expect(target,source).not.toMatch(han);
    expect([...target.matchAll(/\{(\d+)\}/g)].map(m=>m[1]).sort(),source).toEqual([...source.matchAll(/\{(\d+)\}/g)].map(m=>m[1]).sort());
  }
});
it('localizes actual detector descriptions, names and ratio labels without changing engine facts',()=>{
  const store=new ColumnStore();for(const [time,open,high,low,close,volume] of sol.bars.slice(0,730))store.appendBar({time,open,high,low,close,volume});
  const harmonic=detectHarmonics(store,{...sol.params,showInvalidated:true,maxPatterns:1000});
  const classic=new ColumnStore(),turns=[[0,100],[10,110],[20,90],[30,110],[40,98],[50,110],[55,106],[63,115],[70,115]];let leg=0;
  for(let i=0;i<=70;i++){while(leg+1<turns.length-1&&i>turns[leg+1][0])leg++;const a=turns[leg],b=turns[leg+1],v=a[1]+(b[1]-a[1])*(i-a[0])/(b[0]-a[0]);classic.appendBar({time:i*60000,open:v,high:v+.1,low:v-.1,close:v,volume:1});}
  const patterns=[...harmonic,...detectHuzi(classic,{pivotStrength:2,family:'三角形',showInvalidated:true})],before=structuredClone(patterns);expect(patterns.length).toBeGreaterThan(2);
  for(const item of patterns)for(const text of [item.name,item.description,...item.ratios.map(r=>r.label)])expect(translateCanonical(text,undefined,'en-US'),text).not.toMatch(han);
  expect(patterns).toEqual(before);
});
it('localizes real native analysis evidence and composed alternative-count labels',()=>{
  const store=new ColumnStore();for(const [time,open,high,low,close,volume] of sol.bars)store.appendBar({time,open,high,low,close,volume});
  const cols={length:store.length,closedLength:store.length,intervalMs:sol.intervalMs,col:(name:Parameters<ColumnStore['col']>[0])=>store.col(name)};let checked=0;
  for(const definition of analysisIndicators()){
    const params=Object.fromEntries(definition.inputs.map(input=>[input.key,input.def]));
    if(definition.id==='analysis-gann')Object.assign(params,{anchorTime:store.timeAt(1400),anchorPrice:store.col('close')[1400],direction:'up'});
    for(const series of definition.calc({cols,from:0,to:cols.length},params)){
      if(series.dataWarning)expect(translateCanonical(series.dataWarning,undefined,'en-US')).not.toMatch(han);
      for(const item of series.observations??[])for(const message of [item.name,item.phase,...item.evidence,...item.counterEvidence,...item.waitingFor,...item.points.map(point=>point.label),...item.events.flatMap(event=>[event.label,event.explanation]),...(item.alternatives??[]),item.dataWarning].filter(Boolean)){
        expect(translateCanonical(message,undefined,'en-US'),message).not.toMatch(han);checked++;
      }
    }
  }
  expect(checked).toBeGreaterThan(1000);
});
it('renders bilingual developing evidence while retaining user layer names and UTC anchors',()=>{
  const row={instanceId:'user-layer',layerName:'用户手写计划',timeframe:'4h',visible:true,candidate:{id:'candidate-stable',family:'huzi-wedge',name:'下降楔形',direction:'neutral',points:[{label:'A',time:0,value:100},{label:'B',time:14400000,value:110}],observedAt:28800000,ratios:[{label:'末端 / 初始宽度',value:.5,expected:'0.10–0.88'}],description:'继续观察后续价格是否测试投影区'}};
  const props={rows:[row],onSelect(){},onSettings(){}};
  const english=draw('candidates',props,'en-US');expect(english).toContain('Falling wedge');expect(english).toContain('Developing');expect(english).toContain('用户手写计划');
  const detail=draw('candidates',{...props,mode:'detail',row},'en-US');expect(detail).toContain('Actual');expect(detail).toContain('UTC');expect(detail).not.toMatch(han);
  const chinese=draw('candidates',props,'zh-CN');expect(chinese).toContain('下降楔形');expect(chinese).toContain('用户手写计划');
  expect(translate('删除 {0}',{'0':'用户手写计划'},'en-US')).toBe('Delete 用户手写计划');
});
it('localizes footprint controls and accessibility text without requiring a new chart instance',()=>{
  const english=draw('canvas',{},'en-US'),chinese=draw('canvas',{},'zh-CN');
  expect(english).toContain('Displayed columns');expect(english).toContain('Allow zero opposing volume');expect(english).toContain('Multi-bar price footprint');expect(english).not.toMatch(han);
  expect(chinese).toContain('显示列数');expect(chinese).toContain('允许零对手量');
});
it('leaves no unlocalized static Chinese text or static accessible label in the owned component markup',()=>{
  const names=['AnalysisObservations','AnalysisResearch','FlowCanvas','HistoricalFlowViewer','MarketDataManager','PatternCandidates','PatternCoverage','PatternEvidence','ReviewControls','TradeFlowPanel'];
  const files=[...names.map(name=>`src/components/studies/${name}.svelte`),'src/components/layout/panels/Patterns.svelte','src/components/layout/panels/AnalysisWorkspace.svelte'];
  for(const file of files){const source=readFileSync(file,'utf8'),ast=parse(source,{modern:true});
    const walk=(node:any)=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(walk);return;}if(node.type==='Text')expect(node.data,file).not.toMatch(han);if(node.type==='Attribute'&&!['title','aria-label','placeholder','data-tooltip','alt'].includes(node.name))return;for(const [key,value] of Object.entries(node))if(!['expression','test','context','key','index','loc','metadata','comments'].includes(key))walk(value);};walk(ast.fragment);
    expect(source).not.toMatch(/\$(?:canonicalT|t)\(\s*(?:review\.(?:name|note)|study\.name|row\.layerName|item\.layerName)\s*\)/);
  }
});
