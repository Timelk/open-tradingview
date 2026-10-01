import {beforeAll,describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {build} from 'esbuild';
import {compile} from 'svelte/compiler';
import {resonanceKey,type ResonanceTag} from '../src/lib/patterns/resonance';
import type {PatternMatch,PatternRow} from '../src/lib/patterns/types';

const han=/[㐀-鿿]/;
type Draw=(props:unknown,language:'zh-CN'|'en-US')=>string;
let panel:Draw,evidence:Draw;
beforeAll(async()=>{
  const result=await build({stdin:{contents:"import Panel from './components/layout/panels/Patterns.svelte'; import Evidence from './components/studies/PatternEvidence.svelte'; import {locale} from './lib/i18n'; import {render} from 'svelte/server'; export const panel=(props,language)=>{locale.set(language);return render(Panel,{props}).body;}; export const evidence=(props,language)=>{locale.set(language);return render(Evidence,{props}).body;};",resolveDir:resolve('src')},
    bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'panel-signals-ssr',setup(builder){builder.onLoad({filter:/\.svelte$/},args=>({contents:compile(readFileSync(args.path,'utf8'),{filename:args.path,generate:'server'}).js.code,loader:'js',resolveDir:dirname(args.path)}));}}]});
  ({panel,evidence}=await import(/* @vite-ignore */'data:text/javascript,'+encodeURIComponent(result.outputFiles[0].text)));
},60_000);

const H=3_600_000,T=1_700_000_000_000;
const harmonic=(id:string,over:Partial<PatternMatch>={}):PatternMatch=>({id:`harmonic:Crab:${id}`,family:'Crab',name:'螃蟹 · Crab',direction:'bullish',
  points:['X','A','B','C','D'].map((label,i)=>({label,time:T+i*H,value:100+i})),confirmedAt:T+8*H,zone:{low:99,high:101},invalidation:90,targets:[110,115],ratios:[],description:'',status:'confirmed',...over});
const signals=(kinds:Array<'macd'|'atr'|'pin'>)=>({
  ...(kinds.includes('macd')?{macd:{kind:'bullish' as const,source:'anchors' as const,first:{time:T,price:27000,dif:-320},second:{time:T+4*H,price:26900,dif:-180}}}:{}),
  ...(kinds.includes('atr')?{atr:{period:14,value:212,multiple:2,level:26475}}:{}),
  ...(kinds.includes('pin')?{pin:{wickShare:.7,bodyShare:.2}}:{}),
});
const row=(instanceId:string,pattern:PatternMatch):PatternRow=>({instanceId,layerName:'Harmonic',timeframe:'2h',visible:true,color:'#4a8',pattern});
const tag=(kind:ResonanceTag['kind'],label:string,detail:string,target:ResonanceTag['target']):ResonanceTag=>({kind,label,detail,tone:kind==='multi-tf'?'good':'neutral',target,knownAt:T+9*H});

