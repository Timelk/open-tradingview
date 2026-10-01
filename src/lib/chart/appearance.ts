/** Chart-only presentation preferences. Never part of market or study state. */
export interface ChartAppearance {
  version: 1;
  preset: 'terminal'|'dark'|'light'|'midnight'|'paper'|'custom';
  chartType: 'candles'|'hollow'|'bars'|'line';
  colorBy: 'open-close'|'previous-close';
  upColor: string; downColor: string;
  borderUpColor: string; borderDownColor: string;
  wickUpColor: string; wickDownColor: string;
  showBodies: boolean; showBorders: boolean; showWicks: boolean;
  /** Candle body corner radius in CSS px; clamped by body width so thin bars stay square. */
  candleRadius: number;
  lineColor: string; lineWidth: number; volumeOpacity: number;
  background: string; backgroundEnd: string; backgroundMode: 'solid'|'gradient'; overlayOpacity: number;
  grid: 'both'|'horizontal'|'vertical'|'none'; gridColor: string; gridOpacity: number; gridStyle: 'solid'|'dashed'|'dotted';
  textColor: string; scaleFontSize: number; separatorColor: string;
  crosshairColor: string; crosshairStyle: 'solid'|'dashed'|'dotted'; crosshairVisible: boolean;
  lastPriceLine: boolean; lastPriceLabel: boolean;
  watermark: boolean; watermarkColor: string; watermarkOpacity: number; watermarkText: string; watermarkFontSize: number;
}
export type AppearancePresetId = Exclude<ChartAppearance['preset'],'custom'>;
export const APPEARANCE_STORAGE_KEY='tvchart.chart-appearance.v1';
export const DEFAULT_APPEARANCE:Readonly<ChartAppearance>=Object.freeze({
  version:1,preset:'terminal',chartType:'candles',colorBy:'open-close',
  upColor:'#a8ba96',downColor:'#b06f73',borderUpColor:'#a8ba96',borderDownColor:'#b06f73',wickUpColor:'#a8ba96',wickDownColor:'#b06f73',
  showBodies:true,showBorders:true,showWicks:true,candleRadius:1.5,lineColor:'#7aa2e8',lineWidth:2,volumeOpacity:.42,
  background:'#1e1f24',backgroundEnd:'#23252b',backgroundMode:'solid',overlayOpacity:.8,grid:'both',gridColor:'#26282e',gridOpacity:.7,gridStyle:'solid',
  textColor:'#8d9099',scaleFontSize:11,separatorColor:'#2c2e35',crosshairColor:'#6c707a',crosshairStyle:'dashed',crosshairVisible:true,
  lastPriceLine:true,lastPriceLabel:true,watermark:false,watermarkColor:'#a4b3c6',watermarkOpacity:.1,watermarkText:'',watermarkFontSize:48,
});
export const APPEARANCE_PRESETS:readonly {id:AppearancePresetId;name:string;description:string}[]=[
  {id:'terminal',name:'终端灰',description:'低饱和 · 把注意力留给价格与流动性'},
  {id:'dark',name:'经典深色',description:'低亮度 · 熟悉的交易视图'},
  {id:'light',name:'清晰浅色',description:'高对比 · 适合明亮环境'},
  {id:'midnight',name:'午夜蓝',description:'冷色调 · 柔和层次'},
  {id:'paper',name:'暖纸色',description:'暖底色 · 红涨绿跌'},
];
export function appearancePreset(id:AppearancePresetId):ChartAppearance {
  const base={...DEFAULT_APPEARANCE,preset:id};
  if(id==='dark')return {...base,upColor:'#26a69a',downColor:'#ef5350',borderUpColor:'#26a69a',borderDownColor:'#ef5350',wickUpColor:'#26a69a',wickDownColor:'#ef5350',lineColor:'#72a7ef',volumeOpacity:.5,background:'#151718',backgroundEnd:'#1c242e',overlayOpacity:.78,gridColor:'#23272a',gridOpacity:1,textColor:'#8a9196',separatorColor:'#2e3336',crosshairColor:'#6a7378'};
  if(id==='light')return {...base,background:'#ffffff',backgroundEnd:'#f0f4fa',overlayOpacity:.82,gridColor:'#e9edf2',textColor:'#535d6c',separatorColor:'#d6dce5',crosshairColor:'#747d89',upColor:'#008577',borderUpColor:'#008577',wickUpColor:'#008577',downColor:'#d63d43',borderDownColor:'#d63d43',wickDownColor:'#d63d43',lineColor:'#2962cc',watermarkColor:'#69788d'};
  if(id==='midnight')return {...base,background:'#101827',backgroundEnd:'#1c2d43',backgroundMode:'gradient',overlayOpacity:.78,gridColor:'#273448',textColor:'#a2b3ca',separatorColor:'#31415a',crosshairColor:'#8ea4c1',upColor:'#3ecfb3',borderUpColor:'#3ecfb3',wickUpColor:'#3ecfb3',downColor:'#f18c9a',borderDownColor:'#f18c9a',wickDownColor:'#f18c9a',lineColor:'#89b4ff',watermarkColor:'#b5c8e2'};
  if(id==='paper')return {...base,background:'#f6f3ec',backgroundEnd:'#ede7da',overlayOpacity:.82,gridColor:'#e4dfd4',textColor:'#666053',separatorColor:'#d4cbbd',crosshairColor:'#817767',upColor:'#c44f46',borderUpColor:'#c44f46',wickUpColor:'#c44f46',downColor:'#347c68',borderDownColor:'#347c68',wickDownColor:'#347c68',lineColor:'#596a9d',watermarkColor:'#817767'};
  return base;
}
export function normalizeColor(value:unknown):string|undefined {
  if(typeof value!=='string')return;
  const s=value.trim();if(/^#[\da-f]{6}$/i.test(s))return s.toLowerCase();
  if(/^#[\da-f]{3}$/i.test(s))return '#'+[...s.slice(1)].map(c=>c+c).join('').toLowerCase();
}
const enums={preset:['terminal','dark','light','midnight','paper','custom'],chartType:['candles','hollow','bars','line'],colorBy:['open-close','previous-close'],backgroundMode:['solid','gradient'],grid:['both','horizontal','vertical','none'],gridStyle:['solid','dashed','dotted'],crosshairStyle:['solid','dashed','dotted']} as const;
const numeric={candleRadius:[0,4],lineWidth:[1,4],volumeOpacity:[0,1],overlayOpacity:[.35,.96],gridOpacity:[0,1],scaleFontSize:[10,16],watermarkOpacity:[0,.5],watermarkFontSize:[16,96]} as const;
/** Whitelist and bound every persisted field; malformed storage cannot reach GL. */
export function normalizeAppearance(value:unknown):ChartAppearance {
  if(!value||typeof value!=='object'||Array.isArray(value))return {...DEFAULT_APPEARANCE};
  const raw=value as Record<string,unknown>;
  if(raw.version!==undefined&&raw.version!==1)return {...DEFAULT_APPEARANCE};
  const result={...DEFAULT_APPEARANCE} as unknown as Record<string,unknown>;
  for(const [key,fallback] of Object.entries(DEFAULT_APPEARANCE)){
    const candidate=raw[key];
    if(key in enums){if((enums[key as keyof typeof enums] as readonly unknown[]).includes(candidate))result[key]=candidate;}
    else if(key in numeric){if(typeof candidate==='number'&&Number.isFinite(candidate)){const [min,max]=numeric[key as keyof typeof numeric];result[key]=Math.min(max,Math.max(min,candidate));}}
    else if(key==='watermarkText'){if(typeof candidate==='string')result[key]=candidate.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,64);}
    else if(typeof fallback==='boolean'){if(typeof candidate==='boolean')result[key]=candidate;}
    else if(typeof fallback==='string'){result[key]=normalizeColor(candidate)??fallback;}
  }
  return result as unknown as ChartAppearance;
}
export type AppearanceStorage=Pick<Storage,'getItem'|'setItem'>;
function browserStorage():AppearanceStorage|undefined {try{return typeof localStorage==='undefined'?undefined:localStorage;}catch{return undefined;}}
export function loadAppearance(storage=browserStorage()):ChartAppearance {
  try{return normalizeAppearance(JSON.parse(storage?.getItem(APPEARANCE_STORAGE_KEY)??'null'));}catch{return {...DEFAULT_APPEARANCE};}
}
export function saveAppearance(value:ChartAppearance,storage=browserStorage()):boolean {
  try{if(!storage)return false;storage.setItem(APPEARANCE_STORAGE_KEY,JSON.stringify(normalizeAppearance(value)));return true;}catch{return false;}
}
function parseHexRgb(hex:string):[number,number,number] {
  const clean=(normalizeColor(typeof hex==='string'&&hex.length>=7?hex.slice(0,7):hex)??'#151718').slice(1);
  return [parseInt(clean.slice(0,2),16),parseInt(clean.slice(2,4),16),parseInt(clean.slice(4,6),16)];
}
function formatHexRgb(r:number,g:number,b:number):string {
  return '#'+[r,g,b].map(v=>Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0')).join('');
}
export function mixColors(hexA:string,hexB:string,weightB:number):string {
  const [r1,g1,b1]=parseHexRgb(hexA),[r2,g2,b2]=parseHexRgb(hexB),t=Math.max(0,Math.min(1,weightB));
  return formatHexRgb(r1+(r2-r1)*t,g1+(g2-g1)*t,b1+(b2-b1)*t);
}
export function relativeLuminance(hex:string):number {
  const rgb=parseHexRgb(hex).map(c=>{const n=c/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});
  return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
}
export function contrastRatio(hexA:string,hexB:string):number {
  const l1=relativeLuminance(hexA),l2=relativeLuminance(hexB);
  return (Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
}
export function contrastText(hex:string):string {
  return relativeLuminance(hex)>.179?'#121820':'#ffffff';
}
const readableColorCache=new Map<string,string>();
/** Hue-preserving contrast adapter: keeps chromatic identity while guaranteeing WCAG contrast >= minRatio against surfaceHex.
 * Cache the complete normalized palette key; theme, style, and threshold
 * changes stay independent without repeating the luminance search per glyph. */
export function readableSurfaceColor(fgHex:string|undefined,surfaceHex:string,minRatio=4.6):string {
  const baseFg=normalizeColor(typeof fgHex==='string'&&fgHex.length>=7?fgHex.slice(0,7):fgHex)??'#72a7ef';
  const baseSurface=normalizeColor(typeof surfaceHex==='string'&&surfaceHex.length>=7?surfaceHex.slice(0,7):surfaceHex)??'#151718';
  const key=`${baseFg}:${baseSurface}:${minRatio}`,cached=readableColorCache.get(key);
  if(cached!==undefined)return cached;
  let best=baseFg;
  if(!(contrastRatio(baseFg,baseSurface)>=minRatio)){
    const anchor=relativeLuminance(baseSurface)>.179?'#10161f':'#f5f9ff';
    let lo=0,hi=1;best=anchor;
    for(let i=0;i<12;i++){
      const mid=(lo+hi)/2;
      const candidate=mixColors(baseFg,anchor,mid);
      if(contrastRatio(candidate,baseSurface)>=minRatio){best=candidate;hi=mid;}
      else lo=mid;
    }
  }
  if(readableColorCache.size>=4096)readableColorCache.clear();
  readableColorCache.set(key,best);
  return best;
}
export function colorWithOpacity(color:string,opacity:number):string {
  const clean=normalizeColor(typeof color==='string'&&color.length>=7?color.slice(0,7):color)??color;
  return `${clean}${Math.round(Math.max(0,Math.min(1,opacity))*255).toString(16).padStart(2,'0')}`;
}
export interface ChartOverlaySurface {
  isLight:boolean;
  surfaceSolid:string;
  glassBg:string;
  glassBgHover:string;
  glassMenuBg:string;
  glassBorder:string;
  glassBorderStrong:string;
  glassText:string;
  glassTextMuted:string;
  glassBadgeBg:string;
  glassShadow:string;
  canvasLabelBg:string;
  canvasLabelText:string;
  canvasLabelMuted:string;
}
export function deriveOverlaySurface(appearance:Pick<ChartAppearance,'background'|'backgroundEnd'|'backgroundMode'|'overlayOpacity'|'textColor'|'separatorColor'>):ChartOverlaySurface {
  const rawBg=appearance.backgroundMode==='gradient'?mixColors(appearance.background,appearance.backgroundEnd,.35):appearance.background;
  const isLight=relativeLuminance(rawBg)>.179;
  const surfaceSolid=isLight?mixColors(rawBg,'#ffffff',.34):mixColors(rawBg,'#1b222c',.28);
  const [sr,sg,sb]=parseHexRgb(surfaceSolid);
  const alpha=Math.min(.96,Math.max(.35,Number.isFinite(appearance.overlayOpacity)?appearance.overlayOpacity:.78));
  const hoverAlpha=Math.min(.97,alpha+.12);
  const menuAlpha=Math.max(.93,alpha+.15);
  const glassText=isLight?readableSurfaceColor('#151c26',surfaceSolid,11):readableSurfaceColor('#eef4fb',surfaceSolid,11);
  const glassTextMuted=readableSurfaceColor(appearance.textColor,surfaceSolid,5.2);
  return {
    isLight,
    surfaceSolid,
    glassBg:`rgba(${sr}, ${sg}, ${sb}, ${alpha.toFixed(2)})`,
    glassBgHover:`rgba(${sr}, ${sg}, ${sb}, ${hoverAlpha.toFixed(2)})`,
    glassMenuBg:`rgba(${sr}, ${sg}, ${sb}, ${menuAlpha.toFixed(2)})`,
    glassBorder:isLight?'rgba(18, 25, 35, 0.14)':'rgba(226, 238, 255, 0.13)',
    glassBorderStrong:isLight?'rgba(18, 25, 35, 0.28)':'rgba(226, 238, 255, 0.26)',
    glassText,
    glassTextMuted,
    glassBadgeBg:isLight?'rgba(18, 25, 35, 0.07)':'rgba(235, 244, 255, 0.09)',
    glassShadow:isLight
      ?'0 8px 24px rgba(18, 24, 32, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.68)'
      :'0 8px 24px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
    canvasLabelBg:colorWithOpacity(surfaceSolid,Math.min(.94,alpha+.08)),
    canvasLabelText:glassText,
    canvasLabelMuted:glassTextMuted,
  };
}
