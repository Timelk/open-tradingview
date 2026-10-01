import {it,expect} from 'vitest';
import {LiveBarMotion} from '../src/lib/interaction/live-bar-motion';
const bar={time:1000,open:100,high:105,low:95,close:102,volume:20};
it('smooths displayed coordinates only and reaches the exact latest tick',()=>{
 const motion=new LiveBarMotion();motion.snap(bar);const tick={...bar,high:115,close:110,volume:30};motion.update(tick,0,100);
 expect(motion.sample(0)!.bar.close).toBe(102);const middle=motion.sample(50)!.bar.close;expect(middle).toBeGreaterThan(102);expect(middle).toBeLessThan(110);
 expect(motion.sample(100)!.bar).toEqual(tick);expect(motion.active).toBe(false);expect(tick.close).toBe(110);expect(bar.close).toBe(102);
});
it('retargets a new tick from the currently shown value without jumping backwards',()=>{
 const motion=new LiveBarMotion();motion.snap(bar);motion.update({...bar,close:110,high:115},0,100);const current=motion.sample(35)!.bar.close;
 motion.update({...bar,close:99},35,100);expect(motion.sample(35)!.bar.close).toBe(current);expect(motion.sample(135)!.bar.close).toBe(99);
});
it('enters a new candle at its opening price, preserving OHLC bounds and supporting immediate mode',()=>{
 const motion=new LiveBarMotion();motion.snap(bar);const next={time:2000,open:102,high:110,low:100,close:107,volume:15};motion.update(next,100,120);
 const start=motion.sample(100)!;expect(start.bar.close).toBe(next.open);expect(start.reveal).toBe(.35);
 for(const t of [120,140,180,220]){const {bar:b}=motion.sample(t)!;expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open,b.close));expect(b.low).toBeLessThanOrEqual(Math.min(b.open,b.close));}
 motion.update(bar,300,0);expect(motion.sample(300)!.bar).toEqual(bar);
});
it('continues candle width and price from the current reveal when new ticks arrive during entry',()=>{
 const motion=new LiveBarMotion();motion.snap(bar);
 const next={time:2000,open:102,high:110,low:100,close:107,volume:15};motion.update(next,0,120);
 const current=motion.sample(20)!;expect(current.reveal).toBeLessThan(1);
 motion.update({...next,close:108},20,90);
 expect(motion.sample(20)).toEqual(current);
 const later=motion.sample(40)!;expect(later.reveal).toBeGreaterThan(current.reveal);expect(later.reveal).toBeLessThan(1);
 motion.update({...next,close:109},40,90);expect(motion.sample(40)).toEqual(later);
 expect(motion.sample(130)).toEqual({bar:{...next,close:109},reveal:1});expect(motion.active).toBe(false);
});
it('diagnostic reads never consume the final paint or change interpolation state',()=>{
 const motion=new LiveBarMotion();motion.snap(bar);const target={...bar,high:115,close:110};motion.update(target,0,90);
 const lastPaint=motion.sample(83)!;expect(lastPaint.bar.close).toBeLessThan(target.close);
 const diagnostic=motion.peek(100)!;expect(diagnostic.bar).toEqual(target);expect(motion.active).toBe(true);
 // Re-reading an earlier instant proves peek did not snap the origin or target.
 expect(motion.peek(83)).toEqual(lastPaint);expect(motion.active).toBe(true);
 expect(motion.sample(100)!.bar).toEqual(target);expect(motion.active).toBe(false);
});
it('returns isolated diagnostic values and supports explicit completion and reset',()=>{
 const motion=new LiveBarMotion();expect(motion.peek(0)).toBeNull();motion.snap(bar);
 motion.peek(0)!.bar.close=999;expect(motion.peek(0)!.bar).toEqual(bar);
 const target={...bar,high:115,close:110};motion.update(target,0,90);
 motion.peek(100)!.bar.high=999;expect(motion.active).toBe(true);motion.finish();
 expect(motion.active).toBe(false);expect(motion.peek(100)!.bar).toEqual(target);
 motion.clear();expect(motion.active).toBe(false);expect(motion.peek(100)).toBeNull();
});
