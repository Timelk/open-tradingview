import {expect,it,vi} from 'vitest';
import {configureBinanceProxy} from '../server/binance-proxy';

it('enables the configured public HTTP proxy and safely tolerates older Node APIs',async()=>{
  const setGlobalProxyFromEnv=vi.fn(),load=vi.fn(async()=>({setGlobalProxyFromEnv}));
  expect(await configureBinanceProxy({},load)).toBe(false);expect(load).not.toHaveBeenCalled();
  expect(await configureBinanceProxy({HTTPS_PROXY:'http://configured-proxy:8080',NO_PROXY:'.internal'},load)).toBe(true);
  expect(setGlobalProxyFromEnv).toHaveBeenCalledWith({HTTP_PROXY:undefined,HTTPS_PROXY:'http://configured-proxy:8080',NO_PROXY:'.internal,localhost,127.0.0.1,::1,[::1]'});
  expect(await configureBinanceProxy({HTTPS_PROXY:'http://configured-proxy:8080'},async()=>({}))).toBe(false);
});
