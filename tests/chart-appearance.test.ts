import {afterEach,describe,expect,it,vi} from 'vitest';
import {
  APPEARANCE_PRESETS,APPEARANCE_STORAGE_KEY,DEFAULT_APPEARANCE,
  appearancePreset,colorWithOpacity,contrastRatio,contrastText,deriveOverlaySurface,loadAppearance,normalizeAppearance,normalizeColor,readableSurfaceColor,saveAppearance,
  type ChartAppearance,
} from '../src/lib/chart/appearance';

function memory(raw?:string){
  const data=new Map<string,string>();if(raw!==undefined)data.set(APPEARANCE_STORAGE_KEY,raw);
  return {data,getItem:vi.fn((key:string)=>data.get(key)??null),setItem:vi.fn((key:string,value:string)=>{data.set(key,value);})};
}
afterEach(()=>vi.unstubAllGlobals());

describe('chart appearance normalization',()=>{
  it.each([undefined,null,false,0,'dark',[],[{}],{version:0},{version:2},{version:'1'}])('returns independent safe defaults for an invalid document: %j',input=>{
    const first=normalizeAppearance(input),second=normalizeAppearance(input);
    expect(first).toEqual(DEFAULT_APPEARANCE);expect(first).not.toBe(DEFAULT_APPEARANCE);expect(first).not.toBe(second);
    first.background='#ffffff';first.watermarkText='edited';expect(second).toEqual(DEFAULT_APPEARANCE);expect(DEFAULT_APPEARANCE.background).toBe('#1e1f24');expect(DEFAULT_APPEARANCE.preset).toBe('terminal');
  });

  it('round trips the entire supported appearance contract without altering its input',()=>{
    const input:ChartAppearance={...appearancePreset('light'),preset:'custom',chartType:'hollow',colorBy:'previous-close',
      upColor:'#12abcd',downColor:'#ab34cd',borderUpColor:'#345678',borderDownColor:'#456789',wickUpColor:'#56789a',wickDownColor:'#6789ab',
      showBodies:false,showBorders:false,showWicks:false,lineColor:'#abcdef',lineWidth:3.25,volumeOpacity:.23,
      background:'#fafafa',backgroundEnd:'#eeddaa',backgroundMode:'gradient',overlayOpacity:.85,grid:'horizontal',gridColor:'#112233',gridOpacity:.3,gridStyle:'dotted',
      textColor:'#123456',scaleFontSize:14,separatorColor:'#234567',crosshairColor:'#334455',crosshairStyle:'solid',crosshairVisible:false,
      lastPriceLine:false,lastPriceLabel:false,watermark:true,watermarkColor:'#445566',watermarkOpacity:.25,watermarkText:'BTC / USDT · 研究',watermarkFontSize:72};
    const before=structuredClone(input),result=normalizeAppearance(input);
    expect(result).toEqual(input);expect(input).toEqual(before);expect(result).not.toBe(input);
  });

  it('accepts only known field names and exact enum/boolean tokens',()=>{
    const result=normalizeAppearance({version:1,preset:'unknown',chartType:'Candles',colorBy:'close',backgroundMode:'url()',grid:'diagonal',gridStyle:'dash',crosshairStyle:'dot',
      showBodies:0,showBorders:'false',showWicks:null,crosshairVisible:'true',watermark:1,lastPriceLine:[],lastPriceLabel:{},
      source:'binance',symbol:'ETHUSDT',interval:'4h',script:'alert(1)',__extra:'ignored'});
    expect(result).toEqual(DEFAULT_APPEARANCE);expect(Object.keys(result).sort()).toEqual(Object.keys(DEFAULT_APPEARANCE).sort());
  });

  it.each([
    ['lineWidth',1,4],['volumeOpacity',0,1],['overlayOpacity',.35,.96],['gridOpacity',0,1],['scaleFontSize',10,16],['watermarkOpacity',0,.5],['watermarkFontSize',16,96],
  ] as const)('clamps %s to its finite supported interval without coercing strings', (key,min,max)=>{
    expect(normalizeAppearance({[key]:-1e6})[key]).toBe(min);expect(normalizeAppearance({[key]:1e6})[key]).toBe(max);
    expect(normalizeAppearance({[key]:min})[key]).toBe(min);expect(normalizeAppearance({[key]:max})[key]).toBe(max);
    for(const invalid of [NaN,Infinity,-Infinity,String(max),null,true])expect(normalizeAppearance({[key]:invalid})[key]).toBe(DEFAULT_APPEARANCE[key]);
  });

  it('normalizes every persisted color and rejects CSS syntax outside hex colors',()=>{
    const colorKeys=(Object.keys(DEFAULT_APPEARANCE) as (keyof ChartAppearance)[]).filter(key=>typeof DEFAULT_APPEARANCE[key]==='string'&&String(DEFAULT_APPEARANCE[key]).startsWith('#'));
    const normalized=normalizeAppearance(Object.fromEntries(colorKeys.map(key=>[key,' #AbC '])));
    for(const key of colorKeys)expect(normalized[key],key).toBe('#aabbcc');
    for(const unsafe of ['red','transparent','rgb(1,2,3)','#abcd','#11223344','url(javascript:alert(1))','var(--text)','</style><script>']){
      const result=normalizeAppearance(Object.fromEntries(colorKeys.map(key=>[key,unsafe])));
      for(const key of colorKeys)expect(result[key],`${key}: ${unsafe}`).toBe(DEFAULT_APPEARANCE[key]);
    }
  });

  it('bounds watermark text, removes control characters and preserves literal user labels',()=>{
    const label='BTC / USDT · 我的图表 <tag> "quoted" & normal';
    expect(normalizeAppearance({watermarkText:`\u0000${label}\n\r\t\u001b\u007f`}).watermarkText).toBe(label);
    expect(normalizeAppearance({watermarkText:'界'.repeat(100)}).watermarkText).toBe('界'.repeat(64));
    expect(normalizeAppearance({watermarkText:42}).watermarkText).toBe('');
    expect(normalizeAppearance({watermarkText:{toString:()=>{throw Error('must not coerce');}}}).watermarkText).toBe('');
  });
});

