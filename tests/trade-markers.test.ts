import {describe,it,expect} from 'vitest';
import {drawTradeMarkers,layoutTradeMarkers,TRADE_MARKER_COLORS,TRADE_MARKER_LIGHT_COLORS,TRADE_MARKER_METRICS,type MarkerBounds,type MarkerCandidate} from '../src/lib/render/trade-markers';
const bounds:MarkerBounds={left:0,top:0,right:400,bottom:240};
const buy=(x=100,y=100):MarkerCandidate=>({id:`buy:${x}:${y}`,x,y,side:'buy',kind:'signal'});
const sell=(x=250,y=100):MarkerCandidate=>({id:`sell:${x}:${y}`,x,y,side:'sell',kind:'fill',label:'Close Long'});
const overlaps=(a:MarkerBounds,b:MarkerBounds)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
function canvas(){
  const calls:{name:string;args:unknown[];stroke:unknown;fill:unknown;alpha:unknown;font:unknown}[]=[];
  const state:Record<string,unknown>={globalAlpha:1,font:'12px initial',strokeStyle:'initial',fillStyle:'initial'},stack:Record<string,unknown>[]=[];
  const context=new Proxy(state,{get(target,key){
    if(typeof key==='string'&&Object.hasOwn(target,key))return target[key];
    return (...args:unknown[])=>{calls.push({name:String(key),args,stroke:target.strokeStyle,fill:target.fillStyle,alpha:target.globalAlpha,font:target.font});if(key==='save')stack.push({...target});if(key==='restore'){for(const name of Object.keys(target))delete target[name];Object.assign(target,stack.pop());}};
  }});
  return {ctx:context as unknown as CanvasRenderingContext2D,calls,state};
}

