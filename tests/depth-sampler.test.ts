import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DepthSampler,binLevels,createDepthSamplerHandler,packLevels,rebucket,unpackLevels} from '../server/depth-sampler';
import type {BookSnapshot,OrderBookSessionOptions} from '../src/lib/flow/orderbook';

const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const dir=()=>{const d=mkdtempSync(join(tmpdir(),'depth-sampler-'));dirs.push(d);return d;};
function book(mid:number,at:number):BookSnapshot {
  return {symbol:'BTCUSDT',status:'live',updatedAt:at,lastReceivedAt:at,lastUpdateId:1,revision:1,segmentId:1,
    bids:Array.from({length:300},(_,i)=>({price:mid-0.1-i*0.3,quantity:1+(i%10)})),asks:Array.from({length:300},(_,i)=>({price:mid+0.1+i*0.3,quantity:2+(i%7)}))} as BookSnapshot;
}
function harness(options:{now?:()=>number;intervalMs?:number}={}){
  const hooks=new Map<string,(snapshot:BookSnapshot)=>void>(),sessions:string[]=[];
  const createSession=(o:OrderBookSessionOptions)=>{hooks.set(o.symbol,o.onUpdate!);sessions.push(o.symbol);return {connect:vi.fn(async()=>{}),disconnect:vi.fn()};};
  const directory=dir(),sampler=new DepthSampler({directory,createSession,intervalMs:options.intervalMs??10_000,now:options.now});
  return {sampler,hooks,sessions,directory,createSession};
}

describe('depth sample encoding',()=>{
  it('bins bids down and asks up, round-trips the packed blob, and re-buckets on aligned boundaries',()=>{
    const bids=binLevels([{price:100.8,quantity:2},{price:100.2,quantity:3},{price:99.2,quantity:4}],1,'bid');
    expect(bids).toEqual([[100,5],[99,4]]);
    expect(unpackLevels(packLevels(bids))).toEqual([[100,5],[99,4]]);
    const fine:Array<[number,number]>=[[82_624,1],[82_600,2],[82_599,4]];// $1 bins
    expect(rebucket(fine,1,25,'bid')).toEqual([[82_600,3],[82_575,4]]);
    expect(rebucket([[82_601,1],[82_625,2],[82_626,4]],1,25,'ask')).toEqual([[82_625,3],[82_650,4]]);
  });
});

describe('DepthSampler',()=>{
  it('samples only a live, fresh book; ignores a duplicate slot; decimates and re-buckets history',()=>{
    let now=1_000_000;const {sampler,hooks}=harness({now:()=>now});
    sampler.watch('BTCUSDT');
    expect(sampler.sample('BTCUSDT')).toBe(false);// no book yet
    hooks.get('BTCUSDT')!(book(82_600,now-10_000));expect(sampler.sample('BTCUSDT')).toBe(false);// stale
    for(let i=0;i<60;i++){now=1_000_000+i*10_000;hooks.get('BTCUSDT')!(book(82_600+i,now));expect(sampler.sample('BTCUSDT')).toBe(true);}
    hooks.get('BTCUSDT')!(book(99_999,now));sampler.sample('BTCUSDT');// same slot as the last sample → ignored
    const all=sampler.history('BTCUSDT',0,now,25,1000);
    expect(all.samples).toHaveLength(60);expect(all.intervalMs).toBe(10_000);expect(all.strideMs).toBe(10_000);
    const last=all.samples.at(-1)!;expect(last.bids[0][0]%25).toBe(0);expect(last.asks[0][0]).toBeGreaterThan(last.bids[0][0]);
    expect(last.bids[0][0]).toBeLessThan(82_700);// not the ignored 99,999 book
    const decimated=sampler.history('BTCUSDT',0,now,25,16);
    expect(decimated.samples.length).toBeLessThanOrEqual(16);expect(decimated.strideMs).toBeGreaterThan(10_000);
    // total quantity is conserved by re-bucketing
    const sum=(rows:Array<[number,number]>)=>rows.reduce((s,[,q])=>s+q,0);
    expect(sum(sampler.history('BTCUSDT',now,now,25).samples[0].bids)).toBeCloseTo(sum(sampler.history('BTCUSDT',now,now,1).samples[0].bids),3);
    sampler.close();
  });
  it('prunes beyond retention, resumes watched symbols after restart and caps concurrent sessions',()=>{
    let now=10_000_000;const directory=dir(),sessions:string[]=[];
    const createSession=(o:OrderBookSessionOptions)=>{sessions.push(o.symbol);return {connect:async()=>{},disconnect:vi.fn()};};
    const a=new DepthSampler({directory,createSession,now:()=>now,maxSymbols:2});
    a.watch('BTCUSDT');now+=1;a.watch('ETHUSDT');now+=1;a.watch('SOLUSDT');
    expect(sessions).toEqual(['BTCUSDT','ETHUSDT','SOLUSDT']);
    a.close();
    const b=new DepthSampler({directory,createSession,now:()=>now,maxSymbols:2});
    expect(sessions.slice(3).sort()).toEqual(['ETHUSDT','SOLUSDT']);// most recently watched
    expect(()=>b.watch('btc')).toThrow();expect(b.prune()).toBe(0);b.close();
  });
});

