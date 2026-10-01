import {describe,it,expect} from 'vitest';
import {drawOverlayShapes,layoutOverlayShapes,OVERLAY_SHAPE_METRICS,type OverlayShapeCandidate,type OverlayShapeBounds,type OverlayShapeStyle} from '../src/lib/render/overlay-shapes';

const pane:OverlayShapeBounds={left:0,top:0,right:400,bottom:240};
const signal=(extra:Partial<OverlayShapeCandidate>={}):OverlayShapeCandidate=>({x:100,y:100,shape:'labelup',location:'belowbar',color:'#008000',textColor:'#ffffff',text:'Buy',size:'normal',...extra});
function canvas(){
  const calls:{name:string;args:unknown[];fill:unknown;alpha:unknown;font:unknown}[]=[];
  const state:Record<string,unknown>={globalAlpha:1,font:'12px initial',fillStyle:'initial'},stack:Record<string,unknown>[]=[];
  const context=new Proxy(state,{get(target,key){
    if(typeof key==='string'&&Object.hasOwn(target,key))return target[key];
    return (...args:unknown[])=>{calls.push({name:String(key),args,fill:target.fillStyle,alpha:target.globalAlpha,font:target.font});if(key==='save')stack.push({...target});if(key==='restore'){for(const name of Object.keys(target))delete target[name];Object.assign(target,stack.pop());}};
  }});
  return {ctx:context as unknown as CanvasRenderingContext2D,calls,state};
}

describe('overlay graphics geometry',()=>{
  it('places Buy below the supplied low and Sell above the supplied high without interpreting their text',()=>{
    const input=[signal({y:140}),signal({x:260,y:70,shape:'labeldown',location:'abovebar',color:'#ff0000',text:'Sell'})];
    const [buy,sell]=layoutOverlayShapes(input,pane);
    expect(buy.shapeBounds.top).toBe(140+OVERLAY_SHAPE_METRICS.barGap);
    expect(sell.shapeBounds.bottom).toBe(70-OVERLAY_SHAPE_METRICS.barGap);
    expect(buy.lines).toEqual(['Buy']);expect(sell.lines).toEqual(['Sell']);
    expect(buy.textBounds!.top).toBeGreaterThan(buy.shapeBounds.top);
    expect(sell.textBounds!.bottom).toBeLessThan(sell.shapeBounds.bottom);
    expect((buy.shapeBounds.left+buy.shapeBounds.right)/2).toBe(100);
    expect((sell.shapeBounds.left+sell.shapeBounds.right)/2).toBe(260);
  });
  it('lets location control placement even when text or shape direction suggests the opposite',()=>{
    const [item]=layoutOverlayShapes([signal({shape:'labelup',location:'abovebar',text:'Buy'})],pane);
    expect(item.shapeBounds.bottom).toBeLessThan(100);expect(item.candidate.shape).toBe('labelup');
  });
  it('centers absolute shapes on the projected value and keeps top/bottom graphics inside the pane',()=>{
    const [absolute,top,bottom]=layoutOverlayShapes([signal({location:'absolute',text:''}),signal({location:'top',y:pane.top}),signal({location:'bottom',y:pane.bottom})],pane);
    expect((absolute.shapeBounds.top+absolute.shapeBounds.bottom)/2).toBe(100);
    expect(top.hitBounds.top).toBeGreaterThan(pane.top);expect(bottom.hitBounds.bottom).toBeLessThan(pane.bottom);
  });
  it('changes shape dimensions with size while retaining the same readable text font',()=>{
    const layouts=layoutOverlayShapes(['tiny','small','normal','large','huge'].map(size=>signal({size:size as OverlayShapeCandidate['size'],shape:'circle'})),pane);
    expect(layouts.map(item=>item.shapeBounds.right-item.shapeBounds.left)).toEqual([6,9,12,18,24]);
    expect(new Set(layouts.map(item=>item.fontSize))).toEqual(new Set([11]));
    expect(new Set(layouts.map(item=>item.textBounds!.right-item.textBounds!.left)).size).toBe(1);
  });
  it('uses measured multiline text width and preserves empty lines and source metadata',()=>{
    const source={...signal({text:'BUY\r\n\r\n开仓'}),title:'Original signal',time:1800000000,id:'shape-1'};
    const [item]=layoutOverlayShapes([source],pane,{measureText:line=>line==='开仓'?44:line.length*6});
    expect(item.lines).toEqual(['BUY','','开仓']);expect(item.textBounds!.bottom-item.textBounds!.top).toBe(42);
    expect(item.textBounds!.right-item.textBounds!.left).toBe(44);
    expect(item.shapeBounds.right-item.shapeBounds.left).toBe(54);
    expect(item.candidate).toBe(source);expect(item.candidate.id).toBe('shape-1');
  });
  it('retains overlapping script signals, clips hit bounds and never mutates coordinates',()=>{
    const input=[signal({x:1}),signal({x:1})],before=structuredClone(input),layouts=layoutOverlayShapes(input,pane);
    expect(layouts).toHaveLength(2);expect(layouts[0].shapeBounds.left).toBeLessThan(0);expect(layouts[0].hitBounds.left).toBe(0);
    expect(layouts[0].shapeBounds).toEqual(layouts[1].shapeBounds);expect(input).toEqual(before);
  });
  it('ignores invalid geometry or invisible layers but keeps transparent shapes for independently visible text',()=>{
    expect(layoutOverlayShapes([signal()],{...pane,right:Infinity})).toEqual([]);
    const layouts=layoutOverlayShapes([signal({x:NaN}),signal({y:Infinity}),signal({opacity:0}),signal({opacity:NaN}),signal({x:900}),signal({color:'#00800000'})],pane);
    expect(layouts).toHaveLength(1);expect(layouts[0].index).toBe(5);expect(layouts[0].lines).toEqual(['Buy']);
  });
});

