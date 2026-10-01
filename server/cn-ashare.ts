import type {BarInput} from '../src/lib/core/types';
import {normalizeCnAShareSymbol} from '../src/lib/market/connectors';
import type {MarketSymbol} from '../src/lib/watchlist/types';

function badgeForCode(code:string,exchange:string):{exchangeLabel:string;marketBadge:string} {
  const exchangeLabel=exchange==='SH'?'上交所':exchange==='BJ'?'北交所':'深交所';
  const marketBadge=code.startsWith('688')||code.startsWith('689')
    ?'科创板'
    :code.startsWith('300')||code.startsWith('301')
    ?'创业板'
    :exchange==='BJ'||code.startsWith('8')||code.startsWith('4')||code.startsWith('92')
    ?'北证A股'
    :code.startsWith('51')||code.startsWith('56')||code.startsWith('58')||code.startsWith('15')
    ?'场内ETF'
    :exchange==='SH'
    ?'沪市主板'
    :'深市主板';
  return {exchangeLabel,marketBadge};
}

export function makeCnSymbol(symbol:string,name:string):MarketSymbol {
  const [code,exchange='SH']=symbol.split('.');
  const {exchangeLabel,marketBadge}=badgeForCode(code,exchange);
  return {
    symbol,
    baseAsset:code,
    quoteAsset:'CNY',
    name,
    source:'cn-a',
    marketType:'cn-equity',
    exchangeLabel,
    marketBadge,
  };
}

export const CURATED_CN_A_SYMBOLS:readonly MarketSymbol[]=[
  makeCnSymbol('600519.SH','贵州茅台'),
  makeCnSymbol('300750.SZ','宁德时代'),
  makeCnSymbol('002594.SZ','比亚迪'),
  makeCnSymbol('601318.SH','中国平安'),
  makeCnSymbol('000001.SZ','平安银行'),
  makeCnSymbol('600036.SH','招商银行'),
  makeCnSymbol('688981.SH','中芯国际'),
  makeCnSymbol('300059.SZ','东方财富'),
  makeCnSymbol('601899.SH','紫金矿业'),
  makeCnSymbol('000858.SZ','五粮液'),
  makeCnSymbol('688256.SH','寒武纪'),
  makeCnSymbol('601127.SH','赛力斯'),
  makeCnSymbol('002475.SZ','立讯精密'),
  makeCnSymbol('600900.SH','长江电力'),
  makeCnSymbol('601857.SH','中国石油'),
  makeCnSymbol('601088.SH','中国神华'),
  makeCnSymbol('000333.SZ','美的集团'),
  makeCnSymbol('600276.SH','恒瑞医药'),
  makeCnSymbol('300760.SZ','迈瑞医疗'),
  makeCnSymbol('603259.SH','药明康德'),
  makeCnSymbol('002230.SZ','科大讯飞'),
  makeCnSymbol('601398.SH','工商银行'),
  makeCnSymbol('601288.SH','农业银行'),
  makeCnSymbol('600030.SH','中信证券'),
  makeCnSymbol('601012.SH','隆基绿能'),
  makeCnSymbol('002415.SZ','海康威视'),
  makeCnSymbol('300124.SZ','汇川技术'),
  makeCnSymbol('688041.SH','海光信息'),
  makeCnSymbol('688111.SH','金山办公'),
  makeCnSymbol('830799.BJ','艾融软件'),
  makeCnSymbol('835670.BJ','数字人'),
  makeCnSymbol('510300.SH','沪深300ETF'),
  makeCnSymbol('588000.SH','科创50ETF'),
  makeCnSymbol('159915.SZ','创业板ETF'),
];

