import {derived,writable} from 'svelte/store';
import {messages as core} from './messages-core';
import {messages as shell} from './messages-shell';
import {messages as library} from './messages-library';
import {messages as workspace} from './messages-workspace';
import {messages as analysis} from './messages-analysis';
import {messages as chart} from './messages-chart';
import {analysisPresentationMessages} from './messages-analysis-presentation';
import {analysisGuideMessages} from './messages-analysis-guide';
import {flowGuideMessages} from './messages-flow-guide';
import {appearanceMessages} from './messages-appearance';
import {tradingWorkspaceMessages} from './messages-trading-workspace';
import {orderBookMessages} from './messages-orderbook';
import {huziExtraMessages} from './messages-huzi-extra';
import {agentBridgeMessages} from './messages-agent';

export type Locale='zh-CN'|'en-US';
export type MessageParams=Record<string,unknown>;
export const LOCALE_STORAGE_KEY='tvchart.locale.v1';
export const SUPPORTED_LOCALES:readonly Locale[]=['zh-CN','en-US'];
export function normalizeLocale(value:unknown):Locale|undefined {
  if(typeof value!=='string')return;
  if(/^zh(?:-|$)/i.test(value))return 'zh-CN';
  if(/^en(?:-|$)/i.test(value))return 'en-US';
}
function storedLocale():Locale {
  try{return normalizeLocale(typeof localStorage!=='undefined'?localStorage.getItem(LOCALE_STORAGE_KEY):undefined)??'zh-CN';}catch{return 'zh-CN';}
}
export const locale=writable<Locale>(storedLocale());
let activeLocale:Locale=storedLocale();
locale.subscribe(value=>activeLocale=value);
export const getLocale=():Locale=>activeLocale;
export const englishMessages:Readonly<Record<string,string>>=Object.freeze({...workspace,...analysis,...chart,...shell,...library,...core,...analysisPresentationMessages,...analysisGuideMessages,...flowGuideMessages,...appearanceMessages,...tradingWorkspaceMessages,...orderBookMessages,...huziExtraMessages,...agentBridgeMessages});
const han=/[\u3400-\u9fff]/;
const cache=new Map<string,string>();
const fill=(message:string,params:MessageParams={})=>message.replace(/\{([\w.-]+)\}/g,(original,key)=>Object.hasOwn(params,key)?String(params[key]??''):original);
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
interface Template {pattern:RegExp;names:string[];target:string;weight:number;anchor:string}
const templates:Template[]=Object.entries(englishMessages).flatMap(([source,target])=>{
  if(!han.test(source)||!source.includes('{'))return [];
  const names:string[]=[],parts:string[]=[];let end=0,literal='';const anchors:string[]=[];
  for(const match of source.matchAll(/\{([\w.-]+)\}/g)){
    const chunk=source.slice(end,match.index);literal+=chunk;anchors.push(...(chunk.match(/[\u3400-\u9fff]+/g)??[]));parts.push(escape(chunk));
    names.push(match[1]);parts.push('([\\s\\S]*?)');end=match.index!+match[0].length;
  }
  if(!names.length)return [];const tail=source.slice(end);literal+=tail;anchors.push(...(tail.match(/[\u3400-\u9fff]+/g)??[]));parts.push(escape(tail));
  const anchor=anchors.sort((a,b)=>b.length-a.length)[0];
  if(!anchor)return [];
  return [{pattern:new RegExp('^'+parts.join('')+'$'),names,target,weight:literal.length,anchor}];
}).sort((a,b)=>b.weight-a.weight);

/** Translate owned presentation messages only. Explicit interpolation values
 * are opaque: names, source code and user-authored text are never translated.
 * Canonical worker/server messages retain their stable language internally;
 * template matching localizes only the final display, without changing IDs. */
