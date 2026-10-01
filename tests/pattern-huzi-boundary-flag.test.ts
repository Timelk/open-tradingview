import {describe,expect,it} from 'vitest';
import {detectHuzi} from '../src/lib/patterns/huzi';
import {plant,viewOf,withPole,withSpikes} from './fixtures/huzi-synthetic';
import {untranslated} from './fixtures/huzi-english';

const params={pivotStrength:3,lookback:1500,tolerance:.04,maxPatterns:1000,showInvalidated:true,minStructureBars:0};
const run=(t:{bars:Parameters<typeof viewOf>[0];breakout:number},extra:Record<string,unknown>={})=>detectHuzi(viewOf(t.bars,t.breakout+6),{...params,...extra});

describe('flags and channels drawn through candle bodies',()=>{
  it('names a compact consolidation after a clean impulse a flag when it breaks the way the pole went, otherwise a channel',()=>{
    let flags=0,total=0,againstFlags=0,asChannel=0,against=0;
    for(const kind of ['down-channel','up-channel'] as const)for(let seed=1;seed<=30;seed++)for(const breakout of ['up','down'] as const){
      const t=withPole(kind,seed,breakout);
      if((kind==='down-channel')!==t.bullPole)continue;
      const found=run(t).filter(m=>m.points[0].time>=t.bars[t.first-1][0]&&m.points[0].time<=t.bars[t.first+3][0]);
      if(breakout===(t.bullPole?'up':'down')){
        total++;
        const flag=found.find(m=>m.family==='huzi-flag');
        if(flag){flags++;expect(flag.name).toBe(t.bullPole?'上涨旗形':'下跌旗形');expect(flag.direction).toBe(t.bullPole?'bullish':'bearish');expect(flag.guides?.some(g=>g.role==='pole')).toBe(true);expect(flag.ratios.some(r=>r.label==='整理回撤 / 旗杆')).toBe(true);}
      }else{
        against++;
        if(found.some(m=>m.family==='huzi-flag'&&m.direction!==(t.bullPole?'bullish':'bearish')))againstFlags++;
        if(found.some(m=>m.family==='huzi-channel'))asChannel++;
      }
    }
    expect(total).toBeGreaterThan(15);
    expect(flags/total).toBeGreaterThan(.7);
    // A breakout against the pole is a channel breakout, never a flag continuation.
    expect(againstFlags).toBe(0);
    expect(asChannel/against).toBeGreaterThan(.6);
  });

  it('does not call a channel a flag when nothing impulsive came before it',()=>{
    let flags=0,seen=0;
    for(const kind of ['down-channel','up-channel'] as const)for(let seed=1;seed<=20;seed++){
      seen++;flags+=run(withPole(kind,seed,'up',30,.4)).filter(m=>m.family==='huzi-flag').length;
    }
    expect(seen).toBe(40);
    expect(flags).toBe(0);
  });

  it('draws through the bodies: a long spike that stabs through a boundary no longer spoils the structure',()=>{
    // Drawn lines ignore an outlier wick. The zig-zag fit needs every swing on the line, so it loses the structure;
    // the boundary search keeps it while the closes stay inside.
    let seen=0,boundary=0,zigzag=0;
    for(let seed=1;seed<=40;seed++){
      const t=withSpikes(plant({kind:'down-channel',length:150,seed,noise:.3,prefix:300,breakout:'up'}),.15);
      const hit=(matches:ReturnType<typeof run>)=>matches.some(m=>m.family==='huzi-channel'&&Math.abs(m.points[0].time-t.bars[t.first][0])<=8*3600000&&Math.abs(m.points.at(-1)!.time-t.bars[t.last][0])<=8*3600000);
      seen++;
      if(hit(run(t)))boundary++;
      if(hit(run(t,{boundarySearch:false})))zigzag++;
    }
    expect(zigzag).toBe(0);
    expect(boundary/seen).toBeGreaterThan(.3);
  });

  it('still rejects a spike longer than the allowance',()=>{
    let found=0;
    for(let seed=1;seed<=20;seed++){
      const t=withSpikes(plant({kind:'down-channel',length:150,seed,noise:.3,prefix:300,breakout:'up'}),.6);
      if(run(t).some(m=>m.family==='huzi-channel'&&m.description.includes('贴边触点')&&Math.abs(m.points[0].time-t.bars[t.first][0])<=8*3600000&&Math.abs(m.points.at(-1)!.time-t.bars[t.last][0])<=8*3600000))found++;
    }
    expect(found).toBe(0);
  });

  it('keeps the English display complete for a flag',()=>{
    for(let seed=1;seed<=30;seed++){
      const t=withPole('down-channel',seed,'up');if(!t.bullPole)continue;
      const flag=run(t).find(m=>m.family==='huzi-flag');
      if(flag){expect(untranslated(flag)).toEqual([]);return;}
    }
    throw new Error('no flag found to check');
  });
});
