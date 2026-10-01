import {afterEach,describe,expect,it,vi} from 'vitest';
import {fetchValidationFunding} from '../src/lib/analysis/funding';
import {runAnalysisValidation} from '../src/lib/analysis/validation';
import type {DatasetSnapshot} from '../src/lib/history/types';
const epoch=Date.UTC(2026,0,1),minute=60_000,hour=3_600_000;
function dataset(n=2,interval='1m',ms=minute):DatasetSnapshot{return {source:'binance',marketType:'usdm-perpetual',symbol:'BTCUSDT',interval,bars:Array.from({length:n},(_,i)=>({time:epoch+i*ms,open:100,high:101,low:99,close:100,volume:1}))};}
const row=(time:number,rate='0.0001',markPrice='100')=>({symbol:'BTCUSDT',fundingTime:time,fundingRate:rate,markPrice,rateType:'Regular'});
const requestOf=(body:unknown)=>vi.fn(async()=>Response.json(body));
afterEach(()=>vi.useRealTimers());

describe('public validation funding ranges and pagination',()=>{
  it('queries inclusive boundaries through the final closed candle, retaining a fee exactly at that boundary',async()=>{
    const request=requestOf([row(epoch),row(epoch+2*minute,'-0.0002','105')]),result=await fetchValidationFunding(dataset(),request);
    const [url]=request.mock.calls[0] as unknown as [string];const params=new URL(String(url)).searchParams;
    expect(params.get('symbol')).toBe('BTCUSDT');expect(params.get('startTime')).toBe(String(epoch));expect(params.get('endTime')).toBe(String(epoch+2*minute));
    expect(result).toMatchObject({from:epoch,to:epoch+2*minute,rates:[{time:epoch,rate:.0001,markPrice:100},{time:epoch+2*minute,rate:-.0002,markPrice:105}],coverage:{pages:1,basis:'completed-public-range-query'}});
  });
  it('fetches each full page from its latest timestamp plus one millisecond without duplicate charging',async()=>{
    const first=Array.from({length:1000},(_,i)=>row(epoch+i)),next=[row(epoch+1000),row(epoch+1001)],queries:string[]=[];
    const request=vi.fn(async(input:RequestInfo|URL)=>{queries.push(String(input));return Response.json(queries.length===1?first:next);});
    const result=await fetchValidationFunding(dataset(),request);
    expect(new URL(queries[1]).searchParams.get('startTime')).toBe(String(epoch+1000));expect(result.rates).toHaveLength(1002);expect(result.coverage.pages).toBe(2);expect(new Set(result.rates.map(r=>r.time)).size).toBe(1002);
  });
  it('stops without an unnecessary page when a full page reaches the inclusive end',async()=>{
    const end=epoch+2*minute,rows=[...Array.from({length:999},(_,i)=>row(epoch+i)),row(end)],request=requestOf(rows);
    const result=await fetchValidationFunding(dataset(),request);expect(request).toHaveBeenCalledTimes(1);expect(result.rates).toHaveLength(1000);expect(result.to).toBe(end);
  });
  it('deduplicates identical same-time rows but refuses conflicting or special fee events',async()=>{
    expect((await fetchValidationFunding(dataset(),requestOf([row(epoch),row(epoch)]))).rates).toHaveLength(1);
    await expect(fetchValidationFunding(dataset(),requestOf([row(epoch),row(epoch,'.0002')]))).rejects.toThrow('冲突');
    await expect(fetchValidationFunding(dataset(),requestOf([{...row(epoch),rateType:'Special'}]))).rejects.toThrow('特殊资金费');
  });
  it('does not invent a fixed funding cadence and represents an empty completed query explicitly',async()=>{
    const irregular=[row(epoch),row(epoch+137),row(epoch+32109)],result=await fetchValidationFunding(dataset(),requestOf(irregular));expect(result.rates).toHaveLength(3);
    const empty=await fetchValidationFunding(dataset(),requestOf([]));expect(empty.rates).toEqual([]);expect(empty.to).toBe(epoch+2*minute);expect(empty.coverage.note).toContain('不假定固定8小时');
  });
  it('uses calendar month boundaries rather than a guessed 30-day duration',async()=>{
    const request=requestOf([]),monthly={...dataset(1),interval:'1M',bars:[{...dataset(1).bars[0],time:Date.UTC(2026,1,1)}]};
    expect((await fetchValidationFunding(monthly,request)).to).toBe(Date.UTC(2026,2,1));
    await expect(fetchValidationFunding({...monthly,bars:[{...monthly.bars[0],time:Date.UTC(2026,1,2)}]},request)).rejects.toThrow('月初');
  });
  it.each([
    ['wrong symbol',[{...row(epoch),symbol:'ETHUSDT'}]],
    ['missing symbol',[{...row(epoch),symbol:undefined}]],
    ['before range',[row(epoch-1)]],['after range',[row(epoch+2*minute+1)]],
    ['fractional timestamp',[row(epoch+.5)]],['null rate',[{...row(epoch),fundingRate:null}]],
    ['empty rate',[{...row(epoch),fundingRate:''}]],['null price',[{...row(epoch),markPrice:null}]],
    ['zero price',[row(epoch,'.001','0')]],['non-finite rate',[row(epoch,'Infinity')]],
    ['unordered',[row(epoch+10),row(epoch)]],['null record',[null]],
    ['object response',{data:[]}],['oversized page',Array.from({length:1001},(_,i)=>row(epoch+i))],
  ])('rejects %s without returning a partially covered snapshot',async(_name,body)=>{
    await expect(fetchValidationFunding(dataset(),requestOf(body))).rejects.toThrow();
  });
  it('refuses a second page that repeats the already-consumed boundary',async()=>{
    let page=0;const request=vi.fn(async()=>Response.json(page++===0?Array.from({length:1000},(_,i)=>row(epoch+i)):[row(epoch+999)]));
    await expect(fetchValidationFunding(dataset(),request)).rejects.toThrow('有效时间');expect(request).toHaveBeenCalledTimes(2);
  });
  it('keeps the page ceiling bounded and does not report truncated coverage as complete',async()=>{
    const request=vi.fn(async(input:RequestInfo|URL)=>{const from=Number(new URL(String(input)).searchParams.get('startTime'));return Response.json(Array.from({length:1000},(_,i)=>row(from+i)));});
    await expect(fetchValidationFunding(dataset(2,'1d',24*hour),request)).rejects.toThrow('查询上限');expect(request).toHaveBeenCalledTimes(50);
  });
  it('rejects invalid source/range/period/future metadata before making a request',async()=>{
    const request=requestOf([]),invalid=[{...dataset(),source:'import'}, {...dataset(),marketType:'spot'}, {...dataset(),symbol:'BTCUSDC'}, {...dataset(),bars:[]}, {...dataset(),bars:[dataset().bars[1],dataset().bars[0]]}, {...dataset(),bars:[dataset().bars[0],dataset().bars[0]]}, {...dataset(),interval:'unknown'}] as DatasetSnapshot[];
    for(const input of invalid)await expect(fetchValidationFunding(input,request)).rejects.toThrow();expect(request).not.toHaveBeenCalled();
    vi.useFakeTimers();vi.setSystemTime(epoch+minute);await expect(fetchValidationFunding(dataset(),request)).rejects.toThrow('尚未结束');expect(request).not.toHaveBeenCalled();
  });
  it('provides coverage matching the actual validation engine close boundary',async()=>{
    const data=dataset(64,'1h',hour),funding=await fetchValidationFunding(data,requestOf([]));
    const report=await runAnalysisValidation({dataset:data,closedLength:data.bars.length,studies:[{id:'analysis-candles'}],prefixProbes:1,maxHoldoutBars:32,research:{enabled:false},funding},{yieldControl:async()=>{}});
    expect(report.research.fundingBasis).toBe('covered');expect(report.fundingData?.to).toBe(epoch+64*hour);
  });
});

