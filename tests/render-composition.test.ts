import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RenderBackend } from '../src/lib/render/backend';

const graphics=vi.hoisted(()=>({available:true,events:{} as {onContextLost?:()=>void;onContextRestored?:()=>void}}));
vi.mock('../src/lib/render/gl',()=>({GLRenderer:class {
  ok=graphics.available;
  constructor(_canvas:unknown,events:typeof graphics.events){graphics.events=events;}
  begin=vi.fn();clearClip=vi.fn();clip=vi.fn();resize=vi.fn();rect=vi.fn();seg=vi.fn();marker=vi.fn();destroy=vi.fn();
  reinit(){return this.ok=graphics.available;}
}}));

function backend(){
  const ctx={globalAlpha:1,fillStyle:'',fillRect:vi.fn(),clearRect:vi.fn(),drawImage:vi.fn(),setTransform:vi.fn(),save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn()};
  const gpu={style:{visibility:''}},cpu={width:1600,height:1000,style:{visibility:''},getContext:()=>ctx};
  const renderer=new RenderBackend(gpu as unknown as HTMLCanvasElement,cpu as unknown as HTMLCanvasElement,()=>{},()=>{});
  renderer.resize(800,500,2);
  return {renderer,ctx,gpu,cpu};
}
beforeEach(()=>{graphics.available=true;graphics.events={};});

describe('direct GPU with transparent Canvas drawings',()=>{
  it('renders top drawings without copying the GPU image and clears old drawing pixels next frame',()=>{
    const {renderer,ctx,gpu,cpu}=backend();renderer.begin('#181c20',false,true);
    expect(gpu.style.visibility).toBe('visible');expect(cpu.style.visibility).toBe('visible');
    expect(renderer.gl.begin).toHaveBeenCalledWith('#181c20',1);
    expect(ctx.clearRect).toHaveBeenCalledWith(0,0,800,500);expect(ctx.fillRect).not.toHaveBeenCalled();
    renderer.rect(10,20,30,40,'#26a69a');
    const drawing=vi.fn((c:CanvasRenderingContext2D)=>c.fillRect(50,60,70,80));renderer.canvasLayer(drawing);renderer.flush();
    expect(drawing).toHaveBeenCalledOnce();expect(ctx.drawImage).not.toHaveBeenCalled();
    renderer.begin('#181c20',false,true);expect(ctx.clearRect).toHaveBeenCalledTimes(2);
    expect(ctx.drawImage).not.toHaveBeenCalled();renderer.destroy();
  });
  it('shows and hides the drawing surface even while the GPU stays in direct mode',()=>{
    const {renderer,cpu,gpu,ctx}=backend();renderer.begin('#181c20',false);
    expect(cpu.style.visibility).toBe('hidden');expect(gpu.style.visibility).toBe('visible');
    renderer.begin('#181c20',false,true);expect(cpu.style.visibility).toBe('visible');
    renderer.begin('#181c20',false,false);expect(cpu.style.visibility).toBe('hidden');
    renderer.begin('#181c20',false,true);expect(cpu.style.visibility).toBe('visible');
    expect(ctx.clearRect).toHaveBeenCalledTimes(2);expect(ctx.drawImage).not.toHaveBeenCalled();renderer.destroy();
  });
  it('retains ordered GPU runs around a drawing when compositing is required',()=>{
    const {renderer,ctx,gpu,cpu}=backend();renderer.begin('#181c20',true,true);
    expect(gpu.style.visibility).toBe('hidden');expect(cpu.style.visibility).toBe('visible');
    expect(ctx.fillRect).toHaveBeenCalledWith(0,0,800,500);expect(ctx.clearRect).not.toHaveBeenCalled();
    renderer.rect(10,20,30,40,'#26a69a');renderer.canvasLayer(c=>c.fillRect(50,60,70,80));
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    renderer.rect(50,60,70,80,'#ef5350');renderer.flush();expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    const copyOrder=ctx.drawImage.mock.invocationCallOrder,paintOrder=ctx.fillRect.mock.invocationCallOrder;
    expect(copyOrder[0]).toBeLessThan(paintOrder[1]);expect(paintOrder[1]).toBeLessThan(copyOrder[1]);
    renderer.begin('#181c20',false,true);expect(gpu.style.visibility).toBe('visible');expect(ctx.clearRect).toHaveBeenCalledOnce();renderer.destroy();
  });
  it('keeps fallback opaque and can return from context loss to the transparent drawing path',()=>{
    const {renderer,ctx,gpu,cpu}=backend();renderer.begin('#181c20',false,true);
    graphics.events.onContextLost?.();renderer.begin('#181c20',false,true);
    expect(renderer.mode).toBe('Canvas2D');expect(gpu.style.visibility).toBe('hidden');expect(cpu.style.visibility).toBe('visible');
    expect(ctx.fillRect).toHaveBeenCalledWith(0,0,800,500);
    renderer.rect(10,20,30,40,'#26a69a');expect(ctx.fillRect).toHaveBeenLastCalledWith(10,20,20,20);
    renderer.canvasLayer(c=>c.fillRect(50,60,70,80));renderer.flush();expect(ctx.drawImage).not.toHaveBeenCalled();
    graphics.events.onContextRestored?.();renderer.begin('#181c20',false,true);
    expect(renderer.mode).toBe('WebGL2');expect(gpu.style.visibility).toBe('visible');expect(cpu.style.visibility).toBe('visible');
    expect(ctx.clearRect).toHaveBeenCalledTimes(2);renderer.destroy();
  });
  it('uses the opaque Canvas surface when WebGL is unavailable from startup',()=>{
    graphics.available=false;const {renderer,ctx,gpu,cpu}=backend();renderer.begin('#181c20',false,true);
    expect(renderer.mode).toBe('Canvas2D');expect(gpu.style.visibility).toBe('hidden');expect(cpu.style.visibility).toBe('visible');
    expect(ctx.fillRect).toHaveBeenCalledWith(0,0,800,500);expect(ctx.clearRect).not.toHaveBeenCalled();
    renderer.rect(10,20,30,40,'#26a69a');renderer.flush();expect(ctx.drawImage).not.toHaveBeenCalled();renderer.destroy();
  });
});
