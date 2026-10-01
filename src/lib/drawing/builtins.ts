import { formatMarketPrice } from '../core/market-format';
import { ToolRegistry } from './registry';
import type { Drawing, DrawingTool, Pixel, Primitive, Projection } from './types';
import { drawingFontSize, estimateLabelWidth, labelHeight } from './labels';
import {translate} from '../i18n';
const path=(points:Pixel[],extra:Partial<Extract<Primitive,{kind:'path'}>>={}):Primitive=>({kind:'path',points,...extra});
const label=(d:Drawing,p:Projection,at:Pixel,text:string,color?:string,align:'left'|'center'|'right'='left'):Primitive=>({kind:'text',at,text,color,align,background:true,size:drawingFontSize(d),maxWidth:Math.max(1,p.pane.width-16)});
const points=(d:Drawing,p:Projection)=>d.points.map(a=>p.project(a));
const empty=()=>[];
function extend(a:Pixel,b:Pixel,width:number,both=false):Pixel[] {
  const dx=b.x-a.x,dy=b.y-a.y;
  if(Math.abs(dx)<.01)return both?[{x:a.x,y:-1e5},{x:a.x,y:1e5}]:[{x:a.x,y:a.y},{x:a.x,y:dy<0?-1e5:1e5}];
  const end=dx>0?width:0,start=both?(dx>0?0:width):a.x;
  return [{x:start,y:a.y+(start-a.x)*dy/dx},{x:end,y:a.y+(end-a.x)*dy/dx}];
}
function segment(d:Drawing,p:Projection,kind='line'):Primitive[]{
  const [a,b]=points(d,p);if(!a||!b)return [];
  const line=kind==='ray'?extend(a,b,p.pane.width):kind==='extended'?extend(a,b,p.pane.width,true):[a,b];
  const out=[path(line)];
  if(kind==='arrow'){
    const angle=Math.atan2(b.y-a.y,b.x-a.x),size=11;
    out.push(path([{x:b.x-size*Math.cos(angle-.45),y:b.y-size*Math.sin(angle-.45)},b,{x:b.x-size*Math.cos(angle+.45),y:b.y-size*Math.sin(angle+.45)}]));
  }
  return out;
}
function measurement(d:Drawing,p:Projection):Primitive[]{
  const [a,b]=points(d,p);if(!a||!b)return [];
  const first=d.points[0],last=d.points[1],delta=last.value-first.value,percent=first.value?delta/Math.abs(first.value)*100:0;
  const bars=Math.round(Math.abs(p.indexAt(last.time)-p.indexAt(first.time))),minutes=Math.abs(last.time-first.time)/60000;
  const duration=minutes>=1440?`${(minutes/1440).toFixed(1)}d`:minutes>=60?`${(minutes/60).toFixed(1)}h`:`${minutes.toFixed(0)}m`;
  const caption=translate('{0}{1} ({2}%) · {3} 根 · {4}',{0:delta>=0?'+':'',1:formatMarketPrice(delta),2:percent.toFixed(2),3:bars,4:duration});
  return [{kind:'rect',a,b,fill:d.style.color},path([a,b],{dash:'dashed'}),label(d,p,{x:(a.x+b.x)/2,y:Math.min(a.y,b.y)-labelHeight(drawingFontSize(d))/2-4},caption,undefined,'center')];
}
function position(d:Drawing,p:Projection,long:boolean):Primitive[]{
  const projected=points(d,p),[a,b,c]=projected;if(!a||!b)return [];
  if(!c)return [path([a,b],{dash:'dashed'})];
  const entry=d.points[0].value,target=d.points[1].value,stop=d.points[2].value;
  const gain=(target-entry)*(long?1:-1),risk=(entry-stop)*(long?1:-1);
  const left=Math.min(a.x,b.x),right=Math.max(a.x+70,b.x);
  const line=(y:number)=>path([{x:left,y},{x:right,y}]);
  return [
    {kind:'rect',a:{x:left,y:a.y},b:{x:right,y:b.y},fill:'#26a69a',color:'#26a69a'},
    {kind:'rect',a:{x:left,y:a.y},b:{x:right,y:c.y},fill:'#ef5350',color:'#ef5350'},line(a.y),
    label(d,p,{x:left+5,y:b.y-labelHeight(drawingFontSize(d))/2-3},translate('目标 {0}',{0:formatMarketPrice(target)}),'#42c8ae'),label(d,p,{x:left+5,y:c.y+labelHeight(drawingFontSize(d))/2+3},translate('止损 {0}',{0:formatMarketPrice(stop)}),'#ff7774'),
    label(d,p,{x:left+5,y:a.y-labelHeight(drawingFontSize(d))/2-3},gain>0&&risk>0?translate('{0} · 盈亏比 {1}',{0:translate(long?'多头':'空头'),1:(gain/risk).toFixed(2)}):translate('请调整目标与止损方向')),
  ];
}

/** Keep exact level geometry while arranging only its labels in a readable
 * in-pane column. Compressed panes retain key labels, never drop level lines. */
