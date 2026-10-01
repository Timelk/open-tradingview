import {beforeAll,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {build} from 'esbuild';
import {compile,parse} from 'svelte/compiler';
import {appearanceMessages} from '../src/lib/i18n/messages-appearance';
import {translate} from '../src/lib/i18n';
import {APPEARANCE_PRESETS} from '../src/lib/chart/appearance';

let draw:(language:'zh-CN'|'en-US')=>string;
beforeAll(async()=>{
  const result=await build({stdin:{contents:"import Appearance from './ChartAppearanceDialog.svelte'; import {locale} from '../../lib/i18n'; import {render} from 'svelte/server'; export function draw(language){locale.set(language);return render(Appearance,{props:{controller:{},onClose(){}}}).body;}",resolveDir:resolve('src/components/chart')},bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'appearance-dialog-ssr',setup(builder){builder.onLoad({filter:/\.svelte$/},args=>({contents:compile(readFileSync(args.path,'utf8'),{filename:args.path,generate:'server'}).js.code,loader:'js',resolveDir:dirname(args.path)}));}}]});
  ({draw}=await import(/* @vite-ignore */'data:text/javascript,'+encodeURIComponent(result.outputFiles[0].text)));
});

it('renders four keyboard-addressable settings panels and actual SVG palette previews',()=>{
  const html=draw('en-US');
  expect(html.match(/role="tab"/g)).toHaveLength(4);
  expect(html.match(/role="tabpanel"/g)).toHaveLength(4);
  for(const id of ['theme','candles','canvas','scales'])expect(html).toContain(`aria-controls="appearance-panel-${id}"`);
  expect(html.match(/class="chart-preview"/g)).toHaveLength(6);
  expect(html).toContain('Sample candles · not market data');
  expect(html).toContain('aria-labelledby="appearance-title"');
});

it('exposes independent body, border and wick colors plus all canvas and scale controls',()=>{
  const html=draw('en-US');
  for(const name of ['Up body color','Down body color','Up border color','Down border color','Up wick color','Down wick color','Color direction','Line color','Line width','Volume opacity','Background mode','Gradient end color','Grid directions','Grid style','Grid opacity','Watermark text','Watermark color','Watermark opacity','Watermark font size','Scale text color','Scale font size','Separator color','Show last price line','Show last price label','Show crosshair','Crosshair color','Crosshair style'])expect(html,name).toContain(name);
  for(const key of ['upColor','downColor','borderUpColor','borderDownColor','wickUpColor','wickDownColor','background','backgroundEnd','gridColor','watermarkColor','textColor','separatorColor','crosshairColor'])expect(html,key).toContain(`id="appearance-${key}"`);
  expect(html).toContain('Save appearance');expect(html).toContain('Reset defaults');expect(html).toContain('Cancel');
});

it('localizes both languages including preset descriptions, errors and interpolation',()=>{
  const english=draw('en-US'),chinese=draw('zh-CN');
  expect(english).not.toMatch(/[\u3400-\u9fff]/);
  expect(chinese).toContain('图表外观');expect(chinese).toContain('刻度与光标');
  for(const preset of APPEARANCE_PRESETS)for(const message of [preset.name,preset.description])expect(translate(message,undefined,'en-US')).not.toMatch(/[\u3400-\u9fff]/);
  for(const [source,target] of Object.entries(appearanceMessages)){
    expect(target,source).not.toMatch(/[\u3400-\u9fff]/);
    expect([...target.matchAll(/\{([\w.-]+)\}/g)].map(m=>m[1]).sort(),source).toEqual([...source.matchAll(/\{([\w.-]+)\}/g)].map(m=>m[1]).sort());
  }
});

it('contains no untranslated owned text or accessible label in the dialog markup',()=>{
  for(const name of ['ChartAppearanceDialog','ColorField']){
    const file=`src/components/chart/${name}.svelte`,ast=parse(readFileSync(file,'utf8'),{modern:true});
    const walk=(node:any)=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(walk);return;}if(node.type==='Text')expect(node.data,file).not.toMatch(/[\u3400-\u9fff]/);if(node.type==='Attribute'&&!['title','aria-label','placeholder','alt'].includes(node.name))return;for(const [key,value] of Object.entries(node))if(!['expression','test','context','key','index','loc','metadata','comments'].includes(key))walk(value);};
    walk(ast.fragment);
  }
});