describe('overlay graphics Canvas painter',()=>{
  it('renders user colors and exact multiline text separately, including transparent shape colors',()=>{
    const {ctx,calls}=canvas();
    drawOverlayShapes(ctx,layoutOverlayShapes([signal({color:'#00800000',textColor:'#27a7ff',text:'Buy\nSignal'}),signal({x:250,color:'#ff0000',text:'Sell',shape:'labeldown',location:'abovebar'})],pane),{clipBounds:pane});
    expect(calls.filter(call=>call.name==='fillText').map(call=>call.args[0])).toEqual(['Buy','Signal','Sell']);
    expect(calls.some(call=>call.name==='fill'&&call.fill==='#00800000')).toBe(true);
    expect(calls.some(call=>call.name==='fillText'&&call.fill==='#27a7ff')).toBe(true);
    expect(calls.filter(call=>call.name==='fillText').every(call=>String(call.font).includes('11px'))).toBe(true);
    expect(calls.some(call=>call.name==='roundRect')).toBe(false);
  });
  it('supports the complete shape vocabulary without changing the owner canvas transform',()=>{
    const shapes:OverlayShapeStyle[]=['circle','square','diamond','triangleup','triangledown','arrowup','arrowdown','cross','xcross','labelup','labeldown','flag'];
    for(const shape of shapes){
      const {ctx,calls}=canvas();drawOverlayShapes(ctx,layoutOverlayShapes([signal({shape,text:''})],pane));
      expect(calls.filter(call=>call.name==='fill')).toHaveLength(1);
      expect(calls.some(call=>['arc','rect','moveTo'].includes(call.name))).toBe(true);
      expect(calls.some(call=>['scale','rotate','translate','setTransform','resetTransform','transform'].includes(call.name))).toBe(false);
    }
  });
  it('multiplies layer opacity and restores drawing state',()=>{
    const {ctx,calls,state}=canvas();ctx.globalAlpha=.6;const initial={...state};
    drawOverlayShapes(ctx,layoutOverlayShapes([signal({opacity:.5})],pane));
    expect(calls.filter(call=>call.name==='fill'||call.name==='fillText').every(call=>call.alpha===.3)).toBe(true);
    expect(state).toEqual(initial);
  });
});
