import { defineConfig,loadEnv,type Plugin } from 'vite';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import {configureBinanceProxy} from './server/binance-proxy';
import {createMarketDataHandler} from './server/market-data';
import {createPublicMarketBridge} from './server/public-market';
import {createDepthSamplerHandler} from './server/depth-sampler';
import {createAgentBridgeHub} from './server/agent-bridge';

/** These public reports are linked from the research panel in built previews. */
function publicResearchReports():Plugin {
  let root='';
  const reports=['acceptance-generated.md','acceptance-generated.json','anchor-review-round2-score.md'];
  return {name:'public-research-reports',configResolved(config){root=config.root;},generateBundle(){
    for(const report of reports){const fileName=`docs/technical-analysis-plan-2026-09-23/${report}`;
      this.emitFile({type:'asset',fileName,source:readFileSync(resolve(root,fileName))});
    }
  }};
}

export default defineConfig(async({mode})=>{
  const nodeProcess=(globalThis as unknown as {process:{cwd():string;env:Record<string,string|undefined>}}).process;
  const env=loadEnv(mode,nodeProcess.cwd(),'');
  await configureBinanceProxy({...env,...nodeProcess.env});
  const marketPlugin:Plugin={name:'local-market-data-archive',
    async configureServer(server){await mountMarketData(server,{...env,...nodeProcess.env});},
    async configurePreviewServer(server){await mountMarketData(server,{...env,...nodeProcess.env});},
  };
  const publicMarketPlugin:Plugin={name:'public-market-bridge',
    configureServer(server){mountPublicMarket(server,{...env,...nodeProcess.env});},
    configurePreviewServer(server){mountPublicMarket(server,{...env,...nodeProcess.env});},
  };
  const depthSamplerPlugin:Plugin={name:'local-depth-sampler',
    configureServer(server){mountDepthSampler(server,{...env,...nodeProcess.env});},
    configurePreviewServer(server){mountDepthSampler(server,{...env,...nodeProcess.env});},
  };
  const agentBridgePlugin:Plugin={name:'local-agent-bridge',
    configureServer(server){mountAgentBridge(server,server.config.root);},
    configurePreviewServer(server){mountAgentBridge(server,server.config.root);},
  };
  return {plugins:[svelte(),publicResearchReports(),marketPlugin,publicMarketPlugin,depthSamplerPlugin,agentBridgePlugin],worker:{format:'es' as const}};
});

/** One local writer per development process, including config hot reloads. */
async function mountMarketData(server:{middlewares:{use(handler:(req:unknown,res:unknown,next:()=>void)=>void):unknown};httpServer?:{once(event:string,fn:()=>void):unknown}|null},environment:Record<string,string|undefined>){
  const runtime=globalThis as unknown as {__tvchartMarketData?:ReturnType<typeof createMarketDataHandler>};
  if(runtime.__tvchartMarketData)await runtime.__tvchartMarketData.close();
  const proxy=environment.https_proxy??environment.HTTPS_PROXY??environment.http_proxy??environment.HTTP_PROXY;
  const handler=createMarketDataHandler({proxy});runtime.__tvchartMarketData=handler;
  server.middlewares.use((req,res,next)=>{void handler(req as Parameters<typeof handler>[0],res as Parameters<typeof handler>[1],next);});
  server.httpServer?.once('close',()=>{if(runtime.__tvchartMarketData===handler)delete runtime.__tvchartMarketData;void handler.close();});
}

function mountPublicMarket(server:{middlewares:{use(handler:(req:unknown,res:unknown,next:()=>void)=>void):unknown};httpServer?:unknown},environment:Record<string,string|undefined>){
  const runtime=globalThis as unknown as {__tvchartPublicMarket?:{close():void;detach?:()=>void}};
  runtime.__tvchartPublicMarket?.detach?.();runtime.__tvchartPublicMarket?.close();
  const bridge=createPublicMarketBridge({proxy:environment.https_proxy??environment.HTTPS_PROXY??environment.http_proxy??environment.HTTP_PROXY});
  const host=server.httpServer as import('node:http').Server|undefined;
  const detach=host?bridge.attach(host):undefined;runtime.__tvchartPublicMarket={...bridge,detach};
  server.middlewares.use((req,res,next)=>{void bridge.middleware(req as Parameters<typeof bridge.middleware>[0],res as Parameters<typeof bridge.middleware>[1],next);});
  host?.once('close',()=>{detach?.();bridge.close();});
}

/** Always-on local order-book sampler behind the chart heatmap history. */
function mountDepthSampler(server:{middlewares:{use(handler:(req:unknown,res:unknown,next:()=>void)=>void):unknown};httpServer?:{once(event:string,fn:()=>void):unknown}|null},environment:Record<string,string|undefined>){
  const runtime=globalThis as unknown as {__tvchartDepthSampler?:ReturnType<typeof createDepthSamplerHandler>};
  runtime.__tvchartDepthSampler?.close();
  const handler=createDepthSamplerHandler({proxy:environment.https_proxy??environment.HTTPS_PROXY??environment.http_proxy??environment.HTTP_PROXY});runtime.__tvchartDepthSampler=handler;
  server.middlewares.use((req,res,next)=>{void handler(req as Parameters<typeof handler>[0],res as Parameters<typeof handler>[1],next);});
  server.httpServer?.once('close',()=>{if(runtime.__tvchartDepthSampler===handler)delete runtime.__tvchartDepthSampler;handler.close();});
}

/** Local MCP relay: chart pages connect over same-origin WebSocket, the MCP
 * server over loopback HTTP, discovered through .data/agent-bridge/hubs. */
function mountAgentBridge(server:{middlewares:{use(handler:(req:unknown,res:unknown,next:()=>void)=>void):unknown};httpServer?:unknown},root:string){
  const runtime=globalThis as unknown as {__tvchartAgentBridge?:{close():void;detach?:()=>void}};
  runtime.__tvchartAgentBridge?.detach?.();runtime.__tvchartAgentBridge?.close();
  const hub=createAgentBridgeHub({root});
  const host=server.httpServer as import('node:http').Server|undefined;
  const detach=host?hub.attach(host):undefined;runtime.__tvchartAgentBridge={close:hub.close,detach};
  server.middlewares.use((req,res,next)=>{void hub.middleware(req as Parameters<typeof hub.middleware>[0],res as Parameters<typeof hub.middleware>[1],next);});
  host?.once('close',()=>{detach?.();hub.close();});
}
