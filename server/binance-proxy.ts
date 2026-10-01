type ProxyEnvironment=Record<string,string|undefined>;
interface NodeProxyApi {setGlobalProxyFromEnv?:(environment:ProxyEnvironment)=>unknown}
/** Configure public HTTP requests in the local Node process only. Older Node
 * APIs can continue without the optional global proxy integration. */
export async function configureBinanceProxy(environment:ProxyEnvironment,loadHttp:()=>Promise<NodeProxyApi>=async()=>{const moduleName='node:http';return import(moduleName) as Promise<NodeProxyApi>;}):Promise<boolean>{
  const http=environment.http_proxy??environment.HTTP_PROXY,https=environment.https_proxy??environment.HTTPS_PROXY;
  if(!http&&!https)return false;
  try{
    const api=await loadHttp();if(typeof api.setGlobalProxyFromEnv!=='function')return false;
    api.setGlobalProxyFromEnv({HTTP_PROXY:http,HTTPS_PROXY:https,NO_PROXY:[environment.no_proxy??environment.NO_PROXY,'localhost','127.0.0.1','::1','[::1]'].filter(Boolean).join(',')});return true;
  }catch{return false;}
}
