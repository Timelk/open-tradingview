import {describe,it,expect,vi} from 'vitest';
import {RenderBackend} from '../src/lib/render/backend';
const state=vi.hoisted(()=>({available:true}));
vi.mock('../src/lib/render/gl',()=>({GLRenderer:class {
  ok=state.available;rect=vi.fn();begin=vi.fn();clearClip=vi.fn();clip=vi.fn();resize=vi.fn();destroy=vi.fn();
}}));
describe.each([true,false])('chart gradient with WebGL %s',available=>{
  it('paints gradient through the active backend and keeps solid mode unchanged',()=>{
    state.available=available;const gradient={addColorStop:vi.fn()};
    const ctx={fillStyle:'',globalAlpha:1,fillRect:vi.fn(),clearRect:vi.fn(),createLinearGradient:vi.fn(()=>gradient)};
    const cpu={width:200,height:100,style:{visibility:''},getContext:()=>ctx},gpu={style:{visibility:''}};
    const r=new RenderBackend(gpu as HTMLCanvasElement,cpu as unknown as HTMLCanvasElement,()=>{},()=>{});
    r.begin('#000000',false,false,'#ffffff');
    if(available){expect(r.gl.rect).toHaveBeenCalledTimes(100);expect(ctx.createLinearGradient).not.toHaveBeenCalled();expect(gpu.style.visibility).toBe('visible');}
    else {expect(ctx.createLinearGradient).toHaveBeenCalledWith(0,0,0,100);expect(gradient.addColorStop.mock.calls).toEqual([[0,'#000000'],[1,'#ffffff']]);expect(cpu.style.visibility).toBe('visible');}
    vi.mocked(r.gl.rect).mockClear();ctx.createLinearGradient.mockClear();r.begin('#151718',false);
    expect(r.gl.rect).not.toHaveBeenCalled();expect(ctx.createLinearGradient).not.toHaveBeenCalled();
  });
});