function context(rows:PatternRow[],resonance:Map<string,ResonanceTag[]>,options:{selectedKey?:string;studies?:Array<{definitionId:string}>}={}){
  const studies=(options.studies??[{definitionId:'pattern-harmonic'}]).map((study,i)=>({instanceId:`study${i}`,name:'Harmonic',definitionId:study.definitionId,timeframe:'2h',visible:true,pending:false,count:rows.length}));
  const controller={
    getPatternStudies:()=>studies,getPatternRows:()=>rows,getPatternCandidates:()=>[],getPatternResonance:()=>resonance,
    selectedPatternKey:options.selectedKey,selectedCandidateKey:undefined,
    layerStatus:()=>({locked:false,visible:true}),getObservationReview:()=>undefined,
    drawing:{subscribe:()=>()=>{},document:{indicators:[],layers:[],drawings:[]},state:{}},
  };
  return {context:{controller,chartState:{symbol:'BTCUSDT',source:'live',interval:'2h',patternHistoryLoading:false,patternHistoryError:''}},density:'compact',zone:'right',onClose:()=>{}};
}
const chips=(html:string)=>[...html.matchAll(/<em class="signal-tag[^>]*>([^<]*)<\/em>/g)].map(m=>m[1]);

describe('signal chips in the pattern list',()=>{
  const full=harmonic('full',{signals:signals(['macd','atr','pin'])}),plain=harmonic('plain',{confirmedAt:T+7*H});
  const props=(selectedKey?:string)=>context([row('h',full),row('h',plain)],new Map<string,ResonanceTag[]>([[resonanceKey('h',full.id),[tag('multi-tf','4h Shark','4h Shark overlaps',{instanceId:'x',patternId:'p'})]]]),{selectedKey});

  it('shows up to three chips per row, most decisive first, and folds the rest into +N',()=>{
    const html=panel(props(),'zh-CN');
    // MACD > multi-timeframe > 2ATR; the pin is folded.
    expect(chips(html)).toEqual(['MACD 底背离','4h Shark','2ATR未扎']);
    expect(html).toContain('>+1</em>');
    expect(html).toContain('另有 1 个信号标签');
  });

  it('renders an older match without signals as before: no chips, no error',()=>{
    const html=panel(context([row('h',plain)],new Map()),'zh-CN');
    expect(html).toContain('螃蟹 · Crab');
    expect(chips(html)).toEqual([]);expect(html).not.toContain('signal-tags');
  });

  it('offers the resonance filter only when a harmonic detector is mounted',()=>{
    const withHarmonic=panel(props(),'zh-CN');
    expect(withHarmonic).toContain('筛选谐波共振信号');
    for(const option of ['有 MACD 背离','2ATR 未扎','有末端结构','有多周期共振'])expect(withHarmonic).toContain(option);
    const without=panel(context([row('h',plain)],new Map(),{studies:[{definitionId:'pattern-huzi'}]}),'zh-CN');
    expect(without).not.toContain('筛选谐波共振信号');
  });

  it('is fully English in English, chips and filter included',()=>{
    const html=panel(props(),'en-US');
    expect(chips(html)).toEqual(['MACD bullish divergence','4h Shark','2 ATR held']);
    for(const option of ['Resonance','With MACD divergence','2 ATR held','With end structure','With multi-timeframe'])expect(html).toContain(option);
    expect(html).toContain('Filter harmonic resonance signals');
    expect(html).toContain('1 more signal tags');
    // Everything the resonance additions put into the markup is English.
    const added=[...html.matchAll(/<select class="resonance-filter"[\s\S]*?<\/select>/g)].map(m=>m[0]).join('')+chips(html).join('')+[...html.matchAll(/title="([^"]*)"/g)].map(m=>m[1]).filter(text=>/signal|divergence|ATR|Shark/.test(text)).join('');
    expect(added).not.toMatch(han);
  });
});

describe('resonance signals in the detail column',()=>{
  const full=harmonic('full',{signals:signals(['macd','atr','pin'])}),other=harmonic('other',{name:'鲨鱼 · Shark',family:'Shark'});
  const linked=tag('multi-tf','4h Shark','4h 周期的 Shark 同向完成，PRZ 与本形态重叠 60%，D 点相隔 0.1 根 8h K 线。',{instanceId:'h2',patternId:other.id});
  const structure=tag('terminal','末端 对称三角形','对称三角形 起于 D 点后 3 根 2h K 线，方向与谐波一致：末端结构。',{instanceId:'c2',patternId:'huzi-triangle:s'});
  const resonance=new Map([[resonanceKey('h',full.id),[linked,structure]]]);

  it('lists every tag with its detail and a jump only to a match that is displayed',()=>{
    const html=panel(context([row('h',full),row('h2',other)],resonance,{selectedKey:resonanceKey('h',full.id)}),'zh-CN');
    expect(html).toContain('共振信号');
    for(const text of ['MACD 底背离','2ATR未扎','D 针形K','末端 对称三角形','动能没有跟随价格创新低','ATR(14) = 212'])expect(html).toContain(text);
    // The Shark is displayed (layer h2), the triangle's layer is not: one jump button, for the Shark.
    expect([...html.matchAll(/class="signal-jump[^"]*"/g)]).toHaveLength(1);
    expect(html).toContain('aria-label="定位到该形态: 4h Shark"');
    expect(html).toContain('这些标签是阅读辅助，不是交易信号');
  });

  it('shows no section for a match without any tag',()=>{
    const html=panel(context([row('h',harmonic('plain'))],new Map(),{selectedKey:resonanceKey('h',harmonic('plain').id)}),'zh-CN');
    expect(html).not.toContain('signal-section');
  });

  it('renders the section in English',()=>{
    const html=panel(context([row('h',full),row('h2',other)],resonance,{selectedKey:resonanceKey('h',full.id)}),'en-US');
    const section=html.match(/<section class="signal-section[^"]*"[\s\S]*?<\/section>/)![0];
    expect(section).toContain('Resonance signals');expect(section).toContain('Go to that pattern');
    expect(section).toContain('momentum did not follow price to a new low');
    expect(section).toContain('A Shark on the 4h timeframe');
    expect(section).not.toMatch(han);
  });

  it('draws the evidence component alone, with and without a jump target',()=>{
    const canJump=(target:{patternId:string})=>target.patternId===other.id;
    const html=evidence({pattern:full,tags:[linked,structure],canJump,onJump:()=>{}},'en-US');
    expect([...html.matchAll(/class="signal-jump[^"]*"/g)]).toHaveLength(1);
    expect(evidence({pattern:full},'en-US')).not.toContain('signal-section');
  });
});
