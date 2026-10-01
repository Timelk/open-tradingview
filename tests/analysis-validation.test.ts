import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import type {BarInput,IndicatorDef,DerivedSeries} from '../src/lib/core/types';
import type {AnalysisObservation} from '../src/lib/analysis/types';
import {runAnalysisValidation,type ValidationRequest,type ValidationProgress,type ValidationWorkerResponse} from '../src/lib/analysis/validation';
import {createAnalysisValidationJob} from '../src/lib/analysis/validation-client';

const minute=60000,epoch=Date.UTC(2026,8,23),time=(i:number)=>epoch+i*minute;
const bars=(n=64):BarInput[]=>Array.from({length:n},(_,i)=>({time:time(i),open:100,high:101,low:99,close:100,volume:100}));
type Detection={index:number;direction?:AnalysisObservation['direction'];availableIndex?:number;historical?:boolean};
function definition(id:string,events:Detection[],futureRead=false):IndicatorDef {
  return {id,name:id,target:'main',category:'analysis',inputs:[],calc:({cols})=>{
    const observations=events.filter(e=>e.index<cols.length).map(e=>({id:`manual:${e.index}`,family:'candlestick' as const,name:'手工确定事件',ruleVersion:'manual-fixture/1',
      state:'confirmed' as const,direction:e.direction??'bullish',time:time(e.index),availableAt:time(e.availableIndex??e.index+1),throughTime:time(cols.length),
      points:[{label:'真实锚',time:time(e.index),value:futureRead?(cols.col('close')[cols.length]??cols.col('close')[cols.length-1]):cols.col('close')[e.index]}],
      events:[],evidence:['手工标注的固定事件'],counterEvidence:[],waitingFor:[],...(e.historical?{trackingEndedAt:time(e.index+1)}:{})}));
    return [{name:id,pane:'main',plot:'analysis',color:'#fff',values:new Float64Array(cols.length).fill(NaN),observations}];
  }};
}
const request=(data=bars(),id='manual'):ValidationRequest=>({dataset:data,closedLength:data.length,intervalMs:minute,studies:[{id}],prefixProbes:4,holdoutFraction:.5,maxHoldoutBars:24,
  research:{enabled:true,notional:1000,initialCapital:10000,feeBps:0,slippageBps:0,stopAtr:0,takeAtr:0,maxHoldBars:3,responseBars:3}});
const fast={yieldControl:()=>Promise.resolve()};
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));afterEach(()=>vi.unstubAllGlobals());

