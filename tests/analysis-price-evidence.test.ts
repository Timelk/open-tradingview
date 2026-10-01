import {describe,it,expect} from 'vitest';
import {ColumnStore} from '../src/lib/core/datastore';
import {detectCandlesticks} from '../src/lib/analysis/candlesticks';
import {detectMarketStructure,detectSupplyDemand,detectVsa} from '../src/lib/analysis/structure';
import type {ColumnView,BarInput} from '../src/lib/core/types';

const minute=60000,epoch=Date.UTC(2026,8,20);
function candles(values:number[]){const store=new ColumnStore(128);values.forEach((close,i)=>store.appendBar({time:epoch+i*minute,open:close-.2,high:close+.6,low:close-.7,close,volume:100}));return store;}
function view(store:ColumnStore,closed=store.length):ColumnView{return {length:store.length,closedLength:closed,col:name=>store.col(name)};}
const warm=Array.from({length:22},(_,i)=>110-i*.3);
describe('price analysis evidence contracts',()=>{
  it('does not describe equal swing highs or lows as a lower directional structure',()=>{
    const values=[...warm,102,104,108,105,103,106,108,105,103,106,110,108,105];
    const result=detectMarketStructure(view(candles(values)),{pivotStrength:1,showSwings:true});
    expect(result.some(o=>o.name==='EQH 等高')).toBe(true);
    expect(result.some(o=>o.name==='EQL 等低')).toBe(true);
  });
  it('treats a doji as neutral and publishes only on actual candle close',()=>{
    const store=candles(warm);store.appendBar({time:epoch+22*minute,open:103,high:105,low:101,close:103.05,volume:100});
    expect(detectCandlesticks(view(store,22),{family:'Doji'})).toEqual([]);
    const result=detectCandlesticks(view(store),{family:'Doji'}).find(o=>o.time===epoch+22*minute)!;
    expect(result.direction).toBe('neutral');expect(result.availableAt).toBe(epoch+23*minute);
    expect(result).not.toHaveProperty('targets');expect(result).not.toHaveProperty('invalidation');
  });
  it('recognizes a closed pin bar without borrowing the following rebound',()=>{
    const store=candles(warm);store.appendBar({time:epoch+22*minute,open:103.6,high:104,low:100,close:103.8,volume:100});
    const before=detectCandlesticks(view(store),{family:'Pin Bar',requireTrend:true}).find(o=>o.time===epoch+22*minute)!;
    expect(before?.name).toBe('Pin Bar 下影');
    store.appendBar({time:epoch+23*minute,open:103.8,high:110,low:103,close:109,volume:200});
    const after=detectCandlesticks(view(store),{family:'Pin Bar',requireTrend:true}).find(o=>o.id===before.id)!;
    expect(after.points).toEqual(before.points);expect(after.availableAt).toBe(before.availableAt);
  });
  it('does not build a three-candle gap across missing bars and distinguishes later fills',()=>{
    const store=candles(warm);let index=store.length;
    for(const bar of [{open:105,high:106,low:104,close:105.8},{open:106,high:110,low:105,close:109},{open:110,high:112,low:109,close:111}]){store.appendBar({time:epoch+index++*minute,volume:150,...bar});}
    const before=detectSupplyDemand(view(store),{family:'FVG'}).find(o=>o.time===epoch+24*minute)!;
    expect(before?.zone).toMatchObject({low:106,high:109});expect(before.state).toBe('confirmed');
    store.appendBar({time:epoch+25*minute,open:110,high:111,low:105,close:107,volume:160});
    const after=detectSupplyDemand(view(store),{family:'FVG'}).find(o=>o.id===before.id)!;
    expect(after.state).toBe('invalidated');expect(after.availableAt).toBe(before.availableAt);expect(after.invalidatedAt).toBe(epoch+26*minute);
    store.col('time')[23]+=minute*.5;
    expect(detectSupplyDemand(view(store),{family:'FVG'}).some(o=>o.id===before.id)).toBe(false);
  });
  it('VSA describes volume and spread without asserting bullish or bearish ownership',()=>{
    const store=candles(warm);store.appendBar({time:epoch+22*minute,open:104,high:104.3,low:103.9,close:104.1,volume:500});
    const result=detectVsa(view(store)).find(o=>o.time===epoch+22*minute)!;
    expect(result?.name).toBe('高量窄幅');expect(result.direction).toBe('neutral');expect(result.counterEvidence.join('')).toContain('身份');
  });
  it('market breaks use an already knowable swing and do not reissue the same level on every subsequent close',()=>{
    const values=[...warm,102,104,108,105,103,106,109,112,114,115,116],store=candles(values);
    const result=detectMarketStructure(view(store),{pivotStrength:1,breakoutAtr:0});
    const breaks=result.filter(o=>o.name.includes('BOS')||o.name.includes('CHoCH'));
    expect(breaks.length).toBeGreaterThan(0);
    for(const item of breaks){expect(item.availableAt).toBeGreaterThan(item.time);expect(item.points[0].time).toBeLessThan(item.time);}
    expect(new Set(breaks.map(o=>`${o.direction}:${o.points[0].time}`)).size).toBe(breaks.length);
  });
});