function fibonacci(d:Drawing,p:Projection):Primitive[]{
  const [a,b]=points(d,p);if(!a||!b)return [];
  const levels=[...new Set(String(d.props.levels??'0,0.236,0.382,0.5,0.618,0.786,1').split(',').map(v=>v.trim()).filter(Boolean).map(Number).filter(Number.isFinite))].slice(0,24);
  const colors=['#89919f','#e07379','#cbad56','#55b3a5','#4d91ff','#9082ca','#89919f'];
  const left=Math.min(a.x,b.x),right=Math.max(a.x,b.x),out:Primitive[]=[path([a,b],{dash:'dashed'})];
  const rows=levels.map((ratio,index)=>({ratio,index,color:colors[index%colors.length],value:d.points[1].value+(d.points[0].value-d.points[1].value)*ratio,y:b.y+(a.y-b.y)*ratio}))
    .filter(row=>Number.isFinite(row.value)&&Number.isFinite(row.y));
  for(const row of rows)out.push(path([{x:left,y:row.y},{x:right,y:row.y}],{color:row.color}));
  if(right<0||left>p.pane.width)return out;
  const fontSize=drawingFontSize(d),height=labelHeight(fontSize),gap=4,padding=4;
  const capacity=Math.max(0,Math.floor((p.pane.height-padding*2+gap)/(height+gap)));
  const priority=(ratio:number)=>ratio===0||ratio===1?3:ratio===.5||ratio===.618?2:1;
  const visible=rows.filter(row=>row.y>=p.pane.top&&row.y<=p.pane.top+p.pane.height)
    .sort((a,b)=>priority(b.ratio)-priority(a.ratio)||a.index-b.index).slice(0,capacity).sort((a,b)=>a.y-b.y);
  if(!visible.length)return out;
  const labels=visible.map(row=>({...row,text:`${row.ratio}  (${formatMarketPrice(row.value)})`}));
  const textPadding=Math.max(5,Math.ceil(fontSize*.3)),minimumX=textPadding+4;
  const widest=Math.max(...labels.map(row=>estimateLabelWidth(row.text,fontSize)))+textPadding*2;
  const x=Math.max(minimumX,Math.min(Math.max(minimumX,left+10),p.pane.width-Math.min(widest,p.pane.width-16)-8));
  const top=p.pane.top+padding+height/2,bottom=p.pane.top+p.pane.height-padding-height/2;
  const y=labels.map(row=>Math.max(top,Math.min(bottom,row.y)));
  for(let i=1;i<y.length;i++)y[i]=Math.max(y[i],y[i-1]+height+gap);
  y[y.length-1]=Math.min(y[y.length-1],bottom);
  for(let i=y.length-2;i>=0;i--)y[i]=Math.min(y[i],y[i+1]-height-gap);
  labels.forEach((row,index)=>{
    if(Math.abs(y[index]-row.y)>.5)out.push(path([{x:x-6,y:row.y},{x:x-6,y:y[index]},{x:x,y:y[index]}],{color:row.color}));
    out.push(label(d,p,{x,y:y[index]},row.text,row.color));
  });
  return out;
}

