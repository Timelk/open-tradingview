import {describe,it,expect} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import type {BarInput,ColumnView,ParamValues} from '../src/lib/core/types';
import {detectWyckoff} from '../src/lib/analysis/wyckoff';

const epoch=Date.parse('2026-01-01T00:00:00Z'), minute=60_000;
const params:ParamValues={pivotStrength:2,lookback:1800,minRangeBars:12,maxRangeBars:240};
type Anchor=[number,number];
const anchors:Anchor[]=[[0,145],[8,140],[16,130],[28,100],[38,114],[48,101],
  [58,112],[68,102],[78,104],[83,108],[87,101],[94,119],[99,123],[105,116],[114,129],[120,132]];
function bars(spring=true):BarInput[] {
  const result:BarInput[]=[];let leg=0;
  for(let i=0;i<=120;i++) {
    while(leg<anchors.length-2&&i>anchors[leg+1][0])leg++;
    const a=anchors[leg],b=anchors[leg+1],close=a[1]+(b[1]-a[1])*(i-a[0])/(b[0]-a[0]);
    result.push({time:epoch+i*minute,open:close-.3,high:close+.3,low:close-1,close,volume:100});
  }
  result[28]={...result[28],high:103,low:97,volume:450};
  if(spring)result[78]={...result[78],low:95,close:100,open:101,high:105,volume:90};
  result[87].volume=55;result[93].volume=250;
  return result;
}
function view(input:BarInput[],closed=input.length):ColumnView {
  const store=new ColumnStore();input.forEach(bar=>store.appendBar(bar));
  return {length:store.length,closedLength:closed,col:name=>store.col(name)};
}
const bullish=(input=bars(), p=params)=>detectWyckoff(view(input),p).find(item=>item.direction==='bullish');
const kinds=(input=bars())=>bullish(input)?.events.map(e=>e.kind)??[];