describe('analysis self-validation and holdout research',()=>{
  it('enters only at next open after a new closed event and charges entry plus exit fees',async()=>{
    const data=bars();data[43]={...data[43],open:103,high:105,low:102,close:104};
    const input=request(data);input.research!.feeBps=10;
    const progress:ValidationProgress[]=[];
    const report=await runAnalysisValidation(input,{...fast,definitions:[definition('manual',[{index:40}])],onProgress:p=>progress.push(p)});
    expect(report.split).toMatchObject({trainingBars:40,holdoutBars:24,capped:true,parametersFrozen:true});
    expect(report.research.trades).toHaveLength(1);
    expect(report.research.trades[0]).toMatchObject({entryBar:41,exitBar:43,entryTime:time(41),exitTime:time(43),grossBeforeCosts:40,fees:2.04,net:37.96,exitReason:'time'});
    expect(report.research.endingEquity).toBeCloseTo(10037.96);
    expect(report.research.fundingBasis).toBe('not-provided');expect(report.warnings.join(' ')).toContain('不是包含合约资金费');
    expect(report.dataset.hash).toMatch(/^[a-f0-9]{64}$/);expect(report.studies[0].ruleVersions).toEqual(['manual-fixture/1']);
    expect(progress.at(-1)?.percent).toBe(100);expect(progress.every((p,i)=>i===0||p.percent>=progress[i-1].percent)).toBe(true);
    expect(JSON.parse(JSON.stringify(report)).responses.evaluated).toBe(1);
  });
  it('uses the stop first when the same candle crosses both risk levels',async()=>{
    const data=bars();data[41]={...data[41],high:110,low:90};const input=request(data);
    Object.assign(input.research!,{stopAtr:1,takeAtr:1,maxHoldBars:10});
    const report=await runAnalysisValidation(input,{...fast,definitions:[definition('manual',[{index:40}])]});
    expect(report.research.trades[0]).toMatchObject({entryBar:41,exitBar:41,exitPrice:98,exitReason:'both-hit-stop-first',ambiguous:true,net:-20});
  });
  it('executes a gap through a stop at the worse open and separates slippage from fees',async()=>{
    const data=bars();data[42]={...data[42],open:90,high:91,low:89,close:90};const input=request(data);
    Object.assign(input.research!,{stopAtr:2,takeAtr:0,slippageBps:10});
    const report=await runAnalysisValidation(input,{...fast,definitions:[definition('manual',[{index:40}])]});
    const trade=report.research.trades[0];expect(trade.exitBar).toBe(42);expect(trade.exitPrice).toBeCloseTo(89.91);expect(trade.slippageCost).toBeGreaterThan(0);
    expect(trade.net).toBeCloseTo(trade.grossBeforeCosts-trade.slippageCost-trade.fees);expect(trade.exitReason).toBe('stop');
  });
  it('does not turn neutral, pre-holdout, ended, or future-known observations into entries',async()=>{
    const d=definition('manual',[{index:35},{index:40,direction:'neutral'},{index:44,historical:true},{index:48,availableIndex:55}]);
    const report=await runAnalysisValidation(request(),{...fast,definitions:[d]});
    expect(report.research.trades).toEqual([]);expect(report.research.conclusion).toBe('no-signals');
    expect(report.research.unusableSignals).toBeGreaterThan(0);expect(report.causality.futureEmissions).toBeGreaterThan(0);
  });
  it('returns an explicit no-signal outcome with undefined response accuracy represented as null',async()=>{
    const report=await runAnalysisValidation(request(),{...fast,definitions:[definition('manual',[])]});
    expect(report.responses).toMatchObject({signals:0,evaluated:0,positiveRate:null,meanAfterFrictionPct:null});
    expect(report.research).toMatchObject({net:0,conclusion:'no-signals',winRate:null});
  });
  it('retains a last-closed-candle event as unresolved without inventing the next open',async()=>{
    const report=await runAnalysisValidation(request(),{...fast,definitions:[definition('manual',[{index:63}])]});
    expect(report.responses).toMatchObject({signals:1,evaluated:0,unresolved:1});expect(report.research.trades).toEqual([]);
  });
  it('allows one position at a time and records overlapping event responses separately',async()=>{
    const events=[40,41,42,44].map(index=>({index})),input=request();input.research!.maxHoldBars=10;
    const report=await runAnalysisValidation(input,{...fast,definitions:[definition('manual',events)]});
    expect(report.research.trades).toHaveLength(1);expect(report.research.ignoredWhilePositionOpen).toBe(3);
    expect(report.responses.evaluated).toBe(4);expect(report.responses.overlapping).toBeGreaterThan(0);
  });
  it('skips simultaneous opposing directions instead of selecting the more profitable hindsight trade',async()=>{
    const input=request();input.studies=[{id:'up'},{id:'down'}];
    const report=await runAnalysisValidation(input,{...fast,definitions:[definition('up',[{index:40}]),definition('down',[{index:40,direction:'bearish'}])]});
    expect(report.research.trades).toEqual([]);expect(report.research.conflictingSignals).toBe(2);
  });
  it('does not enter across missing timestamps and terminates an existing trade before a data gap',async()=>{
    const data=bars();for(let i=42;i<data.length;i++)data[i].time+=10*minute;
    const input=request(data);input.research!.maxHoldBars=10;
    const report=await runAnalysisValidation(input,{...fast,definitions:[definition('manual',[{index:40},{index:41}])]});
    expect(report.dataset.gaps).toBe(1);expect(report.research.trades[0]).toMatchObject({exitBar:41,exitReason:'data-gap'});
    expect(report.responses.evaluated).toBe(0);
  });
  it('detects a detector reading future backing arrays without mistaking legal developing-candidate withdrawal for repainting',async()=>{
    const data=bars();data.forEach((b,i)=>{b.open=b.close=100+i;b.high=101+i;b.low=99+i;});
    const bad=await runAnalysisValidation(request(data),{...fast,definitions:[definition('manual',[{index:40}],true)]});
    expect(bad.causality.futureBackingDifferences).toBeGreaterThan(0);expect(bad.causality.status).toBe('issues');
    const developing:IndicatorDef={id:'preview',name:'preview',target:'main',category:'analysis',inputs:[],calc:({cols})=>[{name:'preview',pane:'main',plot:'patterns',color:'#fff',values:new Float64Array(cols.length),
      candidates:cols.length%2?[{id:'preview',family:'harmonic',name:'观察结构',direction:'bullish',points:[{label:'A',time:epoch,value:cols.col('close')[cols.length-1]}],observedAt:cols.col('time')[cols.length-1],ratios:[],description:'可撤销'}]:[]}]};
    const input=request(data,'preview');const okay=await runAnalysisValidation(input,{...fast,definitions:[developing]});
    expect(okay.causality.changedKnownFacts).toBe(0);expect(okay.causality.status).toBe('passed-sampled');expect(okay.research.trades).toEqual([]);
  });
  it('changes the dataset fingerprint after a historical correction and reports the excluded forming candle',async()=>{
    const data=bars(),input=request(data);delete input.closedLength;
    const first=await runAnalysisValidation(input,{...fast,definitions:[definition('manual',[])]});
    data[10].volume+=1;const second=await runAnalysisValidation(input,{...fast,definitions:[definition('manual',[])]});
    expect(first.dataset.closedBars).toBe(63);expect(first.dataset.excludedFormingBars).toBe(1);expect(second.dataset.hash).not.toBe(first.dataset.hash);
  });
  it('includes supplied funding only with disclosed coverage and conservatively treats ambiguous exit-bar credits',async()=>{
    const input=request();input.research!.maxHoldBars=3;
    input.funding={from:time(0),to:time(64),rates:[{time:time(42),rate:.001,markPrice:100},{time:time(43),rate:-.001,markPrice:100}]};
    const report=await runAnalysisValidation(input,{...fast,definitions:[definition('manual',[{index:40}])]});
    expect(report.research.fundingBasis).toBe('covered');expect(report.research.trades[0].funding).toBe(1);expect(report.research.net).toBe(-1);
  });
  it('cancels cooperatively at an asynchronous boundary and never emits a completed report',async()=>{
    const abort=new AbortController(),progress:ValidationProgress[]=[];
    await expect(runAnalysisValidation(request(),{definitions:[definition('manual',[])],signal:abort.signal,onProgress:p=>{progress.push(p);if(p.phase==='causality')abort.abort();},...fast})).rejects.toMatchObject({name:'AbortError'});
    expect(progress.some(p=>p.phase==='complete')).toBe(false);
  });
  it('rejects duplicate funding events instead of silently charging them twice',async()=>{
    const input=request(),point={time:time(42),rate:.001,markPrice:100};input.funding={from:time(0),to:time(64),rates:[point,point]};
    await expect(runAnalysisValidation(input,{...fast,definitions:[definition('manual',[{index:40}])]})).rejects.toThrow('无效或重复');
  });
  it('rejects non-chronological data rather than silently sorting or optimizing it',async()=>{
    const data=bars();data[10].time=data[9].time;
    await expect(runAnalysisValidation(request(data),{...fast,definitions:[definition('manual',[])]})).rejects.toThrow('重复或倒序');
  });
});