export function registerDrawingBuiltins(reg:ToolRegistry):void {
  [
    ['cursor','光标',0],['trend','趋势线工具',1],['fibonacci','斐波那契',2],['patterns','形态',3],
    ['forecast','预测与测量',4],['shapes','几何图形',5],['annotation','注释',6],['icons','标记',7],['custom','自定义工具',8],
  ].forEach(([id,name,order])=>reg.registerGroup({id:String(id),name:String(name),order:Number(order)}));
  const defs:DrawingTool[]=[
    {id:'cursor',name:'十字线 / 选择',group:'cursor',icon:'cross',mode:'cursor',cursor:'crosshair',build:empty},
    {id:'pointer',name:'箭头 / 选择',group:'cursor',icon:'pointer',mode:'cursor',cursor:'default',build:empty},
    {id:'eraser',name:'橡皮擦',group:'cursor',icon:'eraser',mode:'eraser',build:empty},
    {id:'trend-line',name:'趋势线',group:'trend',icon:'trend',points:2,shortcut:'Alt+T',build:segment},
    {id:'ray',name:'射线',group:'trend',icon:'ray',points:2,build:(d,p)=>segment(d,p,'ray')},
    {id:'extended-line',name:'延长线',group:'trend',icon:'extended',points:2,build:(d,p)=>segment(d,p,'extended')},
    {id:'horizontal-line',name:'水平线',group:'trend',icon:'horizontal',points:1,shortcut:'Alt+H',build:(d,p)=>{
      const a=p.project(d.points[0]);return [path([{x:0,y:a.y},{x:p.pane.width,y:a.y}]),label(d,p,{x:p.pane.width-10,y:a.y},formatMarketPrice(d.points[0].value),undefined,'right')];}},
    {id:'vertical-line',name:'垂直线',group:'trend',icon:'vertical',points:1,shortcut:'Alt+V',build:(d,p)=>{
      const a=p.project(d.points[0]);return [path([{x:a.x,y:p.pane.top},{x:a.x,y:p.pane.top+p.pane.height}])];}},
    {id:'parallel-channel',supportsFill:true,name:'平行通道',group:'trend',icon:'channel',points:3,build:(d,p)=>{
      const [a,b,c]=points(d,p);if(!a||!b)return [];if(!c)return [path([a,b])];
      const length=Math.hypot(b.x-a.x,b.y-a.y)||1,nx=-(b.y-a.y)/length,ny=(b.x-a.x)/length;
      const offset=(c.x-a.x)*nx+(c.y-a.y)*ny,a2={x:a.x+nx*offset,y:a.y+ny*offset},b2={x:b.x+nx*offset,y:b.y+ny*offset};
      return [path([a,b,b2,a2],{closed:true,fill:d.style.color}),path([{x:(a.x+a2.x)/2,y:(a.y+a2.y)/2},{x:(b.x+b2.x)/2,y:(b.y+b2.y)/2}],{dash:'dashed'})];}},
    {id:'fib-retracement',name:'斐波那契回撤',group:'fibonacci',icon:'fib',points:2,
      fields:[{key:'levels',label:'回撤水平',type:'text',default:'0,0.236,0.382,0.5,0.618,0.786,1'}],build:fibonacci},
    {id:'abcd-pattern',name:'ABCD 形态',group:'patterns',icon:'pattern',points:4,build:(d,p)=>{
      const pts=points(d,p);return [path(pts),...pts.map((at,i)=>label(d,p,{x:at.x+6,y:at.y-labelHeight(drawingFontSize(d))/2-3},'ABCD'[i]??''))];}},
    {id:'analysis-path',name:'人工分析结构',group:'patterns',icon:'pattern',freehand:true,fields:[{key:'labels',label:'锚点名称（逗号分隔）',type:'text',default:''}],build:(d,p)=>{
      const pts=points(d,p),labels=String(d.props.labels??'').split(',');return [path(pts),...pts.flatMap((at,i)=>labels[i]?[label(d,p,{x:at.x+5,y:at.y-15},labels[i])]:[])];}},
    {id:'triangle-pattern',supportsFill:true,name:'三角形态',group:'patterns',icon:'triangle',points:3,build:(d,p)=>[path(points(d,p),{closed:d.points.length>=3,fill:d.style.color})]},
    {id:'long-position',supportsFill:true,name:'多头仓位测算',group:'forecast',icon:'position',points:3,build:(d,p)=>position(d,p,true)},
    {id:'short-position',supportsFill:true,name:'空头仓位测算',group:'forecast',icon:'position-short',points:3,build:(d,p)=>position(d,p,false)},
    {id:'date-price-range',supportsFill:true,name:'日期和价格范围',group:'forecast',icon:'ruler',points:2,build:measurement},
    {id:'brush',name:'画笔',group:'shapes',icon:'brush',freehand:true,handles:()=>[],build:(d,p)=>[path(points(d,p))]},
    {id:'rectangle',supportsFill:true,name:'矩形',group:'shapes',icon:'rectangle',points:2,build:(d,p)=>{const [a,b]=points(d,p);return a&&b?[{kind:'rect',a,b,fill:d.style.color}]:[];}},
    {id:'ellipse',supportsFill:true,name:'椭圆',group:'shapes',icon:'ellipse',points:2,build:(d,p)=>{const [a,b]=points(d,p);return a&&b?[{kind:'ellipse',a,b,fill:d.style.color}]:[];}},
    {id:'arrow',name:'箭头',group:'shapes',icon:'arrow',points:2,build:(d,p)=>segment(d,p,'arrow')},
    {id:'text',name:'文字',group:'annotation',icon:'text',points:1,fields:[{key:'text',label:'文字',type:'text',default:'文字注释'}],build:(d,p)=>[label(d,p,p.project(d.points[0]),String(d.props.text))]},
    {id:'buy-marker',supportsFill:true,name:'向上标记',group:'icons',icon:'mark-up',points:1,defaultStyle:{color:'#26a69a'},build:(d,p)=>{const a=p.project(d.points[0]);return [path([{x:a.x-7,y:a.y+12},a,{x:a.x+7,y:a.y+12}],{closed:true,fill:d.style.color})];}},
    {id:'sell-marker',supportsFill:true,name:'向下标记',group:'icons',icon:'mark-down',points:1,defaultStyle:{color:'#ef5350'},build:(d,p)=>{const a=p.project(d.points[0]);return [path([{x:a.x-7,y:a.y-12},a,{x:a.x+7,y:a.y-12}],{closed:true,fill:d.style.color})];}},
    {id:'zoom-region',supportsFill:true,name:'区域放大',group:'forecast',icon:'zoom',points:2,build:(d,p)=>{const [a,b]=points(d,p);return a&&b?[{kind:'rect',a,b,fill:d.style.color}]:[];},onComplete:(d,services)=>{services.zoomTo(d);return 'discard';}},
  ];
  const labelled=new Set(['horizontal-line','fib-retracement','abcd-pattern','long-position','short-position','date-price-range','text']);
  defs.forEach((def,order)=>reg.register({...def,order,...(labelled.has(def.id)?{supportsLabels:true}:{})}));
}
