import {describe,it,expect,vi} from 'vitest';
import {DEFAULT_APPEARANCE} from '../src/lib/chart/appearance';
import {paintPriceBar,priceBarUp,drawChartWatermark} from '../src/lib/render/price-series';

const bar={open:100,close:110,high:115,low:90};
const style={...DEFAULT_APPEARANCE,upColor:'#00ff00',downColor:'#ff0000',borderUpColor:'#0000ff',borderDownColor:'#ff00ff',wickUpColor:'#123456',wickDownColor:'#654321'};
const painter=()=>({rect:vi.fn(),seg:vi.fn()});

describe('price series appearance uses actual market semantics',()=>{
  it('colors by open/close or previous close without mutating OHLC',()=>{
    expect(priceBarUp(bar,120,style)).toBe(true);
    expect(priceBarUp(bar,120,{...style,colorBy:'previous-close'})).toBe(false);
    expect(priceBarUp(bar,120,{...style,chartType:'hollow'})).toBe(false);
    expect(priceBarUp(bar,undefined,{...style,chartType:'hollow'})).toBe(true);
    expect(bar).toEqual({open:100,close:110,high:115,low:90});
  });
  it('paints independent body, border and split wick colors',()=>{
    const r=painter();paintPriceBar(r,bar,99,10,3,v=>200-v,style);
    expect(r.rect.mock.calls[0]).toEqual([7,90,13,100,'#00ff00']);
    expect(r.rect.mock.calls.slice(1).every(call=>call[4]==='#0000ff')).toBe(true);
    expect(r.seg.mock.calls).toEqual([[10,85,10,90,'#123456'],[10,100,10,110,'#123456']]);
  });
  it('hollow red candle remains hollow after gapping down and closing above its open',()=>{
    const r=painter();paintPriceBar(r,bar,120,10,3,v=>200-v,{...style,chartType:'hollow'});
    expect(r.rect.mock.calls.every(call=>call[4]==='#ff00ff')).toBe(true);
    expect(r.seg.mock.calls.every(call=>call[4]==='#654321')).toBe(true);
  });
  it('filled green hollow candle closes below its open but above its previous close',()=>{
    const r=painter();paintPriceBar(r,{...bar,open:112},100,10,3,v=>200-v,{...style,chartType:'hollow'});
    expect(r.rect.mock.calls[0][4]).toBe('#00ff00');
  });
  it('honors visibility switches and still paints legible one-pixel dojis',()=>{
    const r=painter();paintPriceBar(r,bar,100,10,3,v=>200-v,{...style,showBodies:false,showBorders:false,showWicks:false});expect(r.rect).not.toHaveBeenCalled();expect(r.seg).not.toHaveBeenCalled();
    paintPriceBar(r,{...bar,close:100},100,10,3,v=>200-v,style);expect(r.rect.mock.calls[0]).toEqual([7,100,13,101,'#00ff00']);
  });
  it('OHLC bars retain left-open/right-close geometry and have no filled rectangles',()=>{
    const r=painter();paintPriceBar(r,bar,100,10,3,v=>200-v,{...style,chartType:'bars'});
    expect(r.rect).not.toHaveBeenCalled();expect(r.seg.mock.calls).toEqual([[10,85,10,110,'#00ff00'],[7,100,10,100,'#00ff00'],[10,90,13,90,'#00ff00']]);
  });
  it('does not emit malformed or line-mode candle geometry',()=>{
    const r=painter();paintPriceBar(r,{...bar,close:NaN},100,10,3,v=>v,style);paintPriceBar(r,bar,100,10,3,()=>NaN,style);paintPriceBar(r,bar,100,10,3,v=>v,{...style,chartType:'line'});expect(r.rect).not.toHaveBeenCalled();expect(r.seg).not.toHaveBeenCalled();
  });
});

it('watermark fits the main pane, uses current symbol and can be disabled',()=>{
  const c={save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),fillText:vi.fn(),measureText:vi.fn(()=>({width:800})),font:'',globalAlpha:1,fillStyle:'',textAlign:'',textBaseline:''};
  drawChartWatermark(c as unknown as CanvasRenderingContext2D,{...style,watermark:true},{top:30,height:200,width:320},'SOLUSDT','4h');
  expect(c.rect).toHaveBeenCalledWith(0,30,320,200);expect(c.fillText).toHaveBeenCalledWith('SOLUSDT · 4h',160,130);expect(c.font).toContain('17.28px');expect(c.globalAlpha).toBe(.1);expect(c.restore).toHaveBeenCalledOnce();
  c.fillText.mockClear();drawChartWatermark(c as unknown as CanvasRenderingContext2D,style,{top:0,height:200,width:320},'SOLUSDT','4h');expect(c.fillText).not.toHaveBeenCalled();
});
