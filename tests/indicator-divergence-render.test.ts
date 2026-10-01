import {afterEach,describe,it,expect,vi} from 'vitest';
import {drawIndicatorDivergences,divergenceLabel,type IndicatorDivergencePaintOptions} from '../src/lib/render/indicator-divergences';
import type {IndicatorDivergenceMark} from '../src/lib/indicators/divergence-projection';
import type {OscillatorDivergence} from '../src/lib/indicators/divergence';
import {hitPattern} from '../src/lib/render/patterns';
import {appearancePreset,deriveOverlaySurface,readableSurfaceColor} from '../src/lib/chart/appearance';
import {getLocale,locale} from '../src/lib/i18n';

const originalLocale=getLocale();afterEach(()=>locale.set(originalLocale));
type Paint={op:string;args:unknown[];path:{op:string;args:unknown[]}[];stroke:unknown;fill:unknown;alpha:number;width:number};
function canvas(){
  const paints:Paint[]=[],state:Record<string,unknown>={globalAlpha:1,lineWidth:1,strokeStyle:'',fillStyle:''},stack:Record<string,unknown>[]=[];
  let path:{op:string;args:unknown[]}[]=[];
  const ctx=new Proxy(state,{get(target,key){
    if(key in target)return target[String(key)];if(key==='measureText')return(text:string)=>({width:[...text].length*7});
    return(...args:unknown[])=>{
      if(key==='save')stack.push({...state});else if(key==='restore')Object.assign(state,stack.pop());
      else if(key==='beginPath')path=[];else if(['moveTo','lineTo','arc','rect'].includes(String(key)))path.push({op:String(key),args});
      paints.push({op:String(key),args,path:path.map(part=>({...part,args:[...part.args]})),stroke:state.strokeStyle,fill:state.fillStyle,alpha:+state.globalAlpha!,width:+state.lineWidth!});
    };
  }}) as unknown as CanvasRenderingContext2D;
  return {ctx,paints};
}
const bounds={left:0,right:360,top:0,bottom:200},project=(time:number,value:number)=>({x:time,y:200-value});
const options=(extra:Partial<IndicatorDivergencePaintOptions>={}):IndicatorDivergencePaintOptions=>({instanceId:'rsi-7-instance',bullishColor:'#45c7ae',bearishColor:'#e78a94',width:1.25,labels:true,project,bounds,occupied:[],...extra});
function evidence(extra:Partial<OscillatorDivergence>={}):OscillatorDivergence{
  return {id:'oscillator-evidence',indicator:'rsi',seriesName:'RSI(7)',plotIndex:0,direction:'bullish',confirmedAt:150,ruleVersion:'oscillator-divergence/1.0-regular',
    points:[{time:40,value:50,price:100},{time:130,value:80,price:98}],...extra};
}
const mark=(d=evidence()):IndicatorDivergenceMark=>({divergence:d,points:d.points.map(p=>({time:p.time,value:p.value})) as IndicatorDivergenceMark['points']});
const paths=(paints:Paint[])=>paints.filter(p=>p.op==='stroke'&&p.path.length===2&&p.path[0].op==='moveTo'&&p.path[1].op==='lineTo');

