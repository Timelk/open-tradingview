import {expect,it,vi} from 'vitest';
import {drawAxesBase,plotGuideSegments,type AxesInput} from '../src/lib/render/axes';
import {DEFAULT_APPEARANCE} from '../src/lib/chart/appearance';
const {gridColor:GRID,upColor:UP,downColor:DOWN}=DEFAULT_APPEARANCE;

function fixture():AxesInput {
  const ctx={canvas:{height:106},clearRect:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),setLineDash:vi.fn(),getTransform:()=>({d:1})};
  return {ctx:ctx as unknown as CanvasRenderingContext2D,plotW:100,plotH:80,axisW:88,axisH:26,paneTicks:[{top:0,height:80,ticks:[{value:10,y:20},{value:20,y:60}]}],xTicks:[{x:10,label:'12:00'}],lastPrice:{y:40,label:'15.00',up:true},crosshair:null,hoverDot:null};
}

it('disabling overlaid guides keeps all axis labels, latest-price tag and pane boundary',()=>{
  const normal=fixture(),labelsOnly=fixture();labelsOnly.plotGuides=false;
  drawAxesBase(normal);drawAxesBase(labelsOnly);
  expect(labelsOnly.ctx.fillText).toHaveBeenCalledTimes(4);
  expect(vi.mocked(labelsOnly.ctx.fillText).mock.calls).toEqual(vi.mocked(normal.ctx.fillText).mock.calls);
  expect(labelsOnly.ctx.stroke).toHaveBeenCalledTimes(1);expect(normal.ctx.stroke).toHaveBeenCalledTimes(5);
  expect(labelsOnly.ctx.setLineDash).not.toHaveBeenCalledWith([4,3]);
  expect(labelsOnly.ctx.fillRect).toHaveBeenCalled();
});

it('exports clipped grid segments and preserves a 4px/3px latest-price dash pattern',()=>{
  const input=fixture();input.plotGuides=false;
  input.paneTicks[0].ticks.push({value:0,y:-20},{value:99,y:140});input.xTicks.push({x:-10,label:'outside'},{x:200,label:'outside'});
  const segments=plotGuideSegments(input),grid=segments.filter(segment=>segment.color===GRID),price=segments.filter(segment=>segment.color===UP);
  expect(grid).toHaveLength(3);expect(price).toHaveLength(15);
  expect(price[0]).toMatchObject({x0:0,x1:4,y0:40.5,y1:40.5});expect(price[1]).toMatchObject({x0:7,x1:11});expect(price.at(-1)?.x1).toBe(100);
  expect(segments.every(s=>s.x0>=0&&s.x1<=100&&s.y0>=0&&s.y1<=80)).toBe(true);
});

it('handles empty plots and offscreen or boundary price lines without extending into axis labels',()=>{
  const input=fixture();input.plotW=0;expect(plotGuideSegments(input)).toEqual([]);
  input.plotW=100;input.lastPrice={y:81,label:'offscreen',up:false};expect(plotGuideSegments(input).every(s=>s.color===GRID)).toBe(true);
  input.lastPrice.y=80;const boundary=plotGuideSegments(input).filter(s=>s.color===DOWN);
  expect(boundary.length).toBeGreaterThan(0);expect(boundary.every(s=>s.y0===80&&s.y1===80&&s.x1<=100)).toBe(true);
});