describe('validation worker cancellation boundary',()=>{
  it('terminates the worker and rejects a cancelled client job immediately',async()=>{
    class WorkerStub {static current:WorkerStub;sent:unknown[]=[];onmessage:null=null;onerror:null=null;terminate=vi.fn();constructor(){WorkerStub.current=this;}postMessage(message:unknown){this.sent.push(message);}}
    vi.stubGlobal('Worker',WorkerStub);const job=createAnalysisValidationJob(request());const rejection=expect(job.promise).rejects.toMatchObject({name:'AbortError'});job.cancel();await rejection;
    expect(WorkerStub.current.terminate).toHaveBeenCalledTimes(1);expect(WorkerStub.current.sent).toHaveLength(2);
  });
  it('handles a real worker cancel request after progress without returning a partial success',async()=>{
    vi.resetModules();const output:ValidationWorkerResponse[]=[];let done:()=>void=()=>{};
    const complete=new Promise<void>(resolve=>done=resolve),port={onmessage:null as ((event:{data:unknown})=>void)|null,postMessage:(message:ValidationWorkerResponse)=>{
      output.push(message);if(message.type==='progress'&&message.progress.phase==='causality')port.onmessage!({data:{type:'cancel',jobId:'cancel-test'}});
      if(message.type==='cancelled'||message.type==='error'||message.type==='result')done();
    }};
    vi.stubGlobal('self',port);await import('../src/lib/analysis/validation.worker');
    const input=request(bars(),'analysis-candles');port.onmessage!({data:{type:'run',jobId:'cancel-test',request:input}});await complete;
    expect(output.at(-1)?.type).toBe('cancelled');expect(output.some(m=>m.type==='result')).toBe(false);
  });
});
