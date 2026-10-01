import {describe,expect,it} from 'vitest';
import {readdirSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {APPEARANCE_PRESETS,DEFAULT_APPEARANCE,appearancePreset,contrastRatio,normalizeAppearance,type ChartAppearance} from '../src/lib/chart/appearance';
import {applyUiTheme,canvasInkFor,uiThemeFor,uiThemeVariables} from '../src/lib/ui/theme';
import {candleCornerRadius,paintPriceBar,type PricePainter} from '../src/lib/render/price-series';
import {roundedOutline} from '../src/lib/render/gl';
import {icons} from '../src/lib/ui/icons/catalog';

const hex=/^#[\da-f]{6}$/i;
const fakeRoot=()=>{
  const style=new Map<string,string>(),root={dataset:{} as Record<string,string>,style:{colorScheme:'',getPropertyValue:(k:string)=>style.get(k)??'',setProperty:(k:string,v:string)=>{style.set(k,v);}}};
  return {root:root as unknown as HTMLElement,style};
};

describe('workspace UI theme',()=>{
  it.each(APPEARANCE_PRESETS.map(p=>p.id))('gives the %s preset readable text on its panel and a distinct layer stack',id=>{
    const a=appearancePreset(id),theme=uiThemeFor(a);
    expect(theme.id).toBe(id);
    for(const [name,value] of Object.entries({strong:theme.textStrong,text:theme.text,dim:theme.textDim,accent:theme.accent,up:theme.up,down:theme.down})){
      expect(value,name).toMatch(hex);
    }
    expect(contrastRatio(theme.textStrong,theme.panel)).toBeGreaterThanOrEqual(10);
    expect(contrastRatio(theme.text,theme.panel)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(theme.textDim,theme.panel)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.accent,theme.panel)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(theme.up,theme.panel)).toBeGreaterThanOrEqual(3);expect(contrastRatio(theme.down,theme.panel)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(theme.onAccent,theme.accent)).toBeGreaterThanOrEqual(4.5);
    // Page < panel < raised in lightness on dark themes, the reverse on light ones.
    const l=(c:string)=>contrastRatio(c,'#000000');
    if(theme.tone==='dark'){expect(l(theme.bg)).toBeLessThan(l(theme.panel));expect(l(theme.panel)).toBeLessThan(l(theme.raised));}
    else{expect(l(theme.bg)).toBeLessThan(l(theme.panel));expect(l(theme.panel)).toBeLessThanOrEqual(l(theme.raised));}
  });

  it('tracks tone: graphite, classic and midnight are dark; light and paper are light',()=>{
    expect(Object.fromEntries(APPEARANCE_PRESETS.map(p=>[p.id,uiThemeFor(appearancePreset(p.id)).tone]))).toEqual({terminal:'dark',dark:'dark',light:'light',midnight:'dark',paper:'light'});
    expect(uiThemeFor(appearancePreset('light')).shadowStrength).toBeLessThan(uiThemeFor(appearancePreset('terminal')).shadowStrength);
  });

  it('derives chrome from a custom chart palette instead of clashing with it',()=>{
    const custom=(background:string,text:string):ChartAppearance=>({...DEFAULT_APPEARANCE,preset:'custom',background,backgroundEnd:background,textColor:text});
    const dark=uiThemeFor(custom('#0d2b22','#8fb3a5')),light=uiThemeFor(custom('#f4efe1','#5b5648'));
    expect(dark.tone).toBe('dark');expect(light.tone).toBe('light');
    expect(contrastRatio(dark.textDim,dark.panel)).toBeGreaterThanOrEqual(4.5);expect(contrastRatio(light.textDim,light.panel)).toBeGreaterThanOrEqual(4.5);
    expect(dark.panel).not.toBe(light.panel);
  });

  it('writes every token, the tone hooks and a tone-matched select chevron to :root once',()=>{
    const {root,style}=fakeRoot();
    const dark=applyUiTheme(appearancePreset('terminal'),root);
    expect(root.dataset.theme).toBe('terminal');expect(root.dataset.tone).toBe('dark');expect(root.style.colorScheme).toBe('dark');
    for(const key of ['--bg','--bg-panel','--surface-raised','--surface-sunken','--bg-hover','--bg-active','--line','--line-strong','--text-strong','--text','--text-dim','--text-muted','--accent','--accent-strong','--on-accent','--up','--down','--warn','--focus','--ink','--shadow-strength','--scrim','--select-chevron'])expect(style.has(key),key).toBe(true);
    expect(style.get('--bg-panel')).toBe(dark.panel);
    const darkChevron=style.get('--select-chevron');
    applyUiTheme(appearancePreset('light'),root);
    expect(root.dataset.tone).toBe('light');expect(root.style.colorScheme).toBe('light');expect(style.get('--ink')).toBe(uiThemeFor(appearancePreset('light')).ink);
    expect(style.get('--select-chevron')).not.toBe(darkChevron);
    expect(Object.keys(uiThemeVariables(dark)).every(k=>k.startsWith('--'))).toBe(true);
  });

  it('is a no-op without a document (SSR / worker)',()=>{
    expect(applyUiTheme(appearancePreset('light'),undefined).tone).toBe('light');
  });

  it('gives canvas chrome (handles, snap guides) an ink for each tone',()=>{
    const dark=canvasInkFor(appearancePreset('terminal')),light=canvasInkFor(appearancePreset('light'));
    expect(dark.handleFill).not.toBe(light.handleFill);
    expect(contrastRatio(light.selected,'#ffffff')).toBeGreaterThanOrEqual(3);expect(contrastRatio(dark.selected,'#151718')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.chipText,light.chipBg)).toBeGreaterThanOrEqual(4.5);expect(contrastRatio(dark.chipText,dark.chipBg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('candle corner radius',()=>{
  const style=(candleRadius:number,extra:Partial<ChartAppearance>={}):ChartAppearance=>({...DEFAULT_APPEARANCE,candleRadius,...extra});
  const recorder=(rounded:boolean)=>{
    const calls:string[]=[],painter:PricePainter={rect:()=>{calls.push('rect');},seg:()=>{calls.push('seg');}};
    if(rounded){painter.roundRect=(...args)=>{calls.push(`round:${args[4].toFixed(2)}`);};painter.roundRing=(...args)=>{calls.push(`ring:${args[4].toFixed(2)}`);};}
    return {calls,painter};
  };
  const y=(v:number)=>200-v,up={open:100,high:112,low:96,close:108},down={open:108,high:112,low:96,close:100};

  it('defaults to a subtle 1.5px radius and clamps persisted values to 0–4px',()=>{
    expect(DEFAULT_APPEARANCE.candleRadius).toBe(1.5);
    expect(normalizeAppearance({...DEFAULT_APPEARANCE,candleRadius:99}).candleRadius).toBe(4);
    expect(normalizeAppearance({...DEFAULT_APPEARANCE,candleRadius:-3}).candleRadius).toBe(0);
    expect(normalizeAppearance({...DEFAULT_APPEARANCE,candleRadius:'x'}).candleRadius).toBe(1.5);
    expect(normalizeAppearance({version:1,preset:'light'}).candleRadius).toBe(1.5);// saved before the field existed
  });

  it('never rounds more than 35% of the body width or half its height, and drops sub-half-pixel radii',()=>{
    expect(candleCornerRadius({candleRadius:4},20,40)).toBe(4);
    expect(candleCornerRadius({candleRadius:4},6,40)).toBeCloseTo(2.1);
    expect(candleCornerRadius({candleRadius:4},20,3)).toBe(1.5);
    expect(candleCornerRadius({candleRadius:4},1,40)).toBe(0);
    expect(candleCornerRadius({candleRadius:0},20,40)).toBe(0);
  });

  it('paints one rounded silhouette for filled candles, with an inner fill only when the border differs',()=>{
    const same=recorder(true);paintPriceBar(same.painter,up,undefined,50,6,y,style(2));
    expect(same.calls).toEqual(['seg','seg','round:2.00']);
    const bordered=recorder(true);paintPriceBar(bordered.painter,up,undefined,50,6,y,style(2,{borderUpColor:'#ffffff'}));
    expect(bordered.calls.filter(c=>c.startsWith('round')).length).toBe(2);
    const noBorder=recorder(true);paintPriceBar(noBorder.painter,up,undefined,50,6,y,style(2,{borderUpColor:'#ffffff',showBorders:false}));
    expect(noBorder.calls.filter(c=>c.startsWith('round')).length).toBe(1);
  });

  it('draws hollow up-candles as a rounded ring and keeps square rects for radius 0 or painters without rounding',()=>{
    const ring=recorder(true);paintPriceBar(ring.painter,up,undefined,50,6,y,style(2,{chartType:'hollow'}));
    expect(ring.calls.some(c=>c.startsWith('ring'))).toBe(true);expect(ring.calls.some(c=>c==='rect')).toBe(false);
    const square=recorder(true);paintPriceBar(square.painter,down,undefined,50,6,y,style(0));
    expect(square.calls.some(c=>c.startsWith('round'))).toBe(false);expect(square.calls.filter(c=>c==='rect').length).toBeGreaterThan(0);
    const legacy=recorder(false);paintPriceBar(legacy.painter,down,undefined,50,6,y,style(3));
    expect(legacy.calls.some(c=>c.startsWith('round')||c.startsWith('ring'))).toBe(false);
  });
});

describe('rounded outline geometry (GL triangle fans)',()=>{
  it('emits segments+1 points per corner, all inside the rectangle and on the corner arcs',()=>{
    for(const [radius,segments] of [[1,1],[2,2],[4,3],[8,4]] as const){
      const points=roundedOutline(10,20,50,60,radius),count=points.length/2;
      expect(count).toBe(4*(segments+1));
      for(let i=0;i<count;i++){const x=points[i*2],y=points[i*2+1];
        expect(x).toBeGreaterThanOrEqual(10-1e-9);expect(x).toBeLessThanOrEqual(50+1e-9);expect(y).toBeGreaterThanOrEqual(20-1e-9);expect(y).toBeLessThanOrEqual(60+1e-9);}
      // The four extreme edge points touch the rectangle's straight edges.
      const xs=[...points].filter((_,i)=>i%2===0),ys=[...points].filter((_,i)=>i%2===1);
      expect(Math.min(...xs)).toBeCloseTo(10);expect(Math.max(...xs)).toBeCloseTo(50);expect(Math.min(...ys)).toBeCloseTo(20);expect(Math.max(...ys)).toBeCloseTo(60);
    }
  });
  it('winds clockwise and stays convex so a centre fan covers it without overlap',()=>{
    const points=roundedOutline(0,0,40,30,5),n=points.length/2;let area=0,turnSign=0;
    for(let i=0;i<n;i++){
      const [x1,y1]=[points[i*2],points[i*2+1]],j=(i+1)%n,k=(i+2)%n,[x2,y2]=[points[j*2],points[j*2+1]],[x3,y3]=[points[k*2],points[k*2+1]];
      area+=x1*y2-x2*y1;const cross=(x2-x1)*(y3-y2)-(y2-y1)*(x3-x2);
      if(Math.abs(cross)>1e-9){if(turnSign===0)turnSign=Math.sign(cross);expect(Math.sign(cross)).toBe(turnSign);}
    }
    expect(area/2).toBeGreaterThan(0);// screen-space clockwise
    // True rounded-rect area is w·h − (4−π)r²; inscribed chords shave off < 0.9 per corner at 3 segments.
    const exact=40*30-(4-Math.PI)*25;expect(Math.abs(area/2)).toBeLessThanOrEqual(exact);expect(Math.abs(area/2)).toBeGreaterThan(exact-4);
  });
  it('pairs inner and outer rings point-for-point for rings',()=>{
    expect(roundedOutline(0,0,40,30,5,3).length).toBe(roundedOutline(1,1,39,29,4,3).length);
  });
});

describe('icon catalog',()=>{
  const sources=(dir:string):string[]=>readdirSync(dir).flatMap(name=>{const path=join(dir,name),stat=statSync(path);return stat.isDirectory()?sources(path):/\.(svelte|ts)$/.test(name)?[path]:[];});
  const used=new Set<string>();
  for(const file of sources('src')){
    const text=readFileSync(file,'utf8');
    for(const match of text.matchAll(/<ToolIcon[^>]*\bname=(?:"([a-z0-9-]+)"|\{\s*'([a-z0-9-]+)'\s*\})/g))used.add(match[1]??match[2]);
    for(const match of text.matchAll(/\bicon:\s*'([a-z0-9-]+)'/g))used.add(match[1]);
  }
  it('defines every literally referenced icon name so no glyph falls back to the placeholder',()=>{
    expect(used.size).toBeGreaterThan(40);
    expect([...used].filter(name=>!icons[name]&&name!=='report'&&name!=='data'&&name!=='status').sort()).toEqual([]);
  });
  it('keeps every node on the 24px grid with a filled dot only where a drawing anchor is meant',()=>{
    for(const [name,nodes] of Object.entries(icons)){
      expect(nodes.length,name).toBeGreaterThan(0);
      for(const node of nodes){
        for(const [key,value] of Object.entries(node.attrs))expect(typeof value,`${name}.${key}`).toBe('string');
        if(node.tag==='circle'&&node.attrs.fill==='currentColor'){expect(Number(node.attrs.r),name).toBeLessThanOrEqual(2);expect(Number(node.attrs.cx)).toBeGreaterThanOrEqual(2);expect(Number(node.attrs.cx)).toBeLessThanOrEqual(22);}
      }
    }
  });
});
