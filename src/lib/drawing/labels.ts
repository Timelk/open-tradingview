import { DEFAULT_STYLE, MAX_DRAWING_FONT_SIZE, MIN_DRAWING_FONT_SIZE, type Drawing } from './types';

export const LABEL_BACKGROUND = '#171d27';
export function validDrawingFontSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_DRAWING_FONT_SIZE && value <= MAX_DRAWING_FONT_SIZE;
}
/** Keep labels at a readable screen size while world-space geometry zooms.
 * Legacy text annotations used props.fontSize; an explicit common style wins. */
export function drawingFontSize(drawing: Drawing, primitiveSize?: number): number {
  const legacy = drawing.toolId === 'text' ? Number(drawing.props.fontSize) : NaN;
  const value = drawing.style.fontSize ?? (Number.isFinite(legacy) ? legacy : primitiveSize ?? DEFAULT_STYLE.fontSize!);
  return Math.max(MIN_DRAWING_FONT_SIZE, Math.min(MAX_DRAWING_FONT_SIZE, Number.isFinite(value) ? value : DEFAULT_STYLE.fontSize!));
}
/** Conservative line box, shared by placement and the Canvas background. */
export const labelHeight = (size: number): number => Math.ceil(size * 1.3) + 8;
export function estimateLabelWidth(text: string, size: number): number {
  return [...text].reduce((sum,char) => sum + (char.codePointAt(0)! > 255 ? 1 : .62), 0) * size;
}
const readable = new Map<string,string>();
const luminance = (rgb:number[]) => rgb.map(v => v/255 <= .04045 ? v/255/12.92 : ((v/255+.055)/1.055)**2.4)
  .reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
const backgroundLuminance = luminance([23,29,39]);
/** Preserve the label hue, lifting dark user/level colors to 4.5:1 contrast. */
export function readableLabelColor(color: string): string {
  const cached = readable.get(color); if (cached) return cached;
  let result = '#e3ebf7';
  if (/^#[\da-f]{6}$/i.test(color)) {
    const rgb=[1,3,5].map(index=>parseInt(color.slice(index,index+2),16));
    for(let mix=0;mix<=1.001;mix+=.04){
      const candidate=rgb.map(value=>Math.round(value+(255-value)*mix));
      if((luminance(candidate)+.05)/(backgroundLuminance+.05)>=4.5){result='#'+candidate.map(value=>value.toString(16).padStart(2,'0')).join('');break;}
    }
  }
  if(readable.size>=256)readable.clear();readable.set(color,result);return result;
}