describe('independent indicator divergence painting',()=>{
  it('draws supplied samples only and hits the owning indicator, without a PatternMatch',()=>{
    const d=evidence(),m=mark(d),before=structuredClone(m),draw=canvas(),projection=vi.fn(project);
    const hits=drawIndicatorDivergences(draw.ctx,[m],options({project:projection,labels:false}));
    expect(projection.mock.calls).toEqual([[40,50],[130,80]]);
    expect(paths(draw.paints)[0].path).toEqual([{op:'moveTo',args:[40,150]},{op:'lineTo',args:[130,120]}]);
    expect(draw.paints.filter(p=>p.op==='arc')).toHaveLength(2);
    expect(hitPattern(hits,{x:85,y:135})).toMatchObject({instanceId:'rsi-7-instance',divergence:d});
    expect(hits[0]).not.toHaveProperty('pattern');expect(hits[0].divergence).toBe(d);expect(m).toEqual(before);
  });

  it('draws one label/segment per plot, direction and pair despite different metadata ids',()=>{
    const d=evidence(),draw=canvas();const hits=drawIndicatorDivergences(draw.ctx,[mark(d),mark({...d,id:'duplicate'})],options());
    expect(hits).toHaveLength(1);expect(paths(draw.paints)).toHaveLength(1);expect(draw.paints.filter(p=>p.op==='fillText')).toHaveLength(1);
  });

  it('preserves the selected duplicate representative rather than letting an unselected id claim its key',()=>{
    const a=evidence({id:'a'}),b={...a,id:'b'};
    for(const marks of [[mark(a),mark(b)],[mark(b),mark(a)]]){
      const draw=canvas(),hits=drawIndicatorDivergences(draw.ctx,marks,options({selectedId:'b'}));
      expect(hits).toHaveLength(1);expect(hits[0].divergence).toBe(b);expect(paths(draw.paints)[0].width).toBe(2);
      expect(draw.paints.filter(p=>p.op==='arc').map(p=>p.args[2])).toEqual([3.5,3.5]);
    }
  });

  it('uses direction colors and selected-last picking for overlapping distinct evidence',()=>{
    const bullish=evidence({id:'bull'}),bearish=evidence({id:'bear',direction:'bearish',seriesName:'DIF',indicator:'macd'}),draw=canvas();
    const hits=drawIndicatorDivergences(draw.ctx,[mark(bearish),mark(bullish)],options({selectedId:'bear',labels:false}));
    expect(paths(draw.paints).map(p=>p.stroke)).toEqual(['#45c7ae','#e78a94']);
    expect(hitPattern(hits,{x:85,y:135})?.divergence).toBe(bearish);
  });

  it('uses Chinese and English direction labels while preserving the actual series name',()=>{
    const bull=evidence(),bear=evidence({direction:'bearish',seriesName:'DIF'});
    locale.set('zh-CN');expect(divergenceLabel(bull)).toBe('RSI(7) 底背离');expect(divergenceLabel(bear)).toBe('DIF 顶背离');
    locale.set('en-US');expect(divergenceLabel(bull)).toBe('RSI(7) Bullish divergence');expect(divergenceLabel(bear)).toBe('DIF Bearish divergence');
    const draw=canvas();drawIndicatorDivergences(draw.ctx,[mark(bear)],options());
    expect(draw.paints.find(p=>p.op==='fillText')?.args[0]).toBe('DIF Bearish divergence');
  });

  it('adapts light/dark contrast and restores the shared Canvas state',()=>{
    for(const theme of ['light','dark'] as const){
      const surface=deriveOverlaySurface(appearancePreset(theme)),draw=canvas();
      draw.ctx.globalAlpha=.5;draw.ctx.strokeStyle='#123456';draw.ctx.lineWidth=7;
      drawIndicatorDivergences(draw.ctx,[mark()],options({surface,bullishColor:'#dddddd',opacity:.4,labels:false}));
      expect(paths(draw.paints)[0]).toMatchObject({alpha:.2,stroke:readableSurfaceColor('#dddddd',surface.surfaceSolid,4.5)});
      expect(draw.ctx.globalAlpha).toBe(.5);expect(draw.ctx.strokeStyle).toBe('#123456');expect(draw.ctx.lineWidth).toBe(7);
    }
  });

  it('clips geometry and hits without inventing endpoint dots for offscreen anchors',()=>{
    const m=mark();m.points=[{time:-50,value:100},{time:400,value:100}];const draw=canvas(),hits=drawIndicatorDivergences(draw.ctx,[m],options());
    expect(draw.paints.some(p=>p.op==='clip')).toBe(true);expect(paths(draw.paints)).toHaveLength(1);
    expect(draw.paints.some(p=>p.op==='arc'||p.op==='fillText')).toBe(false);
    expect(hitPattern(hits,{x:100,y:100})?.divergence).toBe(m.divergence);
    expect(hitPattern(hits,{x:-1,y:100})).toBeUndefined();expect(hitPattern(hits,{x:361,y:100})).toBeUndefined();
  });

  it('respects labels=false and occupied space while retaining segment/endpoint interaction',()=>{
    for(const opts of [options({labels:false}),options({occupied:[bounds]})]){
      const draw=canvas(),hits=drawIndicatorDivergences(draw.ctx,[mark()],opts);
      expect(draw.paints.some(p=>p.op==='fillText')).toBe(false);
      expect(hitPattern(hits,{x:130,y:120})).toBeDefined();expect(hitPattern(hits,{x:85,y:135})).toBeDefined();
    }
    const draw=canvas(),hits=drawIndicatorDivergences(draw.ctx,[mark()],options());
    const b=hits[0].bounds;expect(hitPattern(hits,{x:(b.left+b.right)/2,y:(b.top+b.bottom)/2})).toBe(hits[0]);
  });

  it('ignores invisible layers, malformed projection and fully offscreen evidence',()=>{
    const hidden=canvas();expect(drawIndicatorDivergences(hidden.ctx,[mark()],options({opacity:0}))).toEqual([]);expect(hidden.paints).toEqual([]);
    const malformed=canvas();expect(drawIndicatorDivergences(malformed.ctx,[mark()],options({project:()=>({x:NaN,y:0})}))).toEqual([]);
    const outside=mark();outside.points=[{time:400,value:100},{time:500,value:110}];
    expect(drawIndicatorDivergences(canvas().ctx,[outside],options())).toEqual([]);
  });

  it('keeps every dense-history segment interactive while measuring each repeated caption only once',()=>{
    const draw=canvas();draw.ctx.measureText=vi.fn(text=>({width:[...text].length*7} as TextMetrics));
    const marks=Array.from({length:1500},(_,i)=>mark(evidence({id:`dense:${i}`,direction:i%2?'bearish':'bullish',
      points:[{time:i*10,value:50,price:100},{time:i*10+5,value:80,price:98}]})));
    const hits=drawIndicatorDivergences(draw.ctx,marks,options({project:(time,value)=>({x:20+time%300,y:200-value})}));
    expect(hits).toHaveLength(marks.length);expect(paths(draw.paints)).toHaveLength(marks.length);
    expect(draw.ctx.measureText).toHaveBeenCalledTimes(2);
    expect(hits.map(hit=>hit.divergence.id)).toEqual(marks.map(item=>item.divergence.id));
  });
});