describe('trade marker layout in CSS pixels',()=>{
  it('keeps buy labels strictly below and sell labels strictly above their exact anchors',()=>{
    const candidates=[buy(),sell()],layouts=layoutTradeMarkers(candidates,bounds);
    expect(layouts.map(item=>item.mode)).toEqual(['label','label']);
    for(const item of layouts){
      expect(item.anchor).toEqual({x:item.candidate.x,y:item.candidate.y});expect(item.labelBounds!.right-item.labelBounds!.left).toBe(50);expect(item.labelBounds!.bottom-item.labelBounds!.top).toBe(23);
      expect((item.labelBounds!.left+item.labelBounds!.right)/2).toBe(item.anchor.x);
      expect(item.leader!.from.x).toBe(item.anchor.x);expect(item.leader!.to.x).toBe(item.anchor.x);
    }
    expect(layouts[0].labelBounds!.top).toBeGreaterThan(layouts[0].anchor.y);expect(layouts[0].arrow!.direction).toBe('up');
    expect(layouts[1].labelBounds!.bottom).toBeLessThan(layouts[1].anchor.y);expect(layouts[1].arrow!.direction).toBe('down');
  });
  it('uses compact arrows near pane edges without reversing sides or moving labels sideways',()=>{
    const layouts=layoutTradeMarkers([buy(100,216),sell(250,24)],bounds);
    expect(layouts.map(item=>item.mode)).toEqual(['compact','compact']);
    expect(layouts[0].labelBounds!.top).toBeGreaterThan(216);expect(layouts[0].labelBounds!.bottom).toBeLessThanOrEqual(240);
    expect(layouts[1].labelBounds!.bottom).toBeLessThan(24);expect(layouts[1].labelBounds!.top).toBeGreaterThanOrEqual(0);
    for(const item of layouts)expect((item.labelBounds!.left+item.labelBounds!.right)/2).toBe(item.anchor.x);
  });
  it('retains only the exact circle at extreme vertical or horizontal edges',()=>{
    const layouts=layoutTradeMarkers([buy(100,238),sell(200,2),buy(1,100)],bounds);
    expect(layouts.map(item=>item.mode)).toEqual(['anchor','anchor','anchor']);expect(layouts.every(item=>item.labelBounds===null&&item.leader===null&&item.arrow===null)).toBe(true);
    expect(layouts.map(item=>item.anchor)).toEqual([{x:100,y:238},{x:200,y:2},{x:1,y:100}]);
  });
  it('preserves anchor dots during dense collisions and never overlaps accepted tag boxes',()=>{
    const candidates=Array.from({length:30},(_,index)=>buy(35+index*10,100)),layouts=layoutTradeMarkers(candidates,bounds),boxes=layouts.flatMap(item=>item.labelBounds?[item.labelBounds]:[]);
    expect(layouts).toHaveLength(candidates.length);expect(layouts.some(item=>item.mode==='anchor')).toBe(true);expect(layouts.some(item=>item.mode==='label')).toBe(true);
    for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)expect(overlaps(boxes[i],boxes[j])).toBe(false);
    for(const item of layouts){expect(item.anchor.x).toBe(item.candidate.x);if(item.labelBounds)expect((item.labelBounds.left+item.labelBounds.right)/2).toBe(item.candidate.x);}
  });
  it('reserves all anchors first so a preceding label cannot cover a later cross-point',()=>{
    const candidates=[buy(100,100),buy(105,123)],layouts=layoutTradeMarkers(candidates,bounds);
    for(const item of layouts)for(const other of layouts)if(item.labelBounds)expect(overlaps(item.labelBounds,other.anchorBounds)).toBe(false);
  });
  it('accepts prior-layer occupied boxes without mutating them and preserves tooltip metadata',()=>{
    const marker={...buy(),ownerId:'strategy-1',tradeId:'entry-42'},baseline=layoutTradeMarkers([marker],bounds)[0],occupied=[{...baseline.labelBounds!}],before=structuredClone(occupied);
    const item=layoutTradeMarkers([marker],bounds,{occupiedRects:occupied})[0];expect(item.mode).not.toBe('label');expect(item.candidate.ownerId).toBe('strategy-1');expect(item.candidate.tradeId).toBe('entry-42');expect(occupied).toEqual(before);
    expect(item.hitBounds.left).toBeLessThanOrEqual(marker.x);expect(item.hitBounds.right).toBeGreaterThanOrEqual(marker.x);
  });
  it('limits expensive labels separately while retaining compact or anchor representations',()=>{
    const candidates=Array.from({length:20},(_,index)=>buy(40+index*60,80)),layouts=layoutTradeMarkers(candidates,{left:0,top:0,right:1300,bottom:200},{maxLabels:2});
    expect(layouts.filter(item=>item.mode==='label')).toHaveLength(2);expect(layouts).toHaveLength(20);expect(layouts.slice(2).every(item=>item.mode==='compact'||item.mode==='anchor')).toBe(true);
  });
  it('bounds candidate work and includes the latest marker when input is larger than its budget',()=>{
    let reads=0;const count=100000,candidates=new Proxy({length:count} as MarkerCandidate[],{get(target,key){if(key==='length')return count;if(typeof key==='string'&&/^\d+$/.test(key)){reads++;return {...buy(Number(key)%350+25,100),id:key};}return Reflect.get(target,key);}});
    const layouts=layoutTradeMarkers(candidates,bounds,{maxMarkers:128});expect(reads).toBe(128);expect(layouts).toHaveLength(128);expect(layouts[0].index).toBe(0);expect(layouts.at(-1)!.index).toBe(count-1);
  });
  it('rejects invalid or invisible candidates and handles invalid or extreme bounds without unbounded allocations',()=>{
    expect(layoutTradeMarkers([buy()],{left:0,top:0,right:Infinity,bottom:10})).toEqual([]);expect(layoutTradeMarkers([buy()],bounds,{maxMarkers:0})).toEqual([]);
    expect(layoutTradeMarkers([{...buy(),x:NaN},{...buy(),opacity:0},{...buy(),opacity:Infinity},buy(-5,10)],bounds)).toEqual([]);
    expect(layoutTradeMarkers([buy()],{left:0,top:0,right:1e12,bottom:200})).toHaveLength(1);
  });
  it('is deterministic and leaves input marker geometry unchanged',()=>{
    const candidates=[buy(),sell()],before=structuredClone(candidates);expect(layoutTradeMarkers(candidates,bounds)).toEqual(layoutTradeMarkers(candidates,bounds));expect(candidates).toEqual(before);
  });
});

