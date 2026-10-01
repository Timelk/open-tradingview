import { describe, expect, it } from 'vitest';
import { positionDrawingToolbar, type ToolbarBounds, type ToolbarPosition, type ToolbarSize } from '../src/lib/drawing/toolbar-position';

const container={width:1000,height:650},size={width:420,height:40};
const overlaps=(p:ToolbarPosition,s:ToolbarSize,b:ToolbarBounds)=>p.x<b.right&&p.x+s.width>b.left&&p.y<b.bottom&&p.y+s.height>b.top;
function expectInside(p:ToolbarPosition,s=size,c=container){
  expect(p.x).toBeGreaterThanOrEqual(8);expect(p.y).toBeGreaterThanOrEqual(26);
  expect(p.x+s.width).toBeLessThanOrEqual(c.width-88);expect(p.y+s.height).toBeLessThanOrEqual(c.height-32);
}

describe('drawing toolbar collision avoidance',()=>{
  it('keeps the just-created 110px ellipse body and control points free to grab',()=>{
    const bounds={left:200,right:400,top:200,bottom:310};
    const p=positionDrawingToolbar({x:400,y:310,bounds},size,container);
    expectInside(p);expect(p.y+size.height).toBeLessThanOrEqual(bounds.top-10);
    expect(overlaps(p,size,{left:190,right:410,top:190,bottom:320})).toBe(false);
  });
  it('moves below a drawing near the top instead of clamping over its interior',()=>{
    const bounds={left:200,right:400,top:30,bottom:140};
    const p=positionDrawingToolbar({x:400,y:140,bounds},size,container);
    expectInside(p);expect(p.y).toBeGreaterThanOrEqual(bounds.bottom+10);expect(overlaps(p,size,bounds)).toBe(false);
  });
  it.each([
    {bounds:{left:500,right:650,top:20,bottom:620},side:'left'},
    {bounds:{left:20,right:150,top:20,bottom:620},side:'right'},
  ])('uses the $side side when there is no room above or below',({bounds,side})=>{
    const toolbar={width:200,height:50};const p=positionDrawingToolbar({x:bounds.right,y:320,bounds},toolbar,container);
    expectInside(p,toolbar);expect(overlaps(p,toolbar,bounds)).toBe(false);
    if(side==='left')expect(p.x+toolbar.width).toBeLessThanOrEqual(bounds.left-10);
    else expect(p.x).toBeGreaterThanOrEqual(bounds.right+10);
  });
  it('stays on screen and leaves the pointer free when the drawing fills the entire chart',()=>{
    const bounds={left:-200,right:1200,top:-200,bottom:900},anchor={x:500,y:325,bounds};
    const p=positionDrawingToolbar(anchor,size,container);expectInside(p);
    expect(overlaps(p,size,{left:486,right:514,top:311,bottom:339})).toBe(false);
  });
  it('handles partially offscreen and reversed bounds without moving the input geometry',()=>{
    const bounds=Object.freeze({left:400,right:200,top:140,bottom:-600});
    const p=positionDrawingToolbar({x:400,y:140,bounds},size,container);
    expectInside(p);expect(p.y).toBeGreaterThanOrEqual(150);
    expect(bounds).toEqual({left:400,right:200,top:140,bottom:-600});
  });
  it('keeps single-point toolbars inside chart space and clear of the grab handle',()=>{
    const anchor={x:900,y:590};const p=positionDrawingToolbar(anchor,size,container);expectInside(p);
    expect(overlaps(p,size,{left:886,right:914,top:576,bottom:604})).toBe(false);
  });
  it('avoids the pointer when wrapping makes the toolbar tall in a narrow chart',()=>{
    const chart={width:460,height:400},toolbar={width:340,height:90};
    const p=positionDrawingToolbar({x:230,y:180,bounds:{left:0,right:460,top:90,bottom:360}},toolbar,chart);
    expectInside(p,toolbar,chart);expect(overlaps(p,toolbar,{left:216,right:244,top:166,bottom:194})).toBe(false);
  });
});