describe('DepthSampler window and resolution',()=>{
  it('stores ±4% of the mid in bins of 5e-4 of the price decade and drops dust beyond it',()=>{
    let now=2_000_000;const {sampler,hooks}=harness({now:()=>now});sampler.watch('BTCUSDT');
    const snapshot=book(84_000,now);
    // Dust far outside the window plus a wall at +2.5% and a wall at −3.9%.
    snapshot.asks=[...snapshot.asks,{price:86_100,quantity:400},{price:900_000,quantity:1}];
    snapshot.bids=[...snapshot.bids,{price:80_730,quantity:300},{price:1,quantity:999}];
    hooks.get('BTCUSDT')!(snapshot);expect(sampler.sample('BTCUSDT')).toBe(true);
    const {samples}=sampler.history('BTCUSDT',0,now,5,100);const [row]=samples;
    expect(row.asks.some(([price,quantity])=>price===86_100&&quantity===400)).toBe(true);
    expect(row.bids.some(([price,quantity])=>price===80_730&&quantity===300)).toBe(true);
    expect(row.asks.every(([price])=>price<=84_000*1.04+5)).toBe(true);expect(row.bids.every(([price])=>price>=84_000*.96-5)).toBe(true);
    expect(row.asks.some(([price])=>price>=900_000)).toBe(false);expect(row.bids.some(([price])=>price<=1)).toBe(false);
    // Re-bucketing to a display step keeps whole-bin totals.
    const coarse=sampler.history('BTCUSDT',0,now,25,100).samples[0];
    const total=(rows:Array<[number,number]>)=>rows.reduce((sum,[,quantity])=>sum+quantity,0);
    expect(total(coarse.asks)).toBeCloseTo(total(row.asks),3);expect(total(coarse.bids)).toBeCloseTo(total(row.bids),3);
    expect(coarse.asks.every(([price])=>price%25===0)).toBe(true);
    sampler.close();
  });
  it('defaults to 15s slots and asks its book session for deep, horizon-bounded levels',()=>{
    const options:OrderBookSessionOptions[]=[];const directory=dir();
    const sampler=new DepthSampler({directory,createSession:o=>{options.push(o);return {connect:async()=>{},disconnect:()=>{}};}});
    expect(sampler.intervalMs).toBe(15_000);sampler.watch('ETHUSDT');
    expect(options[0]).toMatchObject({symbol:'ETHUSDT',limit:6000,horizonRatio:.04});sampler.close();
  });
});

describe('depth sampler HTTP',()=>{
  it('serves loopback pages only and validates input',async()=>{
    const handler=createDepthSamplerHandler({directory:dir(),createSession:()=>({connect:async()=>{},disconnect:()=>{}})});
    const call=async(url:string,remote='127.0.0.1',method='GET',body='')=>{
      const request=Object.assign((async function*(){if(body)yield Buffer.from(body);})(),{url,method,headers:{host:'localhost:5173'},socket:{remoteAddress:remote}});
      let status=0,payload='';const response={statusCode:0,setHeader(){},end(text:string){status=this.statusCode;payload=text;}};
      await handler(request as never,response as never,()=>{status=-1;});return {status,body:payload?JSON.parse(payload):undefined};
    };
    expect((await call('/other')).status).toBe(-1);
    expect((await call('/api/depth-samples?symbol=BTCUSDT&from=0&to=1&step=25','10.0.0.2')).status).toBe(403);
    expect((await call('/api/depth-samples/watch','127.0.0.1','POST',JSON.stringify({symbol:'BTCUSDT'}))).body.symbol).toBe('BTCUSDT');
    expect((await call('/api/depth-samples?symbol=BTCUSDT&from=0&to=1000&step=25')).body.samples).toEqual([]);
    expect((await call('/api/depth-samples?symbol=bad&from=0&to=1&step=25')).status).toBe(400);
    handler.close();
  });
});
