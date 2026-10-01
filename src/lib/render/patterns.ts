import {placeOverlayLabel} from './overlay-label';
import type {PatternMatch} from '../patterns/types';
import {patternChartLabel} from '../patterns/presentation';
import {readableSurfaceColor,type ChartOverlaySurface} from '../chart/appearance';
import {translate,translateCanonical} from '../i18n';

interface Pixel {x:number;y:number}
interface Bounds {left:number;right:number;top:number;bottom:number}
export interface PatternHit {
  instanceId:string;pattern:PatternMatch;bounds:Bounds;clipBounds?:Bounds;segments:[Pixel,Pixel][];
}
export interface PatternPaintOptions {
  instanceId:string;color:string;width:number;opacity?:number;selectedId?:string;
  labels:boolean;zones:boolean;targets:boolean;
  project:(time:number,value:number)=>Pixel;
  bounds:Bounds;barWidth:number;occupied:Bounds[];
  surface?:ChartOverlaySurface;
}
const overlap=(a:Bounds,b:Bounds)=>a.left<b.right+3&&a.right>b.left-3&&a.top<b.bottom+3&&a.bottom>b.top-3;
const shoulderLabels:Record<string,string>={L:'左肩',N1:'颈点1',H:'头部',N2:'颈点2',R:'右肩'};

/** Sparse overlays are drawn in CSS pixels on the existing composition surface.
 * No new canvas, animations or per-frame pattern recognition is introduced. */