describe('appearance presets are fresh chart-only configurations',()=>{
  it('provides each named preset once with a valid, independently owned configuration',()=>{
    expect(APPEARANCE_PRESETS.map(p=>p.id).sort()).toEqual(['dark','light','midnight','paper','terminal']);
    // Classic dark keeps its familiar TradingView-like palette explicitly.
    expect(appearancePreset('dark')).toMatchObject({background:'#151718',upColor:'#26a69a',downColor:'#ef5350'});
    for(const {id,name,description} of APPEARANCE_PRESETS){
      expect(name.trim().length).toBeGreaterThan(0);expect(description.trim().length).toBeGreaterThan(0);
      const first=appearancePreset(id),second=appearancePreset(id);expect(first.preset).toBe(id);expect(normalizeAppearance(first)).toEqual(first);
      first.background='#123456';first.chartType='line';expect(second).toEqual(appearancePreset(id));expect(second).not.toBe(first);
    }
    expect(DEFAULT_APPEARANCE).toEqual(appearancePreset('terminal'));expect(Object.isFrozen(DEFAULT_APPEARANCE)).toBe(true);
  });

  it('keeps the documented light, midnight and paper color semantics',()=>{
    const light=appearancePreset('light'),midnight=appearancePreset('midnight'),paper=appearancePreset('paper');
    expect(contrastText(light.background)).toBe('#121820');expect(contrastText(paper.background)).toBe('#121820');
    expect(contrastText(midnight.background)).toBe('#ffffff');expect(midnight.backgroundMode).toBe('gradient');expect(midnight.backgroundEnd).not.toBe(midnight.background);
    expect(parseInt(paper.upColor.slice(1,3),16)).toBeGreaterThan(parseInt(paper.upColor.slice(3,5),16));
    expect(parseInt(paper.downColor.slice(3,5),16)).toBeGreaterThan(parseInt(paper.downColor.slice(1,3),16));
    for(const preset of [light,midnight,paper])expect(preset).toMatchObject({chartType:'candles',colorBy:'open-close',showBodies:true,showBorders:true,showWicks:true});
  });
});

describe('appearance persistence remains isolated and recoverable',()=>{
  it('persists the normalized snapshot under its own versioned key and restores it',()=>{
    const storage=memory(),appearance={...appearancePreset('paper'),preset:'custom' as const,chartType:'bars' as const,grid:'none' as const,watermarkText:'Research'};
    storage.data.set('tvchart.workspace.v2:binance:BTCUSDT','scene sentinel');
    storage.data.set('tvchart.market-selection.v2','market sentinel');
    expect(saveAppearance(appearance,storage)).toBe(true);expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(APPEARANCE_STORAGE_KEY,JSON.stringify(appearance));expect(loadAppearance(storage)).toEqual(appearance);
    expect(storage.getItem).toHaveBeenCalledWith(APPEARANCE_STORAGE_KEY);
    expect(storage.data.get('tvchart.workspace.v2:binance:BTCUSDT')).toBe('scene sentinel');expect(storage.data.get('tvchart.market-selection.v2')).toBe('market sentinel');
    appearance.background='#000000';expect(loadAppearance(storage).background).toBe('#f6f3ec');
  });

  it('normalizes malformed caller fields before serializing without mutating caller data',()=>{
    const storage=memory(),input={...appearancePreset('dark'),upColor:'#ABC',lineWidth:100,gridOpacity:-1,watermarkText:'A\nB',unrelated:'private'};
    expect(saveAppearance(input,storage)).toBe(true);expect(loadAppearance(storage)).toMatchObject({upColor:'#aabbcc',lineWidth:4,gridOpacity:0,watermarkText:'AB'});
    expect(JSON.parse(storage.data.get(APPEARANCE_STORAGE_KEY)!)).not.toHaveProperty('unrelated');expect(input).toMatchObject({upColor:'#ABC',lineWidth:100,gridOpacity:-1,watermarkText:'A\nB'});
  });

  it.each(['{broken','null','[]','false','42','"dark"','{"version":9,"background":"#ffffff"}'])('loads defaults for damaged or unsupported storage without replacing the original: %s',raw=>{
    const storage=memory(raw);expect(loadAppearance(storage)).toEqual(DEFAULT_APPEARANCE);expect(storage.setItem).not.toHaveBeenCalled();expect(storage.data.get(APPEARANCE_STORAGE_KEY)).toBe(raw);
  });

  it('reports quota failures, leaves the saved baseline intact and permits retry',()=>{
    const storage=memory(JSON.stringify(appearancePreset('dark'))),write=storage.setItem;let fail=true;
    storage.setItem=vi.fn((key:string,value:string)=>{if(fail)throw Error('quota');write(key,value);});
    expect(saveAppearance(appearancePreset('light'),storage)).toBe(false);expect(loadAppearance(storage)).toEqual(appearancePreset('dark'));
    fail=false;expect(saveAppearance(appearancePreset('light'),storage)).toBe(true);expect(loadAppearance(storage)).toEqual(appearancePreset('light'));
  });

  it('handles absent browser storage and denied access without throwing',()=>{
    vi.stubGlobal('localStorage',undefined);expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);expect(saveAppearance(appearancePreset('light'))).toBe(false);
    vi.stubGlobal('localStorage',{getItem(){throw Error('denied');},setItem(){throw Error('denied');}});
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);expect(saveAppearance(appearancePreset('light'))).toBe(false);
  });

  it('reads an absent record without writing a default and ignores unrelated old keys',()=>{
    const storage=memory();storage.data.set('tvchart.chart-appearance.v0',JSON.stringify(appearancePreset('paper')));
    expect(loadAppearance(storage)).toEqual(DEFAULT_APPEARANCE);expect(storage.setItem).not.toHaveBeenCalled();expect(storage.getItem).toHaveBeenCalledTimes(1);
  });
});