describe('funding query cancellation and failures',()=>{
  it('performs no request when already aborted',async()=>{
    const controller=new AbortController();controller.abort();const request=requestOf([]);
    await expect(fetchValidationFunding(dataset(),request,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(request).not.toHaveBeenCalled();
  });
  it('propagates the signal and rejects a stale response even if a fetch implementation ignores cancellation',async()=>{
    const controller=new AbortController();let release!:(r:Response)=>void;let passed:AbortSignal|undefined;
    const request=vi.fn((_input:RequestInfo|URL,init?:RequestInit)=>{passed=init?.signal as AbortSignal;return new Promise<Response>(done=>{release=done;});});
    const result=fetchValidationFunding(dataset(),request,controller.signal),rejected=expect(result).rejects.toMatchObject({name:'AbortError'});controller.abort();release(Response.json([]));await rejected;expect(passed?.aborted).toBe(true);
  });
  it('checks cancellation after JSON parsing and never starts a next page after an abort',async()=>{
    const controller=new AbortController(),request=vi.fn(async()=>({ok:true,status:200,json:async()=>{controller.abort();return Array.from({length:1000},(_,i)=>row(epoch+i));}} as Response));
    await expect(fetchValidationFunding(dataset(),request,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(request).toHaveBeenCalledTimes(1);
  });
  it('surfaces HTTP rate limits and does not continue paging',async()=>{
    const request=vi.fn(async()=>new Response('',{status:429}));await expect(fetchValidationFunding(dataset(),request)).rejects.toThrow('HTTP 429');expect(request).toHaveBeenCalledTimes(1);
  });
});