describe('trade marker canvas painting',()=>{
  it('shows the actual signal source in system tags without changing untagged code-owned captions',()=>{
    const {ctx,calls}=canvas(),layouts=layoutTradeMarkers([{...sell(100,100),sourceTag:'RSI'}, {...sell(280,100),sourceTag:'成交'}],bounds);
    expect(layouts.every(item=>item.mode==='label')).toBe(true);expect(layouts.every(item=>item.labelBounds!.right-item.labelBounds!.left>50&&item.labelBounds!.right-item.labelBounds!.left<100)).toBe(true);
    drawTradeMarkers(ctx,layouts);expect(calls.filter(call=>call.name==='fillText').map(call=>call.args[0])).toEqual(['RSI · 卖出','成交 · 卖出']);
    expect(layouts.map(item=>item.anchor)).toEqual([{x:100,y:100},{x:280,y:100}]);
  });
  it('paints readable Chinese text and direction arrows with green buy and coral close-sell colors',()=>{
    const {ctx,calls}=canvas(),layouts=layoutTradeMarkers([buy(),sell()],bounds);drawTradeMarkers(ctx,layouts,{clipBounds:bounds});
    expect(calls.filter(call=>call.name==='fillText').map(call=>call.args[0])).toEqual(['买入','卖出']);
    expect(calls.some(call=>call.name==='stroke'&&call.stroke===TRADE_MARKER_COLORS.buy.accent)).toBe(true);expect(calls.some(call=>call.name==='stroke'&&call.stroke===TRADE_MARKER_COLORS.sell.accent)).toBe(true);
    expect(calls.filter(call=>call.name==='fillText').every(call=>String(call.font).includes(`${TRADE_MARKER_METRICS.fontSize}px`))).toBe(true);
    expect(calls.filter(call=>call.name==='arc').map(call=>call.args.slice(0,2))).toContainEqual([250,100]);expect(calls.filter(call=>call.name==='arc')).toHaveLength(3);
  });
  it('does not scale or reset the DPR transform and restores inherited canvas styles and opacity',()=>{
    const {ctx,calls,state}=canvas();ctx.globalAlpha=.6;const before={...state};drawTradeMarkers(ctx,layoutTradeMarkers([{...buy(),opacity:.5}],bounds));
    expect(calls.some(call=>['scale','setTransform','resetTransform','transform'].includes(call.name))).toBe(false);expect(calls.some(call=>call.name==='fillText'&&call.alpha===.3)).toBe(true);expect(state).toEqual(before);
  });
  it('honors explicit user hex colors, while invalid overrides fall back to the side palette',()=>{
    const {ctx,calls}=canvas();drawTradeMarkers(ctx,layoutTradeMarkers([{...buy(),color:'#48a7ff'},{...sell(),color:'not-a-color'}],bounds));
    expect(calls.some(call=>call.name==='stroke'&&call.stroke==='#48a7ff')).toBe(true);expect(calls.some(call=>call.name==='stroke'&&call.stroke===TRADE_MARKER_COLORS.sell.accent)).toBe(true);
  });
  it('draws arrows and anchors without text when only compact edge space remains',()=>{
    const {ctx,calls}=canvas();drawTradeMarkers(ctx,layoutTradeMarkers([buy(100,216)],bounds));expect(calls.some(call=>call.name==='fillText')).toBe(false);expect(calls.some(call=>call.name==='arc')).toBe(true);expect(calls.some(call=>call.name==='lineTo')).toBe(true);
  });
});

describe('trade marker tone',()=>{
  it('paints pale paper labels with dark text on light charts and keeps custom colors legible',()=>{
    const dark=canvas(),light=canvas(),layouts=layoutTradeMarkers([buy(),sell()],bounds);
    drawTradeMarkers(dark.ctx,layouts);drawTradeMarkers(light.ctx,layouts,{tone:'light'});
    expect(dark.calls.some(c=>c.name==='fill'&&c.fill===TRADE_MARKER_COLORS.buy.background)).toBe(true);
    expect(light.calls.some(c=>c.name==='fill'&&c.fill===TRADE_MARKER_LIGHT_COLORS.buy.background)).toBe(true);
    expect(light.calls.some(c=>c.name==='fill'&&c.fill===TRADE_MARKER_COLORS.buy.background)).toBe(false);
    expect(light.calls.filter(c=>c.name==='fillText').every(c=>c.fill===TRADE_MARKER_LIGHT_COLORS.buy.text||c.fill===TRADE_MARKER_LIGHT_COLORS.sell.text)).toBe(true);
    const custom=canvas();drawTradeMarkers(custom.ctx,layoutTradeMarkers([{...buy(),color:'#48a7ff'}],bounds),{tone:'light'});
    const bg=custom.calls.filter(c=>c.name==='fill').map(c=>String(c.fill)).find(f=>f.startsWith('rgb('))!;
    expect(bg.match(/\d+/g)!.map(Number).every(channel=>channel>=200)).toBe(true);
  });
});