describe('appearance color helpers and adaptive frosted-glass contrast',()=>{
  it.each([['#abc','#aabbcc'],[' #ABCDEF ','#abcdef'],['#000','#000000'],['#123456','#123456']])('normalizes %s', (raw,expected)=>expect(normalizeColor(raw)).toBe(expected));
  it.each([null,undefined,42,{},'#12','#12345','#gggggg','white','rgb(0,0,0)'])('rejects invalid color: %j',raw=>expect(normalizeColor(raw)).toBeUndefined());
  it('selects readable text using luminance, including short hex and a safe invalid-input fallback',()=>{
    expect(contrastText('#fff')).toBe('#121820');expect(contrastText('#000')).toBe('#ffffff');expect(contrastText('#ff0000')).toBe('#121820');expect(contrastText('#0000ff')).toBe('#ffffff');expect(contrastText('bad')).toBe('#ffffff');
  });
  it('clamps valid opacity at the endpoints and rounds an intermediate byte',()=>{
    expect(colorWithOpacity('#abcdef',-1)).toBe('#abcdef00');expect(colorWithOpacity('#abcdef',0)).toBe('#abcdef00');expect(colorWithOpacity('#abcdef',.5)).toBe('#abcdef80');expect(colorWithOpacity('#abcdef',1)).toBe('#abcdefff');expect(colorWithOpacity('#abcdef',2)).toBe('#abcdefff');
  });
  it('derives high-contrast frosted-glass overlay tokens and clamps low-contrast series colors across all presets',()=>{
    for(const id of ['terminal','dark','light','midnight','paper'] as const){
      const preset=appearancePreset(id),surface=deriveOverlaySurface(preset);
      expect(surface.isLight).toBe(id==='light'||id==='paper');
      expect(contrastRatio(surface.glassText,surface.surfaceSolid)).toBeGreaterThanOrEqual(10.5);
      expect(contrastRatio(surface.glassTextMuted,surface.surfaceSolid)).toBeGreaterThanOrEqual(5.0);
      for(const seriesHex of ['#e8b10c','#a4b3c6','#45d6b0','#ff8985','#72a7ef','#1e293b']){
        const adapted=readableSurfaceColor(seriesHex,surface.surfaceSolid,4.8);
        expect(contrastRatio(adapted,surface.surfaceSolid)).toBeGreaterThanOrEqual(4.6);
      }
    }
  });
  it('keeps repeated palette reads exact across theme and contrast-threshold changes',()=>{
    const fg='#888888',dark=readableSurfaceColor(fg,'#151718',4.8),light=readableSurfaceColor(fg,'#ffffff',4.8),strict=readableSurfaceColor(fg,'#ffffff',9);
    expect(dark).not.toBe(light);expect(strict).not.toBe(light);
    expect(contrastRatio(dark,'#151718')).toBeGreaterThanOrEqual(4.8);
    expect(contrastRatio(light,'#ffffff')).toBeGreaterThanOrEqual(4.8);
    expect(contrastRatio(strict,'#ffffff')).toBeGreaterThanOrEqual(9);
    for(let i=0;i<100;i++){
      expect(readableSurfaceColor('#88888888','#FFFFFF',4.8)).toBe(light);
      expect(readableSurfaceColor(fg,'#151718',4.8)).toBe(dark);
      expect(readableSurfaceColor(fg,'#ffffff',9)).toBe(strict);
    }
  });
});
