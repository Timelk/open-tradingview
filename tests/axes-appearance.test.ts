import {describe,expect,it,vi} from 'vitest';
import {appearancePreset,contrastText,DEFAULT_APPEARANCE,type ChartAppearance} from '../src/lib/chart/appearance';
import {drawAxesBase,drawCrosshair,plotGuideSegments,type AxesInput} from '../src/lib/render/axes';

type Point=[number,number];
function surface(patch:Partial<ChartAppearance>={}) {
  const strokes:{color:string;alpha:number;segments:[Point,Point][]}[]=[];
  const labels:{text:string;color:string;font:string;x:number;y:number;maxWidth?:number}[]=[];
  const boxes:{color:string;x:number;y:number;width:number;height:number}[]=[];
  const dots:{color:string;x:number;y:number}[]=[];
  let cursor:Point=[0,0],segments:[Point,Point][]=[];
  const ctx={
    globalAlpha:1,strokeStyle:'',fillStyle:'',font:'',
    clearRect:vi.fn(),setLineDash:vi.fn(),
    beginPath(){segments=[];},
    moveTo(x:number,y:number){cursor=[x,y];},
    lineTo(x:number,y:number){const end:Point=[x,y];segments.push([cursor,end]);cursor=end;},
    stroke(){strokes.push({color:this.strokeStyle,alpha:this.globalAlpha,segments});},
    fillRect(x:number,y:number,width:number,height:number){boxes.push({color:this.fillStyle,x,y,width,height});},
    fillText(text:string,x:number,y:number,maxWidth?:number){labels.push({text,color:this.fillStyle,font:this.font,x,y,maxWidth});},
    measureText(text:string){return {width:text.length*7};},
    arc(x:number,y:number){dots.push({color:this.fillStyle,x,y});},
    fill:vi.fn(),
  };
  const input:AxesInput={
    ctx:ctx as unknown as CanvasRenderingContext2D,plotW:100,plotH:80,axisW:88,axisH:26,
    paneTicks:[{top:0,height:80,ticks:[{value:10,y:20},{value:20,y:60}]}],
    xTicks:[{x:40,label:'12:00'}],lastPrice:{y:40,label:'15.00',up:true},
    crosshair:{x:40,y:40,price:'15.25',time:'2026/09/25 12:00:00'},hoverDot:null,
    appearance:{...DEFAULT_APPEARANCE,...patch},
  };
  return {input,ctx,strokes,labels,boxes,dots};
}