describe('Wyckoff causal range event analysis',()=>{
  it('tracks actual range events without producing orders, targets or claims of actor identity',()=>{
    const result=bullish()!;
    expect(result).toBeDefined();
    expect(kinds()).toEqual(expect.arrayContaining(['SC','AR','ST','SPRING','TEST','SOS','LPS']));
    expect(result.name).toContain('假设');expect(result.phase).toContain('假设');
    expect(result).not.toHaveProperty('targets');expect(result).not.toHaveProperty('stop');
    expect(result).not.toHaveProperty('entry');
    expect(result.zone!.low).toBeLessThan(result.zone!.high);
    expect(result.events.every(e=>e.availableAt>e.time)).toBe(true);
  });
  it('allows a no-Spring branch and repeated secondary tests',()=>{
    const result=bullish(bars(false))!;
    expect(result.events.filter(e=>e.kind==='ST').length).toBeGreaterThanOrEqual(2);
    expect(result.events.some(e=>e.kind==='SPRING')).toBe(false);
    expect(result.events.some(e=>e.kind==='SOS')).toBe(true);
  });
  it('keeps a non-climactic trend pause as a hypothesis without fabricating SC',()=>{
    const data=bars(false);data[28].volume=100;
    const result=bullish(data)!;
    expect(result.events[0].kind).toBe('PAUSE');
    expect(result.counterEvidence.join(' ')).toContain('缺少明确高潮');
  });
  it('mirrors accumulation events into distribution without changing causal times',()=>{
    const data=bars(),mirror=data.map(b=>({...b,open:300-b.open,high:300-b.low,low:300-b.high,close:300-b.close}));
    const long=bullish(data)!,short=detectWyckoff(view(mirror),params).find(item=>item.direction==='bearish')!;
    expect(short).toBeDefined();
    const mapping:Record<string,string>={SC:'BC',SPRING:'UT',SOS:'SOW',LPS:'LPSY'};
    expect(short.events.map(e=>e.kind)).toEqual(long.events.map(e=>mapping[e.kind]??e.kind));
    expect(short.events.map(e=>e.availableAt)).toEqual(long.events.map(e=>e.availableAt));
    expect(short.zone!.high).toBeCloseTo(300-long.zone!.low);
  });
  it('ignores the forming candle and only accepts the explicit closed update',()=>{
    const input=bars().slice(0,94),store=new ColumnStore();input.forEach(b=>store.appendBar(b));
    const unclosed=detectWyckoff(store,params);
    const expected=detectWyckoff(view(input,input.length-1),params);
    expect(unclosed).toEqual(expected);
    const before=JSON.stringify(unclosed);
    store.col('high')[store.length-1]=1000;store.col('close')[store.length-1]=999;
    expect(JSON.stringify(detectWyckoff(store,params))).toBe(before);
    expect(detectWyckoff(view(input),params).flatMap(o=>o.events).some(e=>e.time===input.at(-1)!.time)).toBe(true);
  });
  it('makes each event available at exactly its causal prefix and preserves those events on later updates',()=>{
    const data=bars(),full=bullish(data)!;
    for(const e of full.events) {
      // AR/SC anchors are first exposed with the range (AR confirmed), while
      // each event retains its own knowable timestamp for evidence inspection.
      const observedAt=Math.max(e.availableAt,full.availableAt);
      const count=Math.round((observedAt-epoch)/minute);
      const at=detectWyckoff(view(data.slice(0,count)),params).find(o=>o.id===full.id);
      expect(at?.events.some(item=>item.id===e.id),`${e.kind} absent at causal prefix`).toBe(true);
      if(e.availableAt>=full.availableAt) {
        const before=detectWyckoff(view(data.slice(0,count-1)),params).find(o=>o.id===full.id);
        expect(before?.events.some(item=>item.id===e.id)??false,`${e.kind} emitted early`).toBe(false);
      }
    }
  });
  it('does not join price structure across timestamp gaps',()=>{
    const input=bars();for(let i=44;i<input.length;i++)input[i].time+=20*minute;
    const results=detectWyckoff(view(input),params);
    for(const result of results) {
      const before=result.events.some(e=>e.time<epoch+44*minute);
      const after=result.events.some(e=>e.time>=epoch+64*minute);
      expect(before&&after).toBe(false);
    }
    const earlier=results.find(item=>item.time===epoch+28*minute);
    expect(earlier?.dataWarning).toContain('缺失');
  });
  it('does not join structure through malformed OHLC or NaN candles',()=>{
    const input=bars();input[44].high=NaN;
    const results=detectWyckoff(view(input),params);
    expect(results.find(item=>item.time===epoch+28*minute)?.events.some(e=>e.kind==='SOS')).toBe(false);
  });
  it('allows missing volume with an explicit limitation instead of manufacturing volume evidence',()=>{
    const input=bars().map(b=>({...b,volume:NaN})),result=bullish(input)!;
    expect(result).toBeDefined();expect(result.dataWarning).toContain('成交量');
    expect(result.events[0].kind).toBe('PAUSE');
    expect(result.evidence.join(' ')).not.toContain('量能扩张');
  });
  it('marks sustained boundary failure and cannot resurrect it as a delayed Spring',()=>{
    const input=bars().slice(0,75);
    for(let i=75;i<90;i++)input.push({time:epoch+i*minute,open:94,high:95,low:92,close:93,volume:130});
    input.push({time:epoch+90*minute,open:101,high:103,low:100,close:102,volume:90});
    const result=bullish(input)!;
    expect(result.state).toBe('invalidated');
    expect(result.events.at(-1)?.kind).toBe('RANGE_FAILURE');
    expect(result.events.some(e=>e.kind==='SPRING')).toBe(false);
    expect(result.throughTime).toBeLessThan(input.at(-1)!.time);
  });
  it('records breakout return as reduced evidence, not a finished upward trend',()=>{
    const input=bars().slice(0,96);
    for(let i=96;i<105;i++)input.push({time:epoch+i*minute,open:109,high:110,low:107,close:108,volume:100});
    const result=bullish(input)!;
    expect(result.events.some(e=>e.kind==='RETURN')).toBe(true);
    expect(result.state).toBe('observing');expect(result.counterEvidence.join(' ')).toContain('突破后回到');
  });
  it('does not classify a quiet flat range as climax-driven accumulation',()=>{
    const input=Array.from({length:200},(_,i)=>({time:epoch+i*minute,open:100,high:101,low:99,close:100,volume:100}));
    expect(detectWyckoff(view(input),params)).toEqual([]);
  });
  it('uses scale-relative rules and preserves event identities under price rescaling',()=>{
    const data=bars(),scaled=data.map(b=>({...b,open:b.open*.001,high:b.high*.001,low:b.low*.001,close:b.close*.001}));
    expect(kinds(scaled)).toEqual(kinds(data));
  });
  it('stops historical observation after sustained departure without adding target or profit fields',()=>{
    const initial=bars(),before=bullish(initial)!;
    expect(before.phase).toContain('阶段 E');
    const extra=Array.from({length:30},(_,i)=>({time:epoch+(121+i)*minute,open:90,high:91,low:89,close:90,volume:100}));
    const after=detectWyckoff(view([...initial,...extra]),params).find(o=>o.id===before.id)!;
    expect(after).toEqual(before);expect(after.state).toBe('confirmed');
    expect(after.evidence.join(' ')).not.toMatch(/盈利|目标/);
  });
  it('bounds all reads to the requested history and caps observation payload',()=>{
    const data=bars(),normal=view(data),padding=100_000,earliest=padding+data.length-164;
    const extended:ColumnView={length:padding+data.length,closedLength:padding+data.length,col:name=>new Proxy({} as Float64Array,{
      get(_target,key){if(typeof key==='string'&&/^\d+$/.test(key)) {
        const i=Number(key);expect(i).toBeGreaterThanOrEqual(earliest);
        return i<padding?NaN:normal.col(name)[i-padding];
      }return undefined;}
    })};
    const results=detectWyckoff(extended,{...params,lookback:100,maxObservations:4});
    expect(results).toEqual(detectWyckoff(normal,{...params,lookback:100,maxObservations:4}));
    expect(results.length).toBeLessThanOrEqual(4);
    expect(results.every(o=>o.events.length<=48)).toBe(true);
  });
  it('handles calendar-month candles without treating February as missing data',()=>{
    const input=bars().map((bar,i)=>({...bar,time:Date.UTC(2015,i,1)}));
    const result=bullish(input)!;
    expect(result.events.map(e=>e.kind)).toEqual(kinds());
    for(const e of result.events) {
      const date=new Date(e.availableAt);
      expect(date.getUTCDate()).toBe(1);expect(date.getUTCHours()).toBe(0);
    }
    expect(result.dataWarning).toBeUndefined();
  });
  it('never reads future prices when explicit closedLength ends earlier than the arrays',()=>{
    const input=bars(),end=80,expected=detectWyckoff(view(input.slice(0,end)),params);
    for(let i=end;i<input.length;i++)input[i]={...input[i],open:10000,high:20000,low:1,close:1,volume:1e9};
    expect(detectWyckoff(view(input,end),params)).toEqual(expected);
  });
  it('anchors a multi-candle Spring at the actual extreme and only reveals it at the later reclaim',()=>{
    const input=bars(false).slice(0,83);
    input[78]={...input[78],open:97,high:98,low:94,close:96};
    input[79]={...input[79],open:96,high:99,low:95,close:98};
    const before=bullish(input.slice(0,79))!;
    expect(before.events.some(e=>e.kind==='SPRING')).toBe(false);
    const spring=bullish(input)!.events.find(e=>e.kind==='SPRING')!;
    expect(spring.time).toBe(input[78].time);expect(spring.price).toBe(94);
    expect(spring.availableAt).toBe(input[79].time+minute);
  });
});
