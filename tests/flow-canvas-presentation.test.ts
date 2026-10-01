import {beforeAll,describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {build} from 'esbuild';
import {compile} from 'svelte/compiler';
import {flowGuideMessages} from '../src/lib/i18n/messages-flow-guide';

let draw:(props:Record<string,unknown>,language:'zh-CN'|'en-US')=>string;
beforeAll(async()=>{
  const result=await build({
    stdin:{contents:"import Canvas from './FlowCanvas.svelte'; import {locale} from '../../lib/i18n'; import {render} from 'svelte/server'; export function draw(props,language){locale.set(language);return render(Canvas,{props}).body;}",resolveDir:resolve('src/components/studies')},
    bundle:true,format:'esm',platform:'node',write:false,
    plugins:[{name:'flow-guide-ssr',setup(builder){builder.onLoad({filter:/\.svelte$/},args=>({
      contents:compile(readFileSync(args.path,'utf8'),{filename:args.path,generate:'server'}).js.code,loader:'js',resolveDir:dirname(args.path),
    }));}}],
  });
  ({draw}=await import(/* @vite-ignore */'data:text/javascript,'+encodeURIComponent(result.outputFiles[0].text)));
});
const guide=(html:string)=>html.match(/<div[^>]+data-flow-guide=[\s\S]*?<\/ul>\s*<\/div>/)?.[0]??'';
const study={totalVisits:20,poc:100,valueLow:99,valueHigh:102,singlePrints:[{price:99,priceEnd:100}],valueAreaPercent:70};

describe('persistent flow chart guide',()=>{
  it('explains footprint side, delta, imbalance and partial coverage beside the chart',()=>{
    const html=guide(draw({mode:'footprint'},'zh-CN'));
    for(const text of ['左侧数字：主动卖量','右侧数字：主动买量','底色：绿为净买，红为净卖','描边：达到所设失衡倍率','虚线列框：成交覆盖不全'])expect(html).toContain(text);
    expect(html).not.toContain('POC');
  });

  it('distinguishes profile buy/sell composition from whole-bar traded volume',()=>{
    const html=guide(draw({mode:'profile'},'zh-CN'));
    for(const text of ['绿色部分：主动买量','红色部分：主动卖量','整条长度：该价档总成交量'])expect(html).toContain(text);
    expect(html).not.toContain('失衡');
  });

  it('shows TPO explanations only for the reference marks actually present',()=>{
    const plain=guide(draw({mode:'tpo'},'zh-CN'));
    expect(plain).toContain('蓝条长度：访问该价档的时间块数');
    expect(plain).not.toMatch(/POC|VA|IB|黄色描边/);
    const complete=guide(draw({mode:'tpo',tpoStudy:study,balance:{status:'complete',from:0,through:60_000,low:99,high:102,reason:'完整'}},'zh-CN'));
    for(const text of ['POC 虚线：访问次数最多的价档','VA 底色：设定比例的时间访问区间','黄色描边：区间内部仅访问一次','IB 侧括号：初始时段高低点'])expect(complete).toContain(text);
    const partial=guide(draw({mode:'tpo',balance:{status:'partial',from:0,through:60_000,low:99,high:102,reason:'覆盖不足'}},'zh-CN'));
    expect(partial).toContain('IB 虚线：初始区间尚未完整覆盖');
    expect(partial).not.toContain('IB 侧括号');
  });

  it('keeps unavailable depth separate from an absence of trades',()=>{
    const html=guide(draw({mode:'heatmap'},'zh-CN'));
    for(const text of ['绿色横条：买方挂单档位','红色横条：卖方挂单档位','颜色越亮：该档挂单数量越多','棕色缺口：深度不可重建，不是无成交'])expect(html).toContain(text);
    expect(draw({mode:'heatmap'},'zh-CN')).toContain('只展示可由真实快照与连续差分重建的L2；不补画断档。');
  });

  it('localizes every guide mode and its accessible name in English',()=>{
    for(const mode of ['footprint','profile','tpo','heatmap']){
      const html=guide(draw({mode,tpoStudy:study,balance:{status:'complete',from:0,through:60_000,low:99,high:102,reason:'完整'}},'en-US'));
      expect(html).toContain('Current view legend');
      expect(html).not.toMatch(/[\u3400-\u9fff]/);
    }
    for(const message of Object.values(flowGuideMessages))expect(message).not.toMatch(/[\u3400-\u9fff]/);
  });
});