export function drawPatterns(ctx:CanvasRenderingContext2D,patterns:readonly PatternMatch[],o:PatternPaintOptions):PatternHit[] {
  const hits:PatternHit[]=[];
  const box=o.bounds,s=o.surface,labelBg=s?.canvasLabelBg??'#172027',dotBg=s?.surfaceSolid??'#151718',mutedInk=s?.canvasLabelMuted??'#aebfce';
  ctx.save();ctx.beginPath();ctx.rect(box.left,box.top,box.right-box.left,box.bottom-box.top);ctx.clip();
  ctx.globalAlpha*=o.opacity??1;
  ctx.font='500 11px ui-monospace,"PingFang SC",sans-serif';ctx.textBaseline='middle';
  for(const pattern of patterns){
    const points=pattern.points.map(p=>o.project(p.time,p.value));
    if(points.length<3||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))continue;
    const guidePoints=(pattern.guides??[]).map(guide=>({...guide,pixels:guide.points.map(p=>o.project(p.time,p.value)) as [Pixel,Pixel],curve:guide.path?.map(p=>o.project(p.time,p.value))}));
    const events=(pattern.events??[]).map(event=>({...event,pixel:o.project(event.time,event.value)}));
    const resolution=o.targets&&pattern.resolution?o.project(pattern.resolution.time,pattern.resolution.price):undefined;
    const extent=[...points,...guidePoints.flatMap(guide=>guide.pixels),...events.map(event=>event.pixel),...(resolution?[resolution]:[])];
    if(Math.max(...extent.map(p=>p.x))<box.left||Math.min(...extent.map(p=>p.x))>box.right)continue;
    const selected=pattern.id===o.selectedId,invalid=pattern.status==='invalidated',huzi=pattern.family.startsWith('huzi');
    const rawColor=invalid?'#8290a0':pattern.stage==='failed-breakout'?'#d1aa65':o.color;
    const opacity=ctx.globalAlpha,color=s?readableSurfaceColor(rawColor,s.surfaceSolid,4.5):rawColor;
    ctx.strokeStyle=color;ctx.lineWidth=selected?Math.max(2,o.width):o.width;
    ctx.setLineDash(invalid||huzi?[4,4]:[]);
    if(huzi){ctx.globalAlpha=opacity*(selected?.65:.35);ctx.lineWidth=1;}
    ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);for(const p of points.slice(1))ctx.lineTo(p.x,p.y);
    ctx.stroke();
    const segments:[Pixel,Pixel][]=points.slice(1).map((p,i)=>[points[i],p]);
    // Harmonic triangles are distinct from Huzi's actual fitted boundaries.
    if(points.length===5&&!huzi){
      ctx.globalAlpha=opacity*(selected?.15:.06);ctx.fillStyle=color;
      ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);ctx.lineTo(points[1].x,points[1].y);ctx.lineTo(points[2].x,points[2].y);ctx.closePath();ctx.fill();
      ctx.beginPath();ctx.moveTo(points[2].x,points[2].y);ctx.lineTo(points[3].x,points[3].y);ctx.lineTo(points[4].x,points[4].y);ctx.closePath();ctx.fill();
      ctx.globalAlpha=opacity*.6;ctx.setLineDash([3,4]);ctx.lineWidth=1;
      for(const [a,b] of [[0,2],[2,4],[0,4]] as [number,number][]){
        ctx.beginPath();ctx.moveTo(points[a].x,points[a].y);ctx.lineTo(points[b].x,points[b].y);ctx.stroke();segments.push([points[a],points[b]]);
      }
    }
    ctx.globalAlpha=opacity;ctx.setLineDash([]);
    // A horizontal band ("door") is a zone, not two unrelated lines: tint the space between its edges.
    if(pattern.family==='huzi-zone'){
      const top=guidePoints.find(g=>g.role==='upper'),bottom=guidePoints.find(g=>g.role==='lower');
      if(top&&bottom&&[top.pixels[0].x,top.pixels[1].x,top.pixels[0].y,bottom.pixels[0].y].every(Number.isFinite)){
        ctx.globalAlpha=opacity*(selected?.2:.13);ctx.fillStyle=color;
        ctx.fillRect(top.pixels[0].x,Math.min(top.pixels[0].y,bottom.pixels[0].y),Math.max(0,top.pixels[1].x-top.pixels[0].x),Math.max(2,Math.abs(bottom.pixels[0].y-top.pixels[0].y)));
        ctx.globalAlpha=opacity;
      }
    }
    for(const guide of guidePoints){
      const [a,b]=guide.pixels;if(![a.x,a.y,b.x,b.y].every(Number.isFinite))continue;
      ctx.strokeStyle=color;ctx.lineWidth=selected?Math.max(2,o.width):o.width;ctx.setLineDash(guide.role==='pole'?[3,3]:[]);
      ctx.beginPath();
      if(guide.curve&&guide.curve.length>=2&&guide.curve.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))){
        ctx.moveTo(guide.curve[0].x,guide.curve[0].y);for(const p of guide.curve.slice(1)){ctx.lineTo(p.x,p.y);}
        ctx.stroke();for(let k=1;k<guide.curve.length;k++)segments.push([guide.curve[k-1],guide.curve[k]]);
        if(selected&&o.labels&&b.x>=box.left&&b.x<box.right-30&&b.y>box.top+15&&b.y<box.bottom-15){
          ctx.fillStyle=mutedInk;ctx.textAlign='left';ctx.fillText(translate('曲线'),b.x+4,b.y-8);
        }
        continue;
      }
      ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();segments.push([a,b]);
      if(selected&&o.labels&&b.x>=box.left&&b.x<box.right-30&&b.y>box.top+15&&b.y<box.bottom-15){
        ctx.fillStyle=mutedInk;ctx.textAlign='left';ctx.fillText(translate(({upper:'上沿',lower:'下沿',neckline:'颈线',pole:'旗杆',curve:'曲线'})[guide.role]),b.x+4,b.y-8);
      }
    }
    ctx.setLineDash([]);
    const anchor=huzi?pattern.events?.find(event=>event.kind==='breakout')??pattern.points.at(-1)!:pattern.points.at(-1)!;
    const last=o.project(anchor.time,anchor.value);
    const confirmation=o.project(pattern.confirmedAt,anchor.value);
    const extension=Math.min(95,Math.max(32,o.barWidth*8)),right=Math.min(box.right,Math.max(last.x,confirmation.x)+extension);
    if(o.zones||selected){
      const top=o.project(anchor.time,pattern.zone.high).y,bottom=o.project(anchor.time,pattern.zone.low).y;
      ctx.fillStyle=color;ctx.globalAlpha=opacity*.09;ctx.fillRect(last.x,top,Math.max(0,right-last.x),Math.max(2,bottom-top));
      ctx.globalAlpha=opacity*.65;ctx.strokeStyle=color;ctx.lineWidth=1;ctx.setLineDash([3,3]);
      ctx.strokeRect(last.x,top,Math.max(0,right-last.x),Math.max(2,bottom-top));ctx.setLineDash([]);ctx.globalAlpha=opacity;
    }
    if(selected||o.targets){
      for(const [value,label] of [[pattern.invalidation,'失效'],...pattern.targets.map((value,index)=>[value,`T${index+1}`])] as [number,string][]){
        const yy=o.project(anchor.time,value).y;if(yy<box.top+9||yy>box.bottom-9)continue;
        ctx.globalAlpha=opacity*.65;ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(last.x,yy);ctx.lineTo(right,yy);ctx.stroke();ctx.setLineDash([]);
        ctx.fillStyle=mutedInk;ctx.textAlign='left';ctx.fillText(translate(label),Math.min(right+4,box.right-28),yy);
      }
      ctx.globalAlpha=opacity;
    }
    for(let i=0;i<points.length;i++){
      const p=points[i];ctx.beginPath();ctx.arc(p.x,p.y,selected?3:2,0,Math.PI*2);ctx.fillStyle=dotBg;ctx.fill();ctx.strokeStyle=color;ctx.stroke();
      if(o.labels&&selected){
        const neighbor=points[i===0?1:i-1],offset=p.y<neighbor.y?-13:13;
        const label=pattern.points[i].label;
        ctx.textAlign='center';ctx.fillStyle=s?.canvasLabelText??'#c3d1df';ctx.fillText(translateCanonical(pattern.family==='huzi-head-shoulders'?shoulderLabels[label]??label:label),p.x,p.y+offset);
      }
    }
    if(selected&&!huzi){
      ctx.globalAlpha=opacity*.55;ctx.setLineDash([2,3]);ctx.beginPath();ctx.moveTo(confirmation.x,Math.min(last.y-18,box.bottom-15));ctx.lineTo(confirmation.x,Math.max(last.y+18,box.top+15));ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=opacity;
    }
    // The event belongs to the actual closed candle, never to the earlier E/R
    // pivot. Short labels and distinct glyphs keep multiple structures readable.
    for(const event of events){
      const p=event.pixel;if(p.x<box.left||p.x>box.right||p.y<box.top||p.y>box.bottom)continue;
      const rawEventColor=event.kind==='failed-breakout'?'#d1aa65':event.kind==='invalidation'?'#a5aeba':color;
      const eventColor=s?readableSurfaceColor(rawEventColor,s.surfaceSolid,4.5):rawEventColor;
      ctx.strokeStyle=eventColor;ctx.fillStyle=labelBg;ctx.lineWidth=1.5;ctx.setLineDash([]);
      ctx.beginPath();
      if(event.kind==='breakout'){ctx.moveTo(p.x,p.y-5);ctx.lineTo(p.x+5,p.y);ctx.lineTo(p.x,p.y+5);ctx.lineTo(p.x-5,p.y);ctx.closePath();}
      else if(event.kind==='retest')ctx.rect(p.x-4,p.y-4,8,8);
      else{ctx.moveTo(p.x-4,p.y-4);ctx.lineTo(p.x+4,p.y+4);ctx.moveTo(p.x+4,p.y-4);ctx.lineTo(p.x-4,p.y+4);}
      ctx.fill();ctx.stroke();segments.push([{x:p.x-5,y:p.y},{x:p.x+5,y:p.y}]);
      if(selected&&o.labels){
        const text=translate(event.kind==='breakout'?'突破':event.kind==='retest'?(pattern.direction==='bullish'?'回踩':'反抽'):event.kind==='failed-breakout'?'收回':'失效');
        const width=ctx.measureText(text).width+8,left=Math.max(box.left+2,Math.min(p.x+9,box.right-width-2)),top=Math.max(box.top+2,Math.min(p.y-21,box.bottom-20));
        const rect={left,right:left+width,top,bottom:top+18};
        if(!o.occupied.some(b=>overlap(b,rect))){ctx.fillStyle=labelBg;ctx.fillRect(left,top,width,18);ctx.fillStyle=eventColor;ctx.textAlign='left';ctx.fillText(text,left+4,top+9);o.occupied.push(rect);}
      }
    }
    if(resolution&&resolution.x>=box.left&&resolution.x<=box.right&&resolution.y>=box.top&&resolution.y<=box.bottom){
      const resColor=s?readableSurfaceColor('#8faec0',s.surfaceSolid,4.5):'#8faec0';
      ctx.strokeStyle=resColor;ctx.fillStyle=labelBg;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(resolution.x,resolution.y,4,0,Math.PI*2);ctx.fill();ctx.stroke();
      segments.push([{x:resolution.x-5,y:resolution.y},{x:resolution.x+5,y:resolution.y}]);
      if(selected&&o.labels){ctx.fillStyle=resColor;ctx.textAlign='left';ctx.fillText(translate('参考位已到'),Math.min(resolution.x+8,box.right-65),resolution.y-10);}
    }
    let hitBounds={left:last.x-7,right:last.x+7,top:last.y-7,bottom:last.y+7};
    if(o.labels){
      const title=translateCanonical(patternChartLabel({...pattern,name:translateCanonical(pattern.name)},selected));
      const width=Math.min(box.right-box.left-8,ctx.measureText(title).width+14),height=22;
      const side=pattern.direction==='bullish'?1:-1;
      const label=placeOverlayLabel(last,width,height,box,o.occupied,side);
      if(label){
        ctx.fillStyle=labelBg;ctx.fillRect(label.left,label.top,width,height);ctx.strokeStyle=color;ctx.lineWidth=selected?2:1;ctx.strokeRect(label.left+.5,label.top+.5,width-1,height-1);
        ctx.fillStyle=color;ctx.textAlign='left';ctx.fillText(title,label.left+7,label.top+height/2);o.occupied.push(label);hitBounds=label;
        ctx.globalAlpha=opacity*.6;ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(Math.max(label.left,Math.min(last.x,label.right)),Math.max(label.top,Math.min(last.y,label.bottom)));ctx.stroke();ctx.globalAlpha=opacity;
      }
    }
    hits.push({instanceId:o.instanceId,pattern,bounds:hitBounds,clipBounds:box,segments});
  }
  ctx.restore();return hits;
}

export function hitPattern<T extends {bounds:Bounds;clipBounds?:Bounds;segments:[Pixel,Pixel][]}>(hits:readonly T[],point:Pixel,radius=5):T|undefined {
  return [...hits].reverse().find(hit=>{
    const clip=hit.clipBounds;if(clip&&(point.x<clip.left||point.x>clip.right||point.y<clip.top||point.y>clip.bottom))return false;
    const b=hit.bounds;if(point.x>=b.left&&point.x<=b.right&&point.y>=b.top&&point.y<=b.bottom)return true;
    return hit.segments.some(([a,b])=>{
      const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
      const t=length?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length)):0;
      return Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy)<=radius;
    });
  });
}
