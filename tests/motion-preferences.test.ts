import {afterEach,describe,expect,it,vi} from 'vitest';
import {readMotionPreference,applyMotionPreference,motionReduced,MOTION_KEY} from '../src/lib/ui/motion-preferences';
afterEach(()=>vi.unstubAllGlobals());
describe('persistent motion policy',()=>{
 it('respects OS reduction and live local changes without touching chart data',()=>{const data=new Map<string,string>(),root={dataset:{}};const page=Object.assign(new EventTarget(),{matchMedia:()=>({matches:false})});vi.stubGlobal('document',{documentElement:root});vi.stubGlobal('window',page);vi.stubGlobal('localStorage',{getItem:(k:string)=>data.get(k),setItem:(k:string,v:string)=>data.set(k,v)});const changed=vi.fn();page.addEventListener('ui-motion-change',changed);expect(readMotionPreference()).toBe('system');applyMotionPreference('off');expect(motionReduced()).toBe(true);expect(data.get(MOTION_KEY)).toBe('off');expect(readMotionPreference()).toBe('off');applyMotionPreference('system');expect(motionReduced()).toBe(false);page.matchMedia=()=>({matches:true});expect(motionReduced()).toBe(true);expect(changed).toHaveBeenCalledTimes(2);});
 it('recovers from unavailable or corrupt preference storage',()=>{vi.stubGlobal('localStorage',{getItem:()=>{throw Error();}});expect(readMotionPreference()).toBe('system');vi.stubGlobal('localStorage',{getItem:()=> 'invalid'});expect(readMotionPreference()).toBe('system');});
});
