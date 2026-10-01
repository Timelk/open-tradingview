import { describe, expect, it, vi } from 'vitest';
import { RenderBackend } from '../src/lib/render/backend';

const graphics = vi.hoisted(() => ({ available: true }));
vi.mock('../src/lib/render/gl', () => ({ GLRenderer: class {
  ok = graphics.available;
  begin(){} clearClip(){} clip(){} resize(){} destroy(){}
} }));

function surface(){
  let width=1600,height=1000,pixels='previous frame';
  const writes:string[]=[];
  const ctx={setTransform:vi.fn(),restore:vi.fn(),save:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn()};
  const cpu={
    get width(){return width;},set width(value:number){width=value;pixels='cleared';writes.push('width');},
    get height(){return height;},set height(value:number){height=value;pixels='cleared';writes.push('height');},
    style:{visibility:''},getContext:()=>ctx,
  };
  const renderer=new RenderBackend({style:{visibility:''}} as HTMLCanvasElement,cpu as unknown as HTMLCanvasElement,()=>{},()=>{});
  return {renderer,ctx,cpu,writes,pixels:()=>pixels};
}

describe.each([true,false])('resize preserves existing pixels when WebGL availability is %s',available=>{
  it('does not reset an unchanged drawing buffer',()=>{
    graphics.available=available;const h=surface();
    h.renderer.resize(800,500,2);h.renderer.resize(800,500,2);
    expect(h.writes).toEqual([]);expect(h.pixels()).toBe('previous frame');
    expect(h.ctx.setTransform).toHaveBeenLastCalledWith(2,0,0,2,0,0);h.renderer.destroy();
  });
  it('only resets the dimension that actually changed',()=>{
    graphics.available=available;const h=surface();h.renderer.resize(800,510,2);
    expect(h.writes).toEqual(['height']);expect(h.cpu.width).toBe(1600);expect(h.cpu.height).toBe(1020);h.renderer.destroy();
  });
});

it('unwinds an active fallback clip before an unchanged-size resize',()=>{
  graphics.available=false;const h=surface();h.renderer.clip(0,0,100,100);h.renderer.resize(800,500,2);
  expect(h.ctx.restore).toHaveBeenCalledOnce();expect(h.pixels()).toBe('previous frame');h.renderer.destroy();
});
