import {describe,it,expect} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import type {BarInput,ColumnView,ParamValues} from '../src/lib/core/types';
import {detectIctSetups,detectOrderBlocks,localSessionTime,priorSessionRanges,sessionMembership} from '../src/lib/analysis/smart-money';
const minute=60000,hour=3600000,epoch=Date.UTC(2026,8,23);
const normal=(i:number,close=100):BarInput=>({time:epoch+i*minute,open:close-.2,high:close+.4,low:close-.4,close,volume:100});
function view(bars:BarInput[],n=bars.length):ColumnView{const s=new ColumnStore();bars.forEach(b=>s.appendBar(b));return {length:s.length,closedLength:n,intervalMs:minute,col:k=>s.col(k)};}
function blockFixture(){
  const closes=[100,102,104,102,100,102,103,102,100,102,104,102,100,102,104,102,100,102,104,102,101,103,105,108,110,108,106,104,106,114,115,113,107,106,105];
  const bars=closes.map((c,i)=>normal(i,c));bars[28]={...bars[28],open:107,high:107.2,low:105.8,close:106};
  bars[29]={...bars[29],open:106,low:105.8,high:114.2,close:114};
  bars[30]={...bars[30],open:114,high:115.2,low:113.5,close:115};
  bars[32]={...bars[32],open:108,high:108.2,low:106.6,close:107};
  bars[33]={...bars[33],open:107,high:107.2,low:105.9,close:106};
  bars[34]={...bars[34],open:106,high:106.2,low:104.8,close:105};return bars;
}
const config:ParamValues={pivotStrength:2,breakoutAtr:0,displacementAtr:1,baseLookback:12,zoneMode:'wick'};
function ictFixture(){
  const b=Array.from({length:85},(_,i)=>normal(i,100+Math.sin(i*.7)));
  b[30]={...normal(30),high:105,low:95};
  for(const [i,c] of [[60,100],[61,102],[62,104],[63,101],[64,99],[65,100]] as const)b[i]=normal(i,c);
  b[66]={...normal(66),open:99,high:100,low:94,close:96};
  b[67]={...normal(67),open:96,high:108.3,low:95.8,close:108};
  b[68]={...normal(68),open:108,high:109.3,low:107.5,close:109};
  for(let i=69;i<85;i++)b[i]=normal(i,110);
  b[72]={...normal(72),open:109,high:110,low:106,close:108};
  b[74]={...normal(74),open:108,high:109,low:102,close:104};
  b[78]={...normal(78),open:103,high:104,low:98,close:99};return b;
}
const ict:ParamValues={timeZone:'UTC',sessionStart:0,sessionEnd:60,killzoneStart:60,killzoneEnd:180,reference:'session',entryModel:'fvg',pivotStrength:2,displacementAtr:1,breakoutAtr:0,minGapAtr:.1};
describe('Order Block definition and lifecycle',()=>{
  it('requires a closed structural break plus actual displacement before exposing the historical base',()=>{
    const bars=blockFixture(),before=detectOrderBlocks(view(bars,29),config);
    expect(before.some(o=>o.time===epoch+28*minute)).toBe(false);
    const o=detectOrderBlocks(view(bars,30),config).find(o=>o.time===epoch+28*minute)!;
    expect(o).toBeDefined();expect(o.availableAt).toBe(epoch+30*minute);
    expect(o.zone).toMatchObject({low:105.8,high:107.2});expect(o.events[0].kind).toBe('activation');
    expect(o).not.toHaveProperty('targets');
  });
  it('tracks first revisit, configured mitigation depth, and later closed invalidation separately',()=>{
    const o=detectOrderBlocks(view(blockFixture()),config).find(o=>o.time===epoch+28*minute)!;
    expect(o.events.map(e=>e.kind)).toEqual(expect.arrayContaining(['activation','revisit','mitigation','invalidation']));
    expect(o.events.find(e=>e.kind==='revisit')?.time).toBe(epoch+32*minute);
    expect(o.events.find(e=>e.kind==='mitigation')?.time).toBe(epoch+33*minute);
    expect(o.invalidatedAt).toBe(epoch+35*minute);expect(o.state).toBe('invalidated');
  });
  it('does not rename every FVG as an OB and allows wick/body and FVG-requirement configuration',()=>{
    const bars=blockFixture();
    expect(detectOrderBlocks(view(bars),{...config,requireFvg:true}).some(o=>o.time===epoch+28*minute)).toBe(false);
    const body=detectOrderBlocks(view(bars,30),{...config,zoneMode:'body'}).find(o=>o.time===epoch+28*minute)!;
    expect(body.zone).toMatchObject({low:106,high:107});
    expect(detectOrderBlocks(view(bars),{...config,displacementAtr:5}).some(o=>o.time===epoch+28*minute)).toBe(false);
  });
  it('is symmetric under a price reflection and retains actual event timestamps',()=>{
    const b=blockFixture(),mirror=b.map(b=>({...b,open:250-b.open,close:250-b.close,high:250-b.low,low:250-b.high}));
    const bull=detectOrderBlocks(view(b),config).find(o=>o.time===epoch+28*minute)!;
    const bear=detectOrderBlocks(view(mirror),config).find(o=>o.time===epoch+28*minute)!;
    expect(bear.direction).toBe('bearish');expect(bear.availableAt).toBe(bull.availableAt);
    expect(bear.zone!.high).toBeCloseTo(250-bull.zone!.low);expect(bear.events.map(e=>e.kind)).toEqual(bull.events.map(e=>e.kind));
  });
});

