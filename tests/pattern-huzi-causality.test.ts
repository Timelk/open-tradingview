import {describe,expect,it} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import type {ColumnView} from '../src/lib/core/types';
import {detectHuzi} from '../src/lib/patterns/huzi';
import {patternStrategies} from '../src/lib/patterns/registry';

const minute=60_000;
const settings={pivotStrength:2,lookback:1500,tolerance:.04,maxPatterns:100,showInvalidated:true,family:'三角形',multiScale:false,structuralSwings:false};
const anchors:Array<[number,number]>=[[0,100],[10,110],[20,90],[30,110],[40,98],[50,110],[55,106],[63,115],[70,115],[75,80],[80,80]];
function candles(end=70,omitted=new Set<number>(),monthly=false):ColumnStore {
  const store=new ColumnStore(end+1);let segment=0;
  for(let i=0;i<=end;i++){
    while(segment+1<anchors.length-1&&i>anchors[segment+1][0])segment++;
    const [a,pa]=anchors[segment],[b,pb]=anchors[segment+1],price=pa+(pb-pa)*(i-a)/(b-a);
    if(!omitted.has(i))store.appendBar({time:monthly?Date.UTC(2020,i,1):i*minute,open:price,high:price+.1,low:price-.1,close:price,volume:100});
  }
  return store;
}
function prefix(store:ColumnStore,length:number,closedLength?:number):ColumnView {
  return {length,...(closedLength===undefined?{}:{closedLength}),col:name=>store.col(name)};
}

describe('Huzi closed-prefix and trading-session compatibility',()=>{
  it('does not inspect hidden future OHLC when explicit closedLength precedes confirmation',()=>{
    const store=candles(),hidden=prefix(store,store.length,54);
    expect(detectHuzi(store,settings)).toHaveLength(1);
    expect(detectHuzi(hidden,settings)).toEqual(detectHuzi(prefix(store,55),settings));
    expect(detectHuzi(hidden,settings)).toEqual([]);
    store.col('high')[60]=1000;store.col('low')[60]=-1000;
    expect(detectHuzi(hidden,settings)).toEqual([]);
  });

  it('uses an exchange-close timestamp sentinel without discarding the last closed breakout',()=>{
    const store=candles(),baseline=detectHuzi(store,settings)[0],closed=baseline.confirmedAt/minute;
    expect(detectHuzi(prefix(store,closed,closed),settings)[0]).toMatchObject({id:baseline.id,confirmedAt:baseline.confirmedAt,points:baseline.points,targets:baseline.targets});
    expect(detectHuzi(prefix(store,closed),settings)).toEqual([]);
  });

  it.each(['intraday','daily'] as const)('does not treat legitimate A-share %s session breaks as missing price evidence',mode=>{
    const store=candles(),times:number[]=[];
    for(let day=0;times.length<store.length;day++){
      const date=Date.UTC(2026,5,1+day),weekday=new Date(date).getUTCDay();
      if(weekday===0||weekday===6)continue;
      if(mode==='daily')times.push(date);
      else for(const opening of [90,300])for(let i=0;i<24;i++)times.push(date+(opening+i*5)*minute);
    }
    store.col('time').set(times.slice(0,store.length));
    const intervalMs=mode==='daily'?86_400_000:5*minute,view={...prefix(store,store.length,store.length-1),intervalMs};
    const matches=detectHuzi(view,settings);
    expect(matches).toHaveLength(1);
    expect(matches[0].points.map(point=>point.value)).toEqual(detectHuzi(candles(),settings)[0].points.map(point=>point.value));
    const runner=patternStrategies().find(def=>def.id==='pattern-huzi')!.createIncremental!(settings);
    expect(runner.update(view,0).flatMap(series=>series.patterns??[]).some(match=>match.id===matches[0].id)).toBe(true);
  });

  it('accepts valid calendar-month spacing and an explicit final closed month',()=>{
    const store=candles(70,new Set(),true),baseline=detectHuzi(store,settings)[0];
    expect(baseline).toBeDefined();
    const closed=Array.from(store.col('time').subarray(0,store.length)).indexOf(baseline.confirmedAt);
    expect(detectHuzi(prefix(store,closed,closed),settings)[0]).toMatchObject({id:baseline.id,confirmedAt:baseline.confirmedAt});
  });
});
