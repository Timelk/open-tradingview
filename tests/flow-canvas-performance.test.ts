import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {formatFlowNumber,formatFlowTime,depthDisplayAmount,depthMarkerHeight,FlowHitIndex,type FlowCanvasHit} from '../src/lib/flow/canvas-presentation';

let render:(input:Record<string,unknown>)=>{cells:FlowCanvasHit[];hit:(x:number,y:number)=>FlowCanvasHit|undefined;describe:(hit:FlowCanvasHit)=>string;formatting:{numbers:number;times:number};fills:string[]};
beforeAll(async()=>{
  vi.stubGlobal('window',{devicePixelRatio:2});
  const source=readFileSync('src/components/studies/FlowCanvas.svelte','utf8');
  const functions=source.slice(source.indexOf('  function draw(){'),source.indexOf('  function hover('));
  const entry=`import {footprintPage} from './src/lib/flow/history-view';import {footprintImbalances} from './src/lib/flow/studies';import {formatFlowNumber,formatFlowTime,depthDisplayAmount,depthMarkerHeight,FlowHitIndex} from './src/lib/flow/canvas-presentation';
  export function render(input){const {data,heatmap,mode='heatmap',unit='base'}=input;const width=1100,height=600,columns=20,offset=0,tpo=undefined,tpoStudy=undefined,balance=undefined,imbalanceMode='diagonal',imbalanceRatio=3,minimumVolume=.1,allowZero=false,$locale='en-US';
  const formatting={numbers:0,times:0},fills=[];let hitCells=[],hitIndex=new FlowHitIndex(),lastHit,canvasRect;
  const noop=()=>{},ctx={setTransform:noop,clearRect:noop,fillRect(){fills.push(this.fillStyle)},beginPath:noop,moveTo:noop,lineTo:noop,stroke:noop,fillText:noop,strokeRect:noop,setLineDash:noop};const canvas={width:2200,height:1200,getContext:()=>ctx};
  const $canonicalT=x=>x,$t=(text,values={})=>text.replace(/\\{([^}]+)\\}/g,(_,key)=>values[key]??key),fmt=(v,d=4)=>{formatting.numbers++;return formatFlowNumber(v,$locale,d)},date=time=>{formatting.times++;return formatFlowTime(time,$locale)},amount=(row,kind)=>row[kind+(unit==='base'?'Base':'Quote')];
  ${functions};draw();return {cells:hitCells,hit:(x,y)=>hitIndex.hit(x,y),describe:describeHit,formatting,fills};}`;
  const bundle=await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'ts'},bundle:true,format:'esm',platform:'node',write:false});
  ({render}=await import(/* @vite-ignore */'data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64')));
});
afterAll(()=>vi.unstubAllGlobals());
const heatmap=(samples=80,levels=40)=>({samples:Array.from({length:samples},(_,i)=>({time:i*60000,book:{status:'available',bids:Array.from({length:levels},(_,j)=>({price:50000-j,quantity:1+j})),asks:Array.from({length:levels},(_,j)=>({price:50001+j,quantity:1+j}))}}))});
describe('lazy flow canvas preparation',()=>{
  it('prepares 6400 depth hits without formatting 6400 tooltips',()=>{
    const result=render({heatmap:heatmap()});expect(result.cells).toHaveLength(6400);
    expect(result.formatting.numbers).toBeLessThan(12);expect(result.formatting.times).toBe(2);
    expect(result.cells.every(cell=>!Object.hasOwn(cell,'text'))).toBe(true);
    const hit=result.cells[0];expect(result.hit((hit.left+hit.right)/2,(hit.top+hit.bottom)/2)).toBe(hit);
    const before={...result.formatting};expect(result.describe(hit)).toContain('50,000');
    expect(result.formatting.numbers-before.numbers).toBe(2);expect(result.formatting.times-before.times).toBe(1);
  });
  it('uses price times quantity for both quote-unit intensity and tooltip amount',()=>{
    const input={samples:[{time:0,book:{status:'available',bids:[{price:100,quantity:1}],asks:[{price:200,quantity:1}]}}]};
    const base=render({heatmap:input,unit:'base'}),quote=render({heatmap:input,unit:'quote'});
    for(const color of base.fills.filter(color=>color.startsWith('rgba')))expect(Number(color.split(',').at(-1)!.slice(0,-1))).toBeCloseTo(.95);
    const alphas=quote.fills.filter(color=>color.startsWith('rgba')).map(color=>Number(color.split(',').at(-1)!.slice(0,-1)));
    expect(alphas[0]).toBeLessThan(alphas[1]);expect(quote.describe(quote.cells[0])).toContain('数量 100');expect(quote.describe(quote.cells[0])).toContain('USDT');
  });
  it('keeps unavailable depth blank and never gives it a synthetic hit',()=>{
    const input=heatmap(3,1);input.samples[1].book={status:'unavailable',bids:[],asks:[]} as never;
    const result=render({heatmap:input});expect(result.cells).toHaveLength(4);
    expect(result.cells.some(cell=>cell.time===60000)).toBe(false);expect(result.fills).toContain('#312b26');
  });
  it('keeps footprint partial and imbalance evidence available in lazy hover text',()=>{
    const level={tick:100,price:100,priceEnd:101,buyBase:10,sellBase:2,deltaBase:8,volumeBase:12,buyQuote:1000,sellQuote:200,deltaQuote:800,volumeQuote:1200,aggregateCount:4};
    const bar={time:0,endTime:60000,partial:true,levels:[level],...level};
    const result=render({mode:'footprint',data:{footprint:[bar],profile:[level],aggregation:{tickSize:1},effectivePriceStep:1,effectivePriceStepTicks:1}});
    expect(result.cells).toHaveLength(1);expect(result.cells[0].kind).toBe('footprint');expect(result.cells[0]).not.toHaveProperty('text');
    expect(result.describe(result.cells[0])).toContain('部分覆盖');expect(result.describe(result.cells[0])).toContain('主动卖 2 / 主动买 10 / 净量 8');
  });
});
describe('flow presentation helpers',()=>{
  it('formats precision and locale through cached formatters and keeps invalid values unavailable',()=>{
    expect(formatFlowNumber(1234.567,'en-US',2)).toBe('1,234.57');expect(formatFlowNumber(NaN,'en-US')).toBe('—');
    expect(formatFlowTime(0,'en-US')).toBe(new Date(0).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZone:'UTC'}));
    expect(depthDisplayAmount({price:50000,quantity:.2},'quote')).toBe(10000);expect(depthDisplayAmount({price:50000,quantity:.2},'base')).toBe(.2);
    expect(depthMarkerHeight(.01,100,600)).toBe(1);expect(depthMarkerHeight(100,100,600)).toBe(6);
  });
  it('preserves first-hit shared-edge ordering while restricting searches to a time column',()=>{
    const cells:FlowCanvasHit[]=Array.from({length:80},(_,column)=>Array.from({length:80},(_,row)=>({kind:'depth' as const,left:column*10,right:(column+1)*10,top:row*6,bottom:row*6+5,time:column,side:'bids' as const,price:row,quantity:1}))).flat();
    const index=new FlowHitIndex(cells);
    expect(index.hit(795,475)).toBe(cells.at(-1));expect(index.hit(10,2)).toBe(cells[0]);expect(index.hit(-1,2)).toBeUndefined();expect(index.hit(801,2)).toBeUndefined();
  });
});