function parseCnTime(raw:string):number {
  const trimmed=raw.trim();
  if(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(trimmed)){
    return Date.parse(`${trimmed.replace(/\s+/,'T')}:00+08:00`);
  }
  if(/^\d{12}$/.test(trimmed)){
    const y=trimmed.slice(0,4),m=trimmed.slice(4,6),d=trimmed.slice(6,8),hh=trimmed.slice(8,10),mm=trimmed.slice(10,12);
    return Date.parse(`${y}-${m}-${d}T${hh}:${mm}:00+08:00`);
  }
  if(/^\d{4}-\d{2}-\d{2}$/.test(trimmed)){
    return Date.parse(`${trimmed}T00:00:00+08:00`);
  }
  return Date.parse(trimmed);
}

function toEastmoneyKlt(interval:string):number {
  const map:Record<string,number>={
    '1m':1,
    '3m':5,
    '5m':5,
    '15m':15,
    '30m':30,
    '1h':60,
    '2h':60,
    '4h':101,
    '6h':101,
    '12h':101,
    '1d':101,
    '3d':101,
    '7d':102,
    '30d':103,
  };
  return map[interval]??15;
}

async function fetchEastmoneyKlines(
  symbol:string,
  interval:string,
  limit:number,
  request:typeof fetch,
  signal?:AbortSignal
):Promise<{bars:BarInput[];name?:string}> {
  const [code,exchange='SH']=symbol.split('.');
  const secid=`${exchange==='SH'?1:0}.${code}`;
  const klt=toEastmoneyKlt(interval);
  const lmt=Math.max(30,Math.min(1500,limit));
  const url=`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=1&end=20500101&lmt=${lmt}`;
  const res=await request(url,{
    signal,
    headers:{
      'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer':'https://quote.eastmoney.com/',
    },
  });
  if(!res.ok)throw Error(`东方财富行情接口响应 ${res.status}`);
  const body=await res.json() as {data?:{name?:string;klines?:string[]}};
  const klines=body?.data?.klines;
  if(!Array.isArray(klines)||!klines.length)throw Error('东方财富未返回有效 K 线');
  const bars:BarInput[]=[];
  let lastTime=-1;
  for(const line of klines){
    const parts=String(line).split(',');
    if(parts.length<6)continue;
    const time=parseCnTime(parts[0]);
    const open=Number(parts[1]),close=Number(parts[2]),high=Number(parts[3]),low=Number(parts[4]);
    const volume=Math.max(0,Math.round(Number(parts[5])*100));
    if(!Number.isFinite(time)||time<=lastTime||![open,high,low,close].every(v=>Number.isFinite(v)&&v>0))continue;
    bars.push({time,open,high:Math.max(high,open,close),low:Math.min(low,open,close),close,volume});
    lastTime=time;
  }
  if(!bars.length)throw Error('东方财富 K 线解析为空');
  return {bars,name:body?.data?.name};
}

async function fetchTencentKlines(
  symbol:string,
  interval:string,
  limit:number,
  request:typeof fetch,
  signal?:AbortSignal
):Promise<{bars:BarInput[];name?:string}> {
  const [code,exchange='SH']=symbol.split('.');
  const prefix=exchange.toLowerCase();
  const fullCode=`${prefix}${code}`;
  const count=Math.max(30,Math.min(800,limit));
  const minuteMap:Record<string,string>={'1m':'m1','3m':'m5','5m':'m5','15m':'m15','30m':'m30','1h':'m60','2h':'m60'};
  const mType=minuteMap[interval];
  const url=mType
    ?`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${fullCode},${mType},,${count}`
    :`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${fullCode},${interval==='7d'?'week':interval==='30d'?'month':'day'},,,${count},qfq`;
  const res=await request(url,{signal});
  if(!res.ok)throw Error(`腾讯财经行情接口响应 ${res.status}`);
  const body=await res.json() as {data?:Record<string,Record<string,unknown>>};
  const node=body?.data?.[fullCode];
  if(!node||typeof node!=='object')throw Error('腾讯财经未返回该标的 K 线');
  const key=mType??(interval==='7d'?'qfqweek':interval==='30d'?'qfqmonth':'qfqday');
  const fallbackKey=interval==='7d'?'week':interval==='30d'?'month':'day';
  const rows=(node[key]??node[fallbackKey]) as unknown;
  if(!Array.isArray(rows)||!rows.length)throw Error('腾讯财经 K 线数组为空');
  const bars:BarInput[]=[];
  let lastTime=-1;
  for(const r of rows){
    if(!Array.isArray(r)||r.length<6)continue;
    const time=parseCnTime(String(r[0]));
    const open=Number(r[1]),close=Number(r[2]),high=Number(r[3]),low=Number(r[4]);
    const volume=Math.max(0,Math.round(Number(r[5])*100));
    if(!Number.isFinite(time)||time<=lastTime||![open,high,low,close].every(v=>Number.isFinite(v)&&v>0))continue;
    bars.push({time,open,high:Math.max(high,open,close),low:Math.min(low,open,close),close,volume});
    lastTime=time;
  }
  if(!bars.length)throw Error('腾讯财经 K 线解析为空');
  return {bars};
}

