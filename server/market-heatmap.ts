/** Heatmaps share the writer's event loop, so bound both running and waiting
 * work. Browser aborts remove queued jobs instead of leaving obsolete scrubs. */
export class HeatmapBusyError extends Error {constructor(){super('热图查询繁忙，请稍后重试');this.name='HeatmapBusyError';}}
const cancelled=()=>new DOMException('热图查询已取消','AbortError');
interface Job<T>{work:(signal:AbortSignal)=>Promise<T>;resolve:(value:T)=>void;reject:(reason:unknown)=>void;controller:AbortController;signal?:AbortSignal;cancel:()=>void;running:boolean}
export class HeatmapScheduler {
  private active?:Job<unknown>;
  private waiting:Job<unknown>[]=[];
  private closed=false;
  run<T>(work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    if(this.closed||signal?.aborted)return Promise.reject(cancelled());
    if(this.active&&this.waiting.length>=2)return Promise.reject(new HeatmapBusyError());
    return new Promise<T>((resolve,reject)=>{
      const job:Job<T>={work,resolve,reject,controller:new AbortController(),signal,running:false,cancel:()=>{}};
      job.cancel=()=>{job.controller.abort();if(!job.running){const index=this.waiting.indexOf(job as Job<unknown>);if(index>=0)this.waiting.splice(index,1);signal?.removeEventListener('abort',job.cancel);reject(cancelled());}};
      signal?.addEventListener('abort',job.cancel,{once:true});
      if(this.active)this.waiting.push(job as Job<unknown>);else this.start(job as Job<unknown>);
    });
  }
  private start(job:Job<unknown>):void {
    this.active=job;job.running=true;
    void Promise.resolve().then(()=>{job.controller.signal.throwIfAborted();return job.work(job.controller.signal);}).then(job.resolve,job.reject).finally(()=>{
      job.signal?.removeEventListener('abort',job.cancel);if(this.active===job)this.active=undefined;
      const next=this.waiting.shift();if(next&&!this.closed)this.start(next);
    });
  }
  close():void {
    if(this.closed)return;this.closed=true;this.active?.controller.abort();
    for(const job of [...this.waiting])job.cancel();this.waiting=[];
  }
}
export async function yieldHeatmap(signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();await new Promise<void>(resolve=>setImmediate(resolve));signal.throwIfAborted();
}