const zhDisplayAliases:Readonly<Record<string,string>>={'胡子形态':'经典形态'};
function translateMessage(message:unknown,params:MessageParams|undefined,language:Locale,nested=false,depth=0):string {
  const source=message===null||message===undefined?'':String(message);
  if(language==='zh-CN')return fill(zhDisplayAliases[source]??source,params);
  const exact=englishMessages[source];if(exact!==undefined)return fill(exact,params);
  if(params)return fill(source,params);
  if(!han.test(source))return source;
  const cacheKey=(nested?'owned:':'ui:')+source;const cached=cache.get(cacheKey);if(cached!==undefined)return cached;
  let result=source;
  const trimmed=source.trim();
  if(trimmed!==source&&englishMessages[trimmed]!==undefined)result=source.slice(0,source.indexOf(trimmed))+englishMessages[trimmed]+source.slice(source.indexOf(trimmed)+trimmed.length);
  else {
    for(const template of templates){
      if(!source.includes(template.anchor))continue;
      const match=template.pattern.exec(source);if(!match)continue;
      const values:MessageParams={},rawValues:MessageParams={};let repeated=true;
      template.names.forEach((name,index)=>{if(Object.hasOwn(rawValues,name)&&rawValues[name]!==match[index+1])repeated=false;rawValues[name]=match[index+1];values[name]=nested&&depth<8&&match[index+1].length<source.length?translateMessage(match[index+1],undefined,language,true,depth+1):match[index+1];});
      if(!repeated)continue;result=fill(template.target,values);break;
    }
    if(result===source){
      const error=/^((?:Error|TypeError|RangeError|AbortError):\s*)([\s\S]+)$/.exec(source);
      if(error)result=error[1]+translateMessage(error[2],undefined,language,nested,depth+1);
      else if(nested&&source.includes(' · '))result=source.split(' · ').map(part=>translateMessage(part,undefined,language,true,depth+1)).join(' · ');
      else if(/[\n。]/.test(source)){
        let changed=false;const parts=source.split(/(\n|。)/).map(part=>{if(part==='。'||part==='\n')return part;const translated=translateMessage(part,undefined,language,nested,depth+1);changed ||= translated!==part;return translated;});
        if(changed)result=parts.map(part=>part==='。'?'. ':part).join('').trimEnd();
      }
    }
  }
  if(cache.size>=8000)cache.delete(cache.keys().next().value!);cache.set(cacheKey,result);return result;
}
export function translate(message:unknown,params?:MessageParams,language:Locale=getLocale()):string{return translateMessage(message,params,language);}
/** Only for canonical platform-generated analysis text; never user content. */
export function translateCanonical(message:unknown,params?:MessageParams,language:Locale=getLocale()):string{return translateMessage(message,params,language,true);}
export const canonicalT=derived(locale,language=>(message:unknown,params?:MessageParams)=>translateCanonical(message,params,language));
export {translateError} from './errors';
export const t=derived(locale,language=>(message:unknown,params?:MessageParams)=>translate(message,params,language));
export function setLocale(value:unknown):void {
  const next=normalizeLocale(value);if(!next)return;
  locale.set(next);
  try{localStorage.setItem(LOCALE_STORAGE_KEY,next);}catch{ /* In-memory switching remains usable. */ }
}
/** Installed once, outside the component tree. Locale changes never remount
 * the chart, reset a market, or start a calculation. */
export function initializeI18n():()=>void {
  if(typeof document==='undefined')return ()=>{};
  const unsubscribe=locale.subscribe(value=>{document.documentElement.lang=value;document.documentElement.dir='ltr';});
  const changed=(event:StorageEvent)=>{if(event.key===LOCALE_STORAGE_KEY||event.key===null)locale.set(normalizeLocale(event.newValue)??storedLocale());};
  window.addEventListener('storage',changed);
  return()=>{unsubscribe();window.removeEventListener('storage',changed);};
}
const numbers=new Map<string,Intl.NumberFormat>(),dates=new Map<string,Intl.DateTimeFormat>();
export function formatNumber(value:number,options:Intl.NumberFormatOptions={},language:Locale=getLocale()):string {
  if(!Number.isFinite(value))return '—';const key=language+JSON.stringify(options);
  let formatter=numbers.get(key);if(!formatter){formatter=new Intl.NumberFormat(language,options);numbers.set(key,formatter);}return formatter.format(value);
}
export function formatDate(value:number|Date,options:Intl.DateTimeFormatOptions={},language:Locale=getLocale()):string {
  if(!Number.isFinite(Number(value)))return '—';const key=language+JSON.stringify(options);
  let formatter=dates.get(key);if(!formatter){formatter=new Intl.DateTimeFormat(language,options);dates.set(key,formatter);}return formatter.format(value);
}
