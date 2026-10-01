import {mixColors,readableSurfaceColor,relativeLuminance,type ChartAppearance} from '../chart/appearance';

/**
 * Application-wide UI theme. The chart appearance preset is the single theme
 * switch: picking a preset re-skins the chart AND every panel, rail, dialog
 * and menu. Built-in presets carry hand-tuned palettes; a custom chart palette
 * derives its chrome from the chart background so the two never clash.
 */
export interface UiTheme {
  id:string;
  tone:'dark'|'light';
  /** Page base behind panels. */ bg:string;
  /** Toolbars, rails and docked panels. */ panel:string;
  /** Popovers, menus, dialogs and cards. */ raised:string;
  /** Inputs and inset wells. */ sunken:string;
  hover:string;active:string;
  line:string;lineStrong:string;
  textStrong:string;text:string;textDim:string;textMuted:string;
  accent:string;accentStrong:string;onAccent:string;
  up:string;down:string;warn:string;
  focus:string;
  /** Alpha overlays are drawn with this ink (white on dark, near-black on light). */ ink:string;
  /** Multiplier for black drop shadows; light themes need far softer shadows. */ shadowStrength:number;
  scrim:string;
}

type Palette=Omit<UiTheme,'id'|'up'|'down'>;

const GRAPHITE:Palette={
  tone:'dark',bg:'#0f1012',panel:'#16171a',raised:'#1e1f23',sunken:'#111214',
  hover:'rgba(255,255,255,0.055)',active:'rgba(255,255,255,0.095)',
  line:'rgba(255,255,255,0.075)',lineStrong:'rgba(255,255,255,0.13)',
  textStrong:'#f4f5f7',text:'#dadce2',textDim:'#9a9ea8',textMuted:'#6c707a',
  accent:'#7fa7ff',accentStrong:'#a9c4ff',onAccent:'#0b1122',warn:'#e0b261',focus:'#8fb3ff',
  ink:'#ffffff',shadowStrength:1,scrim:'rgba(5,6,8,0.62)',
};
const PALETTES:Record<string,Palette>={
  terminal:GRAPHITE,
  dark:{...GRAPHITE,bg:'#0b0c0d',panel:'#121415',raised:'#1a1d1f',sunken:'#0d0f10',
    textStrong:'#f2f5f7',text:'#d6dbde',textDim:'#90979c',textMuted:'#646b70',accent:'#5e9eff',accentStrong:'#94bdff',onAccent:'#06101f',focus:'#7fb1ff'},
  midnight:{...GRAPHITE,bg:'#0a111f',panel:'#0e1728',raised:'#152238',sunken:'#0b1322',
    hover:'rgba(168,196,245,0.07)',active:'rgba(168,196,245,0.125)',line:'rgba(150,180,230,0.12)',lineStrong:'rgba(150,180,230,0.2)',
    textStrong:'#eef4ff',text:'#d3def0',textDim:'#8fa4c3',textMuted:'#61779a',accent:'#8db7ff',accentStrong:'#b8d1ff',onAccent:'#081326',warn:'#e8bd6a',focus:'#9cc0ff',
    ink:'#dde9ff',scrim:'rgba(3,7,16,0.62)'},
  light:{tone:'light',bg:'#eef0f3',panel:'#fbfbfc',raised:'#ffffff',sunken:'#f3f4f6',
    hover:'rgba(16,24,40,0.045)',active:'rgba(16,24,40,0.085)',line:'rgba(16,24,40,0.095)',lineStrong:'rgba(16,24,40,0.17)',
    textStrong:'#0d1117',text:'#252b34',textDim:'#5b636f',textMuted:'#89909a',accent:'#2563eb',accentStrong:'#1d4ed8',onAccent:'#ffffff',warn:'#b26b00',focus:'#2563eb',
    ink:'#101828',shadowStrength:.38,scrim:'rgba(15,20,30,0.34)'},
  paper:{tone:'light',bg:'#e9e3d7',panel:'#f4f0e7',raised:'#fcfaf6',sunken:'#f0ebe1',
    hover:'rgba(64,48,22,0.05)',active:'rgba(64,48,22,0.095)',line:'rgba(64,48,22,0.12)',lineStrong:'rgba(64,48,22,0.2)',
    textStrong:'#221e17',text:'#3a342b',textDim:'#6b6356',textMuted:'#958c7c',accent:'#4d5d99',accentStrong:'#3b4a82',onAccent:'#ffffff',warn:'#9c6212',focus:'#4d5d99',
    ink:'#2a2217',shadowStrength:.42,scrim:'rgba(40,30,15,0.3)'},
};

