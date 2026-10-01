import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {MarketDataService,createMarketDataHandler} from '../server/market-data';
import {MarketStore} from '../server/market-store';
import {archiveDates,archiveFile} from '../server/market-archive';
import type {AggregateTrade} from '../src/lib/flow/types';
import type {RecordedMarketEvent} from '../src/lib/flow/persistence-client';

const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{vi.useRealTimers();for(const close of cleanups.splice(0).reverse())await close();});
async function directory(){const dir=await mkdtemp(join(tmpdir(),'market-test-'));cleanups.push(()=>rm(dir,{recursive:true,force:true}));return dir;}
const trade=(id:string,time=100):AggregateTrade=>({symbol:'BTCUSDT',id,time,price:100,baseQuantity:2,quoteQuantity:200,aggressor:'buy'});
function zip(name:string,text:string):Buffer {
  const data=Buffer.from(text),filename=Buffer.from(name);let crc=0xffffffff;for(const value of data){crc^=value;for(let i=0;i<8;i++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(filename.length,28);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+filename.length,12);end.writeUInt32LE(local.length+filename.length+data.length,16);
  return Buffer.concat([local,filename,data,central,filename,end]);
}
const spec={symbol:'BTCUSDT',type:'aggTrades' as const,period:'daily' as const,date:'2020-01-01'};
const archive=()=>zip(`${archiveFile(spec).name}.csv`,'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker\n1,7200,2,1,1,1577836800000,false\n3,7201,1,3,3,1577836800100,true\n');
const checksum=(buffer:Buffer)=>createHash('sha256').update(buffer).digest('hex');
const bytes=async function*(buffer:Buffer){for(let i=0;i<buffer.length;i+=17)yield buffer.subarray(i,i+17);};
async function complete(service:MarketDataService,id:string){for(let i=0;i<500;i++){const job=service.store.getJob(id);if(!['running','queued'].includes(job.status))return job;await new Promise(r=>setTimeout(r,5));}throw Error('job timeout');}

describe('market persistence and replay',()=>{
  it('keeps plugin creation lazy and prevents a second writer from misclassifying an active recording as interrupted',async()=>{
    const dir=await directory(),handler=createMarketDataHandler({directory:dir,recordLive:false});await handler.close();
    await expect(access(join(dir,'market.sqlite'))).rejects.toThrow();
    const first=new MarketStore(dir),recording=first.create({symbol:'BTCUSDT',kind:'recording',tradeType:'aggTrades',state:'recording',source:'test'});
    expect(()=>new MarketStore(dir)).toThrow('占用');expect(first.get(recording.id).state).toBe('recording');first.close();
    const reopened=new MarketStore(dir);expect(reopened.get(recording.id).state).toBe('stopped');reopened.close();
  });
  it('persists deduplicated indexed trades and repairs ID gaps across restart and cursor pages',async()=>{
    const dir=await directory();let store=new MarketStore(dir);
    const dataset=store.create({symbol:'BTCUSDT',kind:'recording',tradeType:'aggTrades',state:'recording',source:'test'});
    store.writeTrades(dataset.id,[trade('3',300),trade('1',100)]);expect(store.coverage(dataset.id).gaps[0]).toMatchObject({fromId:'2',toId:'2'});
    store.writeTrades(dataset.id,[trade('2',200),trade('3',300)]);expect(store.coverage(dataset.id).gaps).toEqual([]);expect(store.get(dataset.id).tradeCount).toBe(3);
    expect(()=>store.writeTrades(dataset.id,[{...trade('2',200),price:999}])).toThrow('冲突');
    const first=store.trades(dataset.id,{limit:2});expect(first.rows.map(t=>t.id)).toEqual(['1','2']);expect(first.nextCursor).toBeDefined();
    store.close();store=new MarketStore(dir);cleanups.push(async()=>store.close());
    expect(store.get(dataset.id).state).toBe('stopped');expect(store.trades(dataset.id,{limit:2,cursor:first.nextCursor}).rows.map(t=>t.id)).toEqual(['3']);
    expect(store.trades(dataset.id,{from:150,to:250}).rows.map(t=>t.id)).toEqual(['2']);
  });

  it('reconstructs L2 only from recorded, already received snapshots and continuous diffs and leaves heatmap gaps blank',async()=>{
    const dir=await directory(),store=new MarketStore(dir);cleanups.push(async()=>store.close());
    const dataset=store.create({symbol:'BTCUSDT',kind:'recording',tradeType:'aggTrades',state:'recording',source:'test'});
    const events:RecordedMarketEvent[]=[
      {kind:'depth-snapshot',time:100,receivedAt:100,lastUpdateId:10,bids:[{price:100,quantity:5}],asks:[{price:101,quantity:2}],origin:'rest'},
      {kind:'depth-diff',time:110,receivedAt:110,U:10,u:12,pu:9,bids:[{price:100,quantity:3}],asks:[]},
      {kind:'gap',time:130,receivedAt:130,reason:'网络缺口'},
      {kind:'depth-snapshot',time:150,receivedAt:160,lastUpdateId:30,bids:[{price:100,quantity:9}],asks:[{price:101,quantity:4}],origin:'checkpoint'},
    ];
    store.append(dataset.id,events);store.append(dataset.id,events);expect(store.get(dataset.id).depthCount).toBe(4);
    expect(store.replayBook(dataset.id,90).status).toBe('unavailable');expect(store.replayBook(dataset.id,100).status).toBe('unavailable');
    expect(store.replayBook(dataset.id,120)).toMatchObject({status:'available',lastUpdateId:12,bids:[{price:100,quantity:3}]});
    expect(store.replayBook(dataset.id,155).status).toBe('gap');expect(store.replayBook(dataset.id,180)).toMatchObject({status:'available',lastUpdateId:30});
    const heatmap=await store.heatmap(dataset.id,90,180,4,10);expect(heatmap.samples.map(s=>s.book.status)).toEqual(['unavailable','available','gap','available']);
    store.append(dataset.id,[{kind:'depth-diff',time:190,receivedAt:190,U:35,u:36,pu:34,bids:[],asks:[]}]);expect(store.replayBook(dataset.id,200).status).toBe('gap');
    store.update({...store.get(dataset.id),state:'stopped',stoppedAt:200});expect(store.replayBook(dataset.id,201).status).toBe('unavailable');
  });

  it('downloads from the fixed official host, validates checksum, streams CSV and reuses identical completed imports',async()=>{
    const dir=await directory(),payload=archive(),request=vi.fn<typeof fetch>(async url=>String(url).endsWith('.CHECKSUM')?new Response(`${checksum(payload)}  ${archiveFile(spec).name}.zip\n`):new Response(Uint8Array.from(payload)));
    const service=new MarketDataService({directory:dir,fetch:request,recordLive:false});cleanups.push(()=>service.close());
    const first=service.startImport({...spec,from:spec.date});const done=await complete(service,first.id);expect(done.status).toBe('complete');
    expect(request.mock.calls.every(([url])=>String(url).startsWith('https://data.binance.vision/data/futures/um/daily/aggTrades/BTCUSDT/'))).toBe(true);
    const info=service.store.get(done.datasetIds[0]);expect(info).toMatchObject({state:'complete',tradeCount:2,checksum:checksum(payload),gapCount:1});
    expect(service.store.trades(info.id).rows.map(t=>t.aggressor)).toEqual(['buy','sell']);
    const again=await complete(service,service.startImport({...spec,from:spec.date}).id);expect(again.datasetIds).toEqual(done.datasetIds);expect(service.store.list()).toHaveLength(1);
    expect(service.store.listJobs().map(job=>job.id)).toEqual(expect.arrayContaining([first.id,again.id]));
    await service.close();const restarted=new MarketStore(dir);expect(restarted.listJobs()).toHaveLength(2);expect(restarted.getJob(first.id).status).toBe('complete');restarted.close();
  });

  it('rejects checksum failures and ZIP traversal instead of exposing a partial import as complete',async()=>{
    const dir=await directory(),payload=archive(),service=new MarketDataService({directory:dir,recordLive:false});cleanups.push(()=>service.close());
    await expect(service.upload(bytes(payload),{...spec,checksum:'0'.repeat(64)},new AbortController().signal)).rejects.toThrow('SHA-256');
    expect(service.store.list()).toHaveLength(0);
    const unsafe=zip('../outside.csv','1,100,1,1,1,1577836800000,false\n');
    await expect(service.upload(bytes(unsafe),{...spec,checksum:checksum(unsafe)},new AbortController().signal)).rejects.toThrow();
    const failed=service.store.list()[0];expect(failed.state).toBe('failed');expect(()=>service.store.trades(failed.id)).toThrow('尚未完成');
    expect(()=>archiveDates({...spec,from:'2020-02-31'})).toThrow();expect(()=>archiveFile({...spec,symbol:'../BTCUSDT'})).toThrow();
    expect(archiveDates({symbol:'BTCUSDT',type:'trades',period:'monthly',from:'2020-01',to:'2020-03'})).toEqual(['2020-01','2020-02','2020-03']);
  });

  it('accepts a checksum-verified uploaded archive and enforces download/decompression size limits',async()=>{
    const dir=await directory(),payload=archive(),service=new MarketDataService({directory:dir,recordLive:false,maxArchiveBytes:payload.length+1});cleanups.push(()=>service.close());
    const info=await service.upload(bytes(payload),{...spec,checksum:checksum(payload)},new AbortController().signal);expect(info.tradeCount).toBe(2);
    const overflow=Buffer.concat([payload,Buffer.alloc(2)]);await expect(service.upload(bytes(overflow),{...spec,checksum:checksum(overflow)},new AbortController().signal)).rejects.toThrow('大小');
    const other=await directory(),bounded=new MarketDataService({directory:other,recordLive:false,maxInflatedBytes:10});cleanups.push(()=>bounded.close());
    await expect(bounded.upload(bytes(payload),{...spec,checksum:checksum(payload)},new AbortController().signal)).rejects.toThrow('体积');
  });

  it('imports monthly individual trades while retaining their real quote quantity and exact calendar boundaries',async()=>{
    const dir=await directory(),service=new MarketDataService({directory:dir,recordLive:false});cleanups.push(()=>service.close());
    const monthly={symbol:'BTCUSDT',type:'trades' as const,period:'monthly' as const,date:'2020-02'};
    const payload=zip(`${archiveFile(monthly).name}.csv`,'id,price,qty,quote_qty,time,is_buyer_maker\n99,100,2,200.00001,1580515200000,false\n100,101,1,101,1583020799999,true\n');
    const dataset=await service.upload(bytes(payload),{...monthly,checksum:checksum(payload)},new AbortController().signal);
    expect(dataset).toMatchObject({state:'complete',tradeType:'trades',period:'monthly',tradeCount:2});
    expect(service.store.trades(dataset.id).rows[0].quoteQuantity).toBe(200.00001);
    const outside=zip(`${archiveFile(monthly).name}.csv`,'101,100,1,100,1583020800000,false\n');
    await expect(service.upload(bytes(outside),{...monthly,checksum:checksum(outside)},new AbortController().signal)).rejects.toThrow('日期');
  });

  it('attempts a requested date range and preserves an explicit partial-failure state for missing official files',async()=>{
    const dir=await directory(),payload=archive(),request:typeof fetch=async url=>String(url).includes('2020-01-02')?new Response('',{status:404}):String(url).endsWith('.CHECKSUM')?new Response(`${checksum(payload)}  ${archiveFile(spec).name}.zip`):new Response(Uint8Array.from(payload));
    const service=new MarketDataService({directory:dir,recordLive:false,fetch:request});cleanups.push(()=>service.close());
    const job=await complete(service,service.startImport({...spec,from:'2020-01-01',to:'2020-01-02'}).id);
    expect(job).toMatchObject({status:'failed',files:2,completedFiles:1});expect(job.message).toContain('1 个失败');
    expect(service.store.get(job.datasetIds[0]).state).toBe('complete');
  });

  it('cancels pending uploads before closing SQLite so a service restart cannot race a late importer write',async()=>{
    const dir=await directory(),service=new MarketDataService({directory:dir,recordLive:false}),payload=archive();
    const stream=new Readable({read(){}});stream.push(payload.subarray(0,20));
    const pending=service.upload(stream,{...spec,checksum:checksum(payload)},new AbortController().signal);
    const rejection=expect(pending).rejects.toThrow();await service.close();await rejection;
    const reopened=new MarketStore(dir);expect(reopened.list().some(d=>d.state==='complete')).toBe(false);reopened.close();
  });

  it('cancels an active network import without promoting unfinished rows',async()=>{
    const dir=await directory(),payload=archive();let started=false;
    const request:typeof fetch=async(url,options)=>{
      if(String(url).endsWith('.CHECKSUM'))return new Response(`${checksum(payload)}  ${archiveFile(spec).name}.zip`);
      started=true;return new Response(new ReadableStream({start(controller){controller.enqueue(Uint8Array.from(payload.subarray(0,20)));options?.signal?.addEventListener('abort',()=>controller.error(Error('aborted')),{once:true});}}));
    };
    const service=new MarketDataService({directory:dir,fetch:request,recordLive:false});cleanups.push(()=>service.close());
    const job=service.startImport({...spec,from:spec.date});await vi.waitFor(()=>expect(started).toBe(true));service.cancelImport(job.id);
    expect(service.store.listJobs().some(item=>item.id===job.id)).toBe(true);
    await vi.waitFor(()=>expect(service.store.getJob(job.id).status).toBe('cancelled'));expect(service.store.list().some(d=>d.state==='complete')).toBe(false);
  });

  it('keeps recording in the local service without a browser event-upload bridge',async()=>{
    const dir=await directory(),sockets:MockSocket[]=[];
    class MockSocket {
      onopen:((e:Event)=>void)|null=null;onmessage:((e:MessageEvent)=>void)|null=null;onclose:((e:CloseEvent)=>void)|null=null;onerror:((e:Event)=>void)|null=null;
      close=vi.fn();constructor(readonly url:string){sockets.push(this);}open(){this.onopen?.({} as Event);}send(value:unknown){this.onmessage?.({data:JSON.stringify(value)} as MessageEvent);}
    }
    const time=Date.now(),request:typeof fetch=async url=>new Response(JSON.stringify(String(url).includes('/depth?')?{lastUpdateId:10,T:time,bids:[['100','5']],asks:[['101','4']]}:[]));
    const service=new MarketDataService({directory:dir,fetch:request,WebSocket:MockSocket as unknown as typeof WebSocket,flushMs:50});cleanups.push(()=>service.close());
    const recording=service.startRecording('BTCUSDT');expect(sockets).toHaveLength(2);sockets.forEach(s=>s.open());await new Promise(r=>setTimeout(r,0));
    sockets.find(s=>s.url.includes('/market/'))!.send({e:'aggTrade',s:'BTCUSDT',a:1,p:'100',q:'2',T:time,m:false});
    sockets.find(s=>s.url.includes('/public/'))!.send({e:'depthUpdate',s:'BTCUSDT',U:10,u:11,pu:9,T:time+1,b:[['100','3']],a:[]});
    await vi.waitFor(()=>expect(service.store.get(recording.id).tradeCount).toBe(1));
    expect(service.store.get(recording.id).depthCount).toBeGreaterThanOrEqual(3);expect(service.store.replayBook(recording.id,Date.now()+10).status).toBe('available');
    service.stopRecording(recording.id);expect(sockets.every(s=>s.close.mock.calls.length===1)).toBe(true);expect(service.store.get(recording.id).state).toBe('stopped');
  });

  it('serves only local same-origin API calls and denies arbitrary data paths',async()=>{
    const dir=await directory(),handler=createMarketDataHandler({directory:dir,recordLive:false}),server=createServer((request,response)=>handler(request,response,()=>{response.statusCode=404;response.end();}));
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port,base=`http://127.0.0.1:${port}`;
    cleanups.push(async()=>{await new Promise<void>(r=>server.close(()=>r()));await handler.close();});
    expect((await fetch(`${base}/api/market-data/datasets`,{headers:{Origin:'https://other.example'}})).status).toBe(403);
    const response=await fetch(`${base}/api/market-data/recordings`,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({symbol:'BTCUSDT'})});expect(response.status).toBe(201);
    const recording=await response.json();expect((await(await fetch(`${base}/api/market-data/datasets`)).json())[0].id).toBe(recording.id);
    expect((await fetch(`${base}/api/market-data/datasets/not-a-uuid/trades`)).status).toBe(400);
    expect((await fetch(`${base}/api/market-data/imports`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...spec,symbol:'../BTCUSDT',from:spec.date})})).status).toBe(400);
  });

  it('seeds and persists multi-channel symbol catalogs in SQLite across Binance, OKX, Coinbase, and China A-Shares',async()=>{
    const dir=await directory(),store=new MarketStore(dir);
    cleanups.push(async()=>store.close());

    const sources=store.symbolSources();
    expect(sources.map(s=>s.source)).toEqual(expect.arrayContaining(['binance','cn-a','coinbase','okx']));
    const initialSymbols=store.listSymbols();
    expect(initialSymbols.some(s=>s.source==='cn-a'&&s.symbol==='600519.SH'&&s.name==='贵州茅台')).toBe(true);
    expect(initialSymbols.some(s=>s.source==='coinbase'&&s.symbol==='BTC-USD')).toBe(true);
    expect(initialSymbols.some(s=>s.source==='okx'&&s.symbol==='BTCUSDT')).toBe(true);

    const count=store.upsertSymbols([
      {symbol:'601857.SH',baseAsset:'601857',quoteAsset:'CNY',name:'中国石油',source:'cn-a',marketType:'cn-equity',exchangeLabel:'上交所',marketBadge:'沪市主板'},
      {symbol:'ARB-USD',baseAsset:'ARB',quoteAsset:'USD',name:'Arbitrum',source:'coinbase',marketType:'spot',exchangeLabel:'COINBASE',marketBadge:'USD 现货'},
    ]);
    expect(count).toBe(2);

    const cnMatches=store.listSymbols({source:'cn-a',query:'石油'});
    expect(cnMatches).toHaveLength(1);
    expect(cnMatches[0]).toMatchObject({symbol:'601857.SH',name:'中国石油',source:'cn-a'});

    store.close();
    const reopened=new MarketStore(dir);
    cleanups.push(async()=>reopened.close());
    expect(reopened.listSymbols({source:'coinbase',query:'ARB'})[0]).toMatchObject({symbol:'ARB-USD',name:'Arbitrum',source:'coinbase'});

    // Also verify connector_configs table persistence in SQLite
    reopened.saveConnectorConfigs([
      {source:'cn-a',enabled:true,mode:'auto',restBase:'/api/market-data/cn-a',defaultSymbol:'600519.SH'},
      {source:'okx',enabled:true,mode:'live',restBase:'https://www.okx.com',wsUrl:'wss://ws.okx.com:8443/ws/v5/business',defaultSymbol:'ETHUSDT'},
    ]);
    const savedConfigs=reopened.listConnectorConfigs();
    expect(savedConfigs).toEqual(expect.arrayContaining([
      expect.objectContaining({source:'cn-a',mode:'auto',defaultSymbol:'600519.SH'}),
      expect.objectContaining({source:'okx',mode:'live',defaultSymbol:'ETHUSDT'}),
    ]));
  });

  it('proxies China A-Share klines and symbol search and persists discovered A-share stocks into SQLite',async()=>{
    const {fetchCnAShareKlines,searchCnAShareSymbols,makeCnSymbol}=await import('../server/cn-ashare');
    const dir=await directory(),store=new MarketStore(dir);
    cleanups.push(async()=>store.close());

    const fakeFetch:typeof fetch=async(input)=>{
      const url=String(input);
      if(url.includes('push2his.eastmoney.com')){
        return new Response(JSON.stringify({
          data:{
            code:'600519',
            name:'贵州茅台',
            klines:[
              '2026-09-24,1480.00,1512.50,1520.00,1475.00,32500,4910000000.00',
              '2026-09-25,1512.50,1536.80,1545.00,1508.00,41200,6310000000.00',
            ],
          },
        }),{status:200,headers:{'Content-Type':'application/json'}});
      }
      if(url.includes('searchapi.eastmoney.com')){
        return new Response(JSON.stringify({
          QuotationCodeTable:{
            Data:[
              {Code:'688256',Name:'寒武纪-U',MktNum:'1',SecurityTypeName:'科创板'},
              {Code:'300750',Name:'宁德时代',MktNum:'0',SecurityTypeName:'深A'},
            ],
          },
        }),{status:200,headers:{'Content-Type':'application/json'}});
      }
      return new Response('{}',{status:404});
    };

    const klineBody=await fetchCnAShareKlines('600519','1d',10,fakeFetch);
    expect(klineBody.symbol).toBe('600519.SH');
    expect(klineBody.name).toBe('贵州茅台');
    expect(klineBody.provider).toBe('eastmoney');
    expect(klineBody.bars).toHaveLength(2);
    expect(klineBody.bars[1].close).toBe(1536.8);
    expect(klineBody.bars[1].volume).toBe(41200*100);
    if(klineBody.name){
      store.upsertSymbols([makeCnSymbol(klineBody.symbol,klineBody.name)]);
    }

    const foundSymbols=await searchCnAShareSymbols('寒武纪',20,fakeFetch);
    expect(foundSymbols.some(s=>s.symbol==='688256.SH'&&s.name?.includes('寒武纪'))).toBe(true);
    store.upsertSymbols(foundSymbols);
    expect(store.listSymbols({source:'cn-a',query:'寒武纪'})[0]).toMatchObject({symbol:'688256.SH',source:'cn-a'});
  });
});
