import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {MarketDataService} from '../server/market-data';
import {HeatmapBusyError} from '../server/market-heatmap';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'heatmap-http-')),service=new MarketDataService({directory,recordLive:false});
  const dataset=service.startRecording('BTCUSDT');let latestRequest:IncomingMessage|undefined,latestResponse:ServerResponse|undefined;
  const server=createServer((request,response)=>{latestRequest=request;latestResponse=response;void service.handle(request,response,()=>{response.statusCode=404;response.end();});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await service.close();await rm(directory,{recursive:true,force:true});});
  return {service,url:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/market-data/datasets/${dataset.id}/heatmap?from=0&to=100&samples=160&levels=40`,latest:()=>({request:latestRequest!,response:latestResponse!})};
}
describe('heatmap request cancellation boundary',()=>{
  it('propagates a real HTTP disconnect and removes cancellation listeners',async()=>{
    const h=await fixture();let captured:AbortSignal|undefined;
    vi.spyOn(h.service.store,'heatmap').mockImplementation(async(_id,_from,_to,_samples,_levels,signal)=>{
      captured=signal;return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}));
    });
    const controller=new AbortController(),pending=fetch(h.url,{signal:controller.signal}).catch(()=>undefined);
    await vi.waitFor(()=>expect(captured).toBeDefined());controller.abort();await pending;
    await vi.waitFor(()=>expect(captured?.aborted).toBe(true));
    await vi.waitFor(()=>{expect(h.latest().request.listenerCount('aborted')).toBe(0);expect(h.latest().response.listenerCount('close')).toBe(0);});
  });
  it('reports queue saturation as a bounded retry instead of launching more replay work',async()=>{
    const h=await fixture();vi.spyOn(h.service.store,'heatmap').mockRejectedValue(new HeatmapBusyError());
    const response=await fetch(h.url);expect(response.status).toBe(429);expect(response.headers.get('retry-after')).toBe('1');
    expect((await response.json()).message).toContain('繁忙');expect(h.latest().request.listenerCount('aborted')).toBe(0);
  });
  it('does not leave cancellation listeners attached after successful sampling',async()=>{
    const h=await fixture(),spy=vi.spyOn(h.service.store,'heatmap');
    const response=await fetch(h.url);expect(response.status).toBe(200);expect((await response.json()).samples).toHaveLength(160);
    expect(spy.mock.calls[0][5]).toBeInstanceOf(AbortSignal);
    expect(h.latest().request.listenerCount('aborted')).toBe(0);expect(h.latest().response.listenerCount('close')).toBe(0);
  });
});