describe('themed chart axes',()=>{
  it.each(['both','horizontal','vertical','none'] as const)('honors %s grid visibility independently of price guides',grid=>{
    const {input}=surface({grid,lastPriceLine:false});
    const segments=plotGuideSegments(input);
    expect(segments.filter(s=>s.y0===s.y1)).toHaveLength(grid==='both'||grid==='horizontal'?2:0);
    expect(segments.filter(s=>s.x0===s.x1)).toHaveLength(grid==='both'||grid==='vertical'?1:0);
  });

  it.each(['solid','dashed','dotted'] as const)('uses identical %s grid geometry and opacity in the GPU and Canvas paths',gridStyle=>{
    const {input,ctx,strokes}=surface({gridStyle,gridColor:'#123456',gridOpacity:.35,lastPriceLine:false});
    ctx.globalAlpha=.8;
    const guides=plotGuideSegments(input);
    drawAxesBase(input);
    const canvasSegments=strokes.filter(s=>s.color==='#123456').flatMap(s=>{
      expect(s.alpha).toBe(.35);
      return s.segments.map(([from,to])=>({x0:from[0],y0:from[1],x1:to[0],y1:to[1],color:s.color,alpha:s.alpha}));
    });
    expect(canvasSegments).toEqual(guides);
    expect(ctx.globalAlpha).toBe(.8);
    if(gridStyle==='solid')expect(guides).toHaveLength(3);
    else {
      const maxLength=gridStyle==='dotted'?1:4;
      expect(guides.length).toBeGreaterThan(3);
      expect(guides.every(s=>Math.hypot(s.x1-s.x0,s.y1-s.y0)<=maxLength+1e-9)).toBe(true);
    }
  });

  it('omits fully transparent grid guides while retaining price guides',()=>{
    const {input,strokes}=surface({gridOpacity:0});
    expect(plotGuideSegments(input).every(s=>s.color===DEFAULT_APPEARANCE.upColor)).toBe(true);
    drawAxesBase(input);
    expect(strokes.some(s=>s.color===DEFAULT_APPEARANCE.gridColor)).toBe(false);
    expect(strokes.some(s=>s.color===DEFAULT_APPEARANCE.upColor)).toBe(true);
  });

  it.each([[true,false],[false,true],[false,false]] as const)('keeps price line=%s and label=%s independent', (lastPriceLine,lastPriceLabel)=>{
    const {input,labels}=surface({grid:'none',lastPriceLine,lastPriceLabel,upColor:'#ffff00'});
    const guides=plotGuideSegments(input);
    expect(guides.length>0).toBe(lastPriceLine);
    expect(guides.every(s=>s.color==='#ffff00')).toBe(true);
    drawAxesBase(input);
    expect(labels.some(label=>label.text==='15.00')).toBe(lastPriceLabel);
    if(lastPriceLabel)expect(labels.find(label=>label.text==='15.00')?.color).toBe(contrastText('#ffff00'));
  });

  it('applies the down color and a legible foreground to the latest-price label',()=>{
    const {input,labels,boxes}=surface({downColor:'#000066'});
    input.lastPrice!.up=false;
    drawAxesBase(input);
    expect(plotGuideSegments(input).some(s=>s.color==='#000066')).toBe(true);
    expect(boxes.some(box=>box.color==='#000066')).toBe(true);
    expect(labels.find(label=>label.text==='15.00')?.color).toBe('#ffffff');
  });

  it('keeps labels and pane separators when scene guides are disabled, with light palette and scaled text',()=>{
    const {input,labels,boxes,strokes}=surface({...appearancePreset('light'),scaleFontSize:16,separatorColor:'#c0c1c2'});
    input.plotGuides=false;
    drawAxesBase(input);
    expect(strokes).toHaveLength(1);
    expect(strokes[0].color).toBe('#c0c1c2');
    expect(labels.map(label=>label.text)).toEqual(['10.00','20.00','12:00','15.00']);
    expect(labels.every(label=>label.font.startsWith('16px '))).toBe(true);
    expect(labels.filter(label=>label.text!=='15.00').every(label=>label.color===input.appearance!.textColor)).toBe(true);
    expect(boxes.slice(0,2).every(box=>box.color==='#ffffff')).toBe(true);
  });

  it.each(['solid','dashed','dotted'] as const)('themes %s crosshair geometry and both tags consistently',crosshairStyle=>{
    const {input,strokes,boxes,labels}=surface({crosshairStyle,crosshairColor:'#ffee00'});
    drawCrosshair(input);
    expect(strokes).toHaveLength(1);
    expect(strokes[0].color).toBe('#ffee00');
    expect(strokes[0].segments.length).toBe(crosshairStyle==='solid'?2:crosshairStyle==='dashed'?23:45);
    expect(boxes).toHaveLength(2);
    expect(boxes.every(box=>box.color==='#ffee00')).toBe(true);
    expect(labels.every(label=>label.color===contrastText('#ffee00'))).toBe(true);
    const timeBox=boxes[1];
    expect(timeBox.x).toBeGreaterThanOrEqual(0);
    expect(timeBox.x+timeBox.width).toBeLessThanOrEqual(input.plotW);
  });

  it('hides crosshair lines and tags without suppressing the themed series hover dot',()=>{
    const {input,strokes,boxes,labels,dots}=surface({crosshairVisible:false,lineColor:'#aabbcc'});
    input.hoverDot={x:40,y:40};
    drawCrosshair(input);
    expect(strokes).toEqual([]);
    expect(boxes).toEqual([]);
    expect(labels).toEqual([]);
    expect(dots).toEqual([{x:40,y:40,color:'#aabbcc'}]);
  });

  it('keeps tags and guide endpoints inside tiny chart bounds and suppresses unreadable labels',()=>{
    const {input,boxes,labels}=surface({scaleFontSize:16,gridStyle:'dotted'});
    input.plotW=5;input.plotH=3;input.axisW=2;input.axisH=2;
    input.paneTicks=[{top:0,height:3,ticks:[{value:15,y:3}]}];
    input.xTicks=[{x:5,label:'12:00'}];
    input.lastPrice!.y=3;input.crosshair!.x=5;input.crosshair!.y=3;
    drawAxesBase(input);drawCrosshair(input);
    expect(boxes.every(box=>box.x>=0&&box.y>=0&&box.width>=0&&box.height>=0&&box.x+box.width<=7&&box.y+box.height<=5)).toBe(true);
    expect(labels).toEqual([]);
    expect(plotGuideSegments(input).every(s=>s.x0>=0&&s.x1<=5&&s.y0>=0&&s.y1<=3)).toBe(true);
  });
});
