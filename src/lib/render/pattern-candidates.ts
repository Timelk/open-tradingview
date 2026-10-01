import {placeOverlayLabel} from './overlay-label';
import type {PatternCandidate} from '../patterns/types';
import type {PatternPaintOptions} from './patterns';
import {readableSurfaceColor} from '../chart/appearance';
import {translate,translateCanonical} from '../i18n';

type Pixel={x:number;y:number};
type Bounds={left:number;right:number;top:number;bottom:number};
export interface CandidateHit {instanceId:string;candidate:PatternCandidate;bounds:Bounds;clipBounds:Bounds;segments:[Pixel,Pixel][]}

/** Developing geometry uses observed anchors only. A price projection is a
 * dashed band, never an invented D point or a buy/sell marker. */
export function drawPatternCandidates(ctx:CanvasRenderingContext2D,candidates:readonly PatternCandidate[],o:PatternPaintOptions):CandidateHit[]{
  const hits:CandidateHit[]=[],clip=o.bounds,s=o.surface,labelBg=s?.canvasLabelBg??'#19222b',dotBg=s?.surfaceSolid??'#151718';
  ctx.save();ctx.beginPath();ctx.rect(clip.left,clip.top,clip.right-clip.left,clip.bottom-clip.top);ctx.clip();
  ctx.globalAlpha*=o.opacity??1;const alpha=ctx.globalAlpha;
  ctx.font='500 11px ui-monospace,"PingFang SC",sans-serif';ctx.textBaseline='middle';
  for(const candidate of candidates){
    const points=candidate.points.map(p=>o.project(p.time,p.value)),guides=(candidate.guides??[]).map(g=>g.points.map(p=>o.project(p.time,p.value)) as [Pixel,Pixel]);
    if(points.length<3||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))continue;
    const tail=points.at(-1)!,now=o.project(candidate.observedAt,candidate.points.at(-1)!.value);
    if(Math.max(now.x,...points.map(p=>p.x),...guides.flatMap(g=>g.map(p=>p.x)))<clip.left||points[0].x>clip.right)continue;
    const rawColor=o.color||'#98b7d8',color=s?readableSurfaceColor(rawColor,s.surfaceSolid,4.5):rawColor;
    const selected=candidate.id===o.selectedId,segments:[Pixel,Pixel][]=[];
    ctx.strokeStyle=color;ctx.lineWidth=selected?Math.max(1.5,o.width):1;ctx.setLineDash([5,4]);ctx.globalAlpha=alpha*(selected?.95:.72);
    const path=guides.length?guides:points.slice(1).map((p,i)=>[points[i],p] as [Pixel,Pixel]);
    for(const [a,b] of path){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();segments.push([a,b]);}
    if(guides.length&&selected){ctx.globalAlpha=alpha*.3;ctx.setLineDash([2,5]);ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);for(const p of points.slice(1))ctx.lineTo(p.x,p.y);ctx.stroke();}
    let labelAnchor=tail;
    if(candidate.direction==='neutral'&&guides.length>=2)labelAnchor={x:now.x,y:(guides[0][1].y+guides[1][1].y)/2};
    if(candidate.zone&&candidate.direction!=='neutral'&&(o.zones||selected)){
      const top=o.project(candidate.observedAt,candidate.zone.high).y,bottom=o.project(candidate.observedAt,candidate.zone.low).y;
      const left=Math.max(clip.left,tail.x),right=Math.min(clip.right,Math.max(now.x,tail.x)+Math.max(36,Math.min(110,o.barWidth*8)));
      if(right>left&&Number.isFinite(top)&&Number.isFinite(bottom)){
        ctx.globalAlpha=alpha*.08;ctx.fillStyle=color;ctx.fillRect(left,top,right-left,Math.max(2,bottom-top));
        ctx.globalAlpha=alpha*.8;ctx.strokeStyle=color;ctx.setLineDash([5,4]);ctx.lineWidth=1;ctx.strokeRect(left,top,right-left,Math.max(2,bottom-top));
        segments.push([{x:left,y:top},{x:right,y:top}],[{x:left,y:bottom},{x:right,y:bottom}]);
        labelAnchor={x:Math.max(left,Math.min(now.x,right)),y:(top+bottom)/2};
      }
    }
    ctx.globalAlpha=alpha;ctx.setLineDash([]);
    if(selected&&o.labels)for(let i=0;i<points.length;i++){
      const p=points[i];ctx.strokeStyle=color;ctx.fillStyle=dotBg;ctx.beginPath();ctx.arc(p.x,p.y,2.5,0,Math.PI*2);ctx.fill();ctx.stroke();
      ctx.fillStyle=s?.canvasLabelText??'#b6c9df';ctx.textAlign='center';ctx.fillText(translateCanonical(candidate.points[i].label),p.x,p.y+(p.y<points[i===0?1:i-1].y?-12:12));
    }
    let bounds={left:labelAnchor.x-5,right:labelAnchor.x+5,top:labelAnchor.y-5,bottom:labelAnchor.y+5};
    if(o.labels){
      const text=translate('观察中 · {0}{1}',{0:translateCanonical(candidate.name),1:candidate.zone&&candidate.direction!=='neutral'?' · PRZ':''}),width=Math.min(clip.right-clip.left-8,ctx.measureText(text).width+14);
      const rect=placeOverlayLabel(labelAnchor,width,21,clip,o.occupied,-1);
      if(rect){const x=rect.left,y=rect.top;
        ctx.fillStyle=labelBg;ctx.fillRect(x,y,width,21);ctx.strokeStyle=color;ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.strokeRect(x+.5,y+.5,width-1,20);ctx.setLineDash([]);
        ctx.fillStyle=s?color:'#b5cce5';ctx.textAlign='left';ctx.fillText(text,x+7,y+10.5);o.occupied.push(rect);bounds=rect;
      }
    }
    hits.push({instanceId:o.instanceId,candidate,bounds,clipBounds:clip,segments});
  }
  ctx.restore();return hits;
}