const background=(a:Pick<ChartAppearance,'background'|'backgroundEnd'|'backgroundMode'>)=>a.backgroundMode==='gradient'?mixColors(a.background,a.backgroundEnd,.35):a.background;

/** Chrome for an arbitrary (custom) chart palette: layers step away from the chart surface. */
function derivedPalette(a:ChartAppearance):Palette {
  const base=background(a),light=relativeLuminance(base)>.179;
  if(light){
    const panel=mixColors(base,'#ffffff',.55);
    return {...PALETTES.light,bg:mixColors(base,'#0b1220',.07),panel,raised:mixColors(base,'#ffffff',.85),sunken:mixColors(base,'#0b1220',.035),
      textDim:readableSurfaceColor(a.textColor,panel,4.6),accent:readableSurfaceColor(a.lineColor,panel,4.5),accentStrong:readableSurfaceColor(a.lineColor,panel,6.5),
      focus:readableSurfaceColor(a.lineColor,panel,3.2)};
  }
  const panel=mixColors(base,'#000000',.22);
  return {...GRAPHITE,bg:mixColors(base,'#000000',.42),panel,raised:mixColors(base,'#ffffff',.035),sunken:mixColors(base,'#000000',.34),
    textDim:readableSurfaceColor(a.textColor,panel,5),accent:readableSurfaceColor(a.lineColor,panel,4.5),accentStrong:readableSurfaceColor(a.lineColor,panel,8),
    focus:readableSurfaceColor(a.lineColor,panel,3.2)};
}

/** Inks for canvas chrome that must sit on either tone (handles, snap guides). */
export interface CanvasInk {handleFill:string;selected:string;guide:string;guideStrong:string;chipBg:string;chipText:string}
const DARK_INK:CanvasInk={handleFill:'#151718',selected:'#b7d2ff',guide:'#6f96c2',guideStrong:'#8fc3ff',chipBg:'#1e354e',chipText:'#b8daff'};
const LIGHT_INK:CanvasInk={handleFill:'#ffffff',selected:'#2563eb',guide:'#8aa5d8',guideStrong:'#2563eb',chipBg:'#e6eefc',chipText:'#1d3f8f'};
export const canvasInkFor=(a:ChartAppearance):CanvasInk=>uiThemeFor(a).tone==='light'?LIGHT_INK:DARK_INK;
export const DEFAULT_CANVAS_INK=DARK_INK;

export function uiThemeFor(a:ChartAppearance):UiTheme {
  const palette=a.preset!=='custom'&&PALETTES[a.preset]?PALETTES[a.preset]:derivedPalette(a);
  // Market colors follow the chart (paper is red-up), made legible on panels.
  return {id:a.preset,...palette,up:readableSurfaceColor(a.upColor,palette.panel,4.5),down:readableSurfaceColor(a.downColor,palette.panel,4.5)};
}

const chevron=(color:string)=>`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6' fill='none'%3E%3Cpath d='M1.5 1.25L5 4.75L8.5 1.25' stroke='${encodeURIComponent(color)}' stroke-width='1.35' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;

/** CSS custom properties for a theme. Derived tints live in app.css. */
export function uiThemeVariables(t:UiTheme):Record<string,string> {
  return {
    '--bg':t.bg,'--bg-panel':t.panel,'--surface-raised':t.raised,'--surface-sunken':t.sunken,
    '--bg-hover':t.hover,'--bg-active':t.active,'--line':t.line,'--line-strong':t.lineStrong,
    '--text-strong':t.textStrong,'--text':t.text,'--text-dim':t.textDim,'--text-muted':t.textMuted,
    '--accent':t.accent,'--accent-strong':t.accentStrong,'--on-accent':t.onAccent,
    '--up':t.up,'--down':t.down,'--warn':t.warn,'--focus':t.focus,
    '--ink':t.ink,'--shadow-strength':String(t.shadowStrength),'--scrim':t.scrim,
    '--select-chevron':chevron(t.textDim),
  };
}

/** Apply globally. Safe to call repeatedly; only changed values are written. */
export function applyUiTheme(a:ChartAppearance,root:HTMLElement|undefined=typeof document==='undefined'?undefined:document.documentElement):UiTheme {
  const theme=uiThemeFor(a);
  if(!root)return theme;
  for(const [key,value] of Object.entries(uiThemeVariables(theme)))if(root.style.getPropertyValue(key)!==value)root.style.setProperty(key,value);
  root.dataset.theme=theme.id;root.dataset.tone=theme.tone;root.style.colorScheme=theme.tone;
  return theme;
}