export async function fetchCnAShareKlines(
  rawSymbol:string,
  interval:string,
  limit=500,
  request:typeof fetch=fetch,
  signal?:AbortSignal
):Promise<{symbol:string;interval:string;bars:BarInput[];name?:string;provider:'eastmoney'|'tencent'}> {
  const symbol=normalizeCnAShareSymbol(rawSymbol);
  if(!symbol)throw Error('无效的沪深京 A 股代码');
  try {
    const res=await fetchEastmoneyKlines(symbol,interval,limit,request,signal);
    return {symbol,interval,bars:res.bars,name:res.name,provider:'eastmoney'};
  } catch {
    const res=await fetchTencentKlines(symbol,interval,limit,request,signal);
    return {symbol,interval,bars:res.bars,name:res.name,provider:'tencent'};
  }
}

export async function searchCnAShareSymbols(
  query:string,
  limit=30,
  request:typeof fetch=fetch,
  signal?:AbortSignal
):Promise<MarketSymbol[]> {
  const q=query.trim();
  if(!q)return [...CURATED_CN_A_SYMBOLS].slice(0,limit);
  const results=new Map<string,MarketSymbol>();
  const needle=q.toUpperCase();
  for(const item of CURATED_CN_A_SYMBOLS){
    if(item.symbol.includes(needle)||item.baseAsset.includes(needle)||(item.name?.toUpperCase().includes(needle)??false)){
      results.set(item.symbol,item);
    }
  }
  try {
    const count=Math.max(10,Math.min(50,limit));
    const url=`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=${count}`;
    const res=await request(url,{
      signal,
      headers:{
        'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer':'https://quote.eastmoney.com/',
      },
    });
    if(res.ok){
      const body=await res.json() as {QuotationCodeTable?:{Data?:Array<{Code?:string;Name?:string;SecurityTypeName?:string;MktNum?:string}>}};
      const rows=body?.QuotationCodeTable?.Data;
      if(Array.isArray(rows)){
        for(const row of rows){
          const code=row.Code?.trim();
          const name=row.Name?.trim();
          if(!code||!/^\d{6}$/.test(code)||!name)continue;
          const suffix=row.MktNum==='1'?'SH':row.MktNum==='0'?(code.startsWith('8')||code.startsWith('4')||code.startsWith('92')?'BJ':'SZ'):null;
          const normalized=normalizeCnAShareSymbol(suffix?`${code}.${suffix}`:code);
          if(!normalized)continue;
          results.set(normalized,makeCnSymbol(normalized,name));
          if(results.size>=limit)break;
        }
      }
    }
  } catch {
    // Fallback to local curated matches + code normalization below
  }
  const direct=normalizeCnAShareSymbol(q);
  if(direct&&!results.has(direct)){
    results.set(direct,makeCnSymbol(direct,`A股 ${direct}`));
  }
  return [...results.values()].slice(0,limit);
}
