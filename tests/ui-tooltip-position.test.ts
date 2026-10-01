import {describe,it,expect} from 'vitest';
import {tooltipPosition} from '../src/lib/ui/tooltips';
import {icons} from '../src/lib/ui/icons/catalog';
describe('tooltip collision handling',()=>{
 it('places rail hints next to their control without covering it',()=>{expect(tooltipPosition({left:0,right:48,top:100,bottom:130},200,40,{width:1440,height:900},'right')).toEqual({x:56,y:95});});
 it('flips to the opposite side and clamps within the visible viewport',()=>{const p=tooltipPosition({left:350,right:374,top:770,bottom:800},280,60,{width:375,height:812},'right');expect(p.x).toBe(62);expect(p.y+60).toBeLessThanOrEqual(804);const q=tooltipPosition({left:0,right:24,top:775,bottom:800},280,60,{width:375,height:812});expect(q).toEqual({x:8,y:707});});
});
describe('curated SVG icon catalog',()=>{
 it('covers terminal and dedicated chart gestures with static vector primitives',()=>{for(const name of ['trend','ray','extended','horizontal','vertical','channel','fib','position','position-short','code','gear','magnet','watchlist','objects'])expect(icons[name]?.length).toBeGreaterThan(0);for(const nodes of Object.values(icons))for(const node of nodes){expect(['path','circle','rect','ellipse','line','polygon','polyline']).toContain(node.tag);expect(Object.keys(node.attrs).some(key=>key.startsWith('on')||['href','style'].includes(key))).toBe(false);}});
});
