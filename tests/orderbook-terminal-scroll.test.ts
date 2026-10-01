import {describe,it,expect,vi} from 'vitest';
import {followBookCenter} from '../src/lib/flow/terminal-scroll';

function harness(){
  const listeners=new Map<string,EventListener>(),frames=new Map<number,FrameRequestCallback>();let next=0,onResize=()=>{};
  const metrics={scrollTop:0,clientHeight:500,scrollHeight:1400,offset:600,markerHeight:50};
  const rect=(top:number,height:number)=>({top,height,left:0,right:300,bottom:top+height,width:300,x:0,y:top,toJSON:()=>({})});
  const element={isConnected:true,get scrollTop(){return metrics.scrollTop;},set scrollTop(value:number){metrics.scrollTop=value;},
    get clientHeight(){return metrics.clientHeight;},get scrollHeight(){return metrics.scrollHeight;},
    querySelector:()=>({getBoundingClientRect:()=>rect(100+metrics.offset-metrics.scrollTop,metrics.markerHeight)}),getBoundingClientRect:()=>rect(100,metrics.clientHeight),
    addEventListener:(name:string,listener:EventListener)=>listeners.set(name,listener),removeEventListener:(name:string)=>listeners.delete(name)} as unknown as HTMLElement;
  const disconnect=vi.fn(),follower=followBookCenter(element,{requestFrame:callback=>{frames.set(++next,callback);return next;},cancelFrame:id=>{frames.delete(id);},observeResize:(_element,callback)=>{onResize=callback;return disconnect;}});
  return {metrics,element,follower,disconnect,listeners,frames,resize:()=>onResize(),flush:()=>{for(const [id,callback] of [...frames]){frames.delete(id);callback(0);}},wheel:()=>listeners.get('wheel')?.(new Event('wheel'))};
}

describe('Book spread centering without hijacking manual reading',()=>{
  it('centers after first layout and compensates when ask geometry or container size changes',()=>{
    const h=harness();h.follower.update('BTC:book','27:27');h.flush();expect(h.metrics.scrollTop).toBe(375);
    h.metrics.offset=660;h.follower.update('BTC:book','30:27');h.flush();expect(h.metrics.scrollTop).toBe(435);
    h.metrics.clientHeight=600;h.resize();h.flush();expect(h.metrics.scrollTop).toBe(385);
  });
  it('does not schedule another center for quantity-only updates with the same row geometry',()=>{
    const h=harness();h.follower.update('BTC:book','27:27');h.flush();expect(h.frames.size).toBe(0);
    for(let i=0;i<10;i++)h.follower.update('BTC:book','27:27');
    expect(h.frames.size).toBe(0);expect(h.metrics.scrollTop).toBe(375);
  });
  it('preserves a manual scroll through later rows and resize, then explicitly resumes',()=>{
    const h=harness();h.follower.update('BTC:book','27:27');h.flush();h.wheel();h.metrics.scrollTop=120;
    h.metrics.offset=660;h.follower.update('BTC:book','30:27');h.resize();h.flush();
    expect(h.follower.following()).toBe(false);expect(h.metrics.scrollTop).toBe(120);
    h.follower.resume();h.flush();expect(h.metrics.scrollTop).toBe(435);
  });
  it('cancels pending centering if the user scrolls before the animation frame',()=>{
    const h=harness();h.follower.update('BTC:book','27:27');h.wheel();h.metrics.scrollTop=140;h.flush();
    expect(h.metrics.scrollTop).toBe(140);expect(h.frames.size).toBe(0);
  });
  it('re-centers after switching view or market and releases all listeners on destroy',()=>{
    const h=harness();h.follower.update('BTC:book','27:27');h.flush();h.wheel();h.metrics.scrollTop=10;
    h.follower.update('BTC:delta','2:2');h.flush();expect(h.metrics.scrollTop).toBe(375);
    h.follower.destroy();h.resize();expect(h.frames.size).toBe(0);expect(h.listeners.size).toBe(0);expect(h.disconnect).toHaveBeenCalledOnce();
  });
});
