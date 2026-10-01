import {getLocale,translate,englishMessages,type Locale} from './index';

// Only these platform-owned captures are nested causes. Names, code fragments,
// field titles, order IDs and arbitrary interpolation values remain opaque.
const causes:Array<{source:string;slots:number[];captures?:Record<string,string>}>= [
  {source:'绘图工具出错：{0}',slots:[0]},
  {source:'保存失败：{0}；草稿已保留，原保存版本未改变',slots:[0]},
  {source:'脚本替换未完成：{0}；原稿仍保留',slots:[0]},
  {source:'待运行状态尚未保存：{0}；当前草稿仍保留',slots:[0]},
  {source:'本地脚本存储暂不可用：{0}',slots:[0]},
  {source:'脚本尚未保存到浏览器：{0}',slots:[0]},
  {source:'实时更新失败：{0}；保留上次结果并自动重试',slots:[0]},
  {source:'无法创建独立执行环境：{0}',slots:[0]},
  {source:'杠杆配置：{0}',slots:[0]},
  {source:'新脚本未完成保存：{0}；新草稿仍保留，可在编辑器继续处理',slots:[0]},
  {source:'新脚本未完成保存：{0}',slots:[0]},
  {source:'触发 {0} 次入场调用，其中 {1} 笔被合约规则校验拒绝。{2}',slots:[2]},
  {source:'另有 {0} 笔被合约规则校验拒绝。{1}',slots:[1]},
  {source:'下单后预计持仓名义金额 {0} USDT 不符合官方档位的 {1} 倍杠杆限制{2}，订单未提交。',slots:[2]},
  {source:'首笔下单数量 {0}，按提交时价格 {1} 估算名义金额 {2} {3}{4}，当时账户权益 {5} {6}；请核对交易数量与资金设置。',slots:[4],captures:{3:'[A-Za-z][A-Za-z0-9_]*'}},
];
const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const patterns=causes.map(rule=>{
  const names:string[]=[],parts:string[]=[];let end=0;
  for(const match of rule.source.matchAll(/\{(\d+)\}/g)){parts.push(escape(rule.source.slice(end,match.index)));names.push(match[1]);parts.push('('+(rule.captures?.[match[1]]??'[\\s\\S]*?')+')');end=match.index!+match[0].length;}
  parts.push(escape(rule.source.slice(end)));return {...rule,names,pattern:new RegExp('^'+parts.join('')+'$')};
});

/** Display-only localization for platform diagnostics and error chains. It is
 * deliberately separate from translate(): user-supplied interpolation values
 * in ordinary UI messages must never be recursively translated. */
export function translateError(error:unknown,language:Locale=getLocale()):string {
  const message=error instanceof Error?error.message:error===undefined||error===null?'':String(error);
  if(language==='zh-CN')return message;
  return localize(message,language,0);
}
function localize(message:string,language:Locale,depth:number):string {
  if(depth>8)return message;
  const prefix=/^((?:Error|TypeError|RangeError|AbortError|TimeoutError):\s*)([\s\S]+)$/.exec(message);
  if(prefix)return prefix[1]+localize(prefix[2],language,depth+1);
  if(Object.hasOwn(englishMessages,message))return translate(message,undefined,language);
  for(const rule of patterns){
    const match=rule.pattern.exec(message);if(!match)continue;
    const values:Record<string,string>={};rule.names.forEach((name,i)=>values[name]=rule.slots.includes(Number(name))?localize(match[i+1],language,depth+1):match[i+1]);
    return translate(rule.source,values,language);
  }
  // Persisted reports can concatenate independently generated diagnostic
  // sentences. Keep the Chinese terminator in each lookup: templates include
  // it, so dropping it before matching would leave every old sentence raw.
  const sentences=message.match(/[^。]+。|[^。]+$/g);
  if(sentences&&sentences.length>1)return sentences.map(sentence=>localize(sentence.trimStart(),language,depth+1)).join(' ');
  return translate(message,undefined,language);
}