describe('IANA sessions and causal ICT event sequences',()=>{
  it('follows New York DST in wall-clock killzones and supports sessions crossing midnight',()=>{
    expect(localSessionTime(Date.parse('2026-02-09T14:00:00Z')).minute).toBe(540);
    expect(localSessionTime(Date.parse('2026-06-09T13:00:00Z')).minute).toBe(540);
    expect(sessionMembership(Date.parse('2026-06-09T05:00:00Z'),'America/New_York',1200,120)).toMatchObject({inside:true,key:'2026-06-08'});
    expect(sessionMembership(Date.parse('2026-06-09T06:00:00Z'),'America/New_York',1200,120).inside).toBe(false);
  });
  it.each([['2026-03-08T05:00:00Z',23],['2026-11-01T04:00:00Z',25]] as const)('accepts a fully observed DST day of %s containing %i hours', (date,hours)=>{
    const bars=Array.from({length:hours+1},(_,i)=>({...normal(i),time:Date.parse(date)+i*hour}));
    const s=view(bars);s.intervalMs=hour;
    const refs=priorSessionRanges(s,'America/New_York',1200,0);
    expect(refs[hours].find(r=>r.kind==='day')?.availableAt).toBe(bars[hours].time);
    expect(refs[hours-1].some(r=>r.kind==='day')).toBe(false);
  });
  it('never supplies a partial first session or a stale day as an immediately previous reference',()=>{
    const bars=ictFixture(),partial=view(bars.slice(20));
    expect(priorSessionRanges(partial,'UTC',0,60).flat().some(r=>r.kind==='session')).toBe(false);
    const full=view(bars),refs=priorSessionRanges(full,'UTC',0,60);
    expect(refs[59].some(r=>r.kind==='session')).toBe(false);expect(refs[60].find(r=>r.kind==='session')?.availableAt).toBe(epoch+60*minute);
    full.col('time')[84]+=3*86400000;
    expect(priorSessionRanges(full,'UTC',0,60)[84]).toEqual([]);
  });
  it('requires sweep then a later MSS and only exposes FVG at the third candle close',()=>{
    const bars=ictFixture(),sweep=detectIctSetups(view(bars,67),ict).find(o=>o.time===epoch+66*minute)!;
    expect(sweep.state).toBe('observing');expect(sweep.events.map(e=>e.kind)).toEqual(['sweep']);expect(sweep.zone).toBeUndefined();
    const mss=detectIctSetups(view(bars,68),ict).find(o=>o.id===sweep.id)!;
    expect(mss.events.map(e=>e.kind)).toEqual(['sweep','mss']);expect(mss.state).toBe('observing');
    const done=detectIctSetups(view(bars,69),ict).find(o=>o.id===sweep.id)!;
    expect(done.state).toBe('confirmed');expect(done.events.map(e=>e.kind)).toEqual(['sweep','mss','fvg']);
    expect(done.zone).toMatchObject({low:100,high:107.5});expect(done.availableAt).toBe(epoch+69*minute);
  });
  it('supports OB or combined region confirmation as a separately defined model',()=>{
    const bars=ictFixture();
    const ob=detectIctSetups(view(bars,68),{...ict,entryModel:'ob'}).find(o=>o.time===epoch+66*minute)!;
    expect(ob.state).toBe('confirmed');expect(ob.zone).toMatchObject({low:94,high:100});
    const both=detectIctSetups(view(bars,69),{...ict,entryModel:'both'}).find(o=>o.time===epoch+66*minute)!;
    expect(both.events.map(e=>e.kind)).toEqual(['sweep','mss','order-block','fvg']);
  });
  it('does not complete a sequence outside the configured killzone or across missing candles',()=>{
    const bars=ictFixture();
    expect(detectIctSetups(view(bars),{...ict,killzoneEnd:67}).find(o=>o.time===epoch+66*minute)?.state).toBe('observing');
    bars[67].time+=minute/2;
    const gap=detectIctSetups(view(bars),ict).find(o=>o.time===epoch+66*minute)!;
    expect(gap.state).toBe('observing');expect(gap.dataWarning).toContain('缺口');
  });
  it('publishes actual lifecycle events without rewriting the earliest completed-chain time',()=>{
    const bars=ictFixture(),o=detectIctSetups(view(bars),ict).find(o=>o.time===epoch+66*minute)!;
    expect(o.state).toBe('invalidated');expect(o.availableAt).toBe(epoch+69*minute);expect(o.invalidatedAt).toBe(epoch+79*minute);
    expect(o.events.map(e=>e.kind)).toEqual(expect.arrayContaining(['sweep','mss','fvg','revisit','mitigation','invalidation']));
    expect(o).not.toHaveProperty('trade');expect(o.counterEvidence.join(' ')).toContain('不确认机构');
  });
});
