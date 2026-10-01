export interface ToolbarBounds { left:number;right:number;top:number;bottom:number }
export interface ToolbarSize { width:number;height:number }
export interface ToolbarAnchor { x:number;y:number;bounds?:ToolbarBounds }
export interface ToolbarPosition { x:number;y:number }

const overlap=(a:ToolbarBounds,b:ToolbarBounds)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));

/** Position on selection/release only. Keep the drawing and its handles clear;
 * when it fills the viewport, preserve a clear grab point around the pointer. */
export function positionDrawingToolbar(anchor:ToolbarAnchor,size:ToolbarSize,container:ToolbarSize):ToolbarPosition {
  const gap=16,handleSpace=10,pointerSpace=14;
  // Leave room for chart headings, axes and bottom navigation.
  const minX=8,minY=26,maxX=Math.max(minX,container.width-size.width-88),maxY=Math.max(minY,container.height-size.height-32);
  const clampX=(x:number)=>Math.max(minX,Math.min(x,maxX)),clampY=(y:number)=>Math.max(minY,Math.min(y,maxY));
  const raw=anchor.bounds&&Object.values(anchor.bounds).every(Number.isFinite)?anchor.bounds:{left:anchor.x,right:anchor.x,top:anchor.y,bottom:anchor.y};
  const bounds={left:Math.min(raw.left,raw.right),right:Math.max(raw.left,raw.right),top:Math.min(raw.top,raw.bottom),bottom:Math.max(raw.top,raw.bottom)};
  const body={left:bounds.left-handleSpace,right:bounds.right+handleSpace,top:bounds.top-handleSpace,bottom:bounds.bottom+handleSpace};
  const pointer={left:anchor.x-pointerSpace,right:anchor.x+pointerSpace,top:anchor.y-pointerSpace,bottom:anchor.y+pointerSpace};
  const rect=(p:ToolbarPosition):ToolbarBounds=>({left:p.x,right:p.x+size.width,top:p.y,bottom:p.y+size.height});
  const centeredX=clampX(anchor.x-size.width/2),centeredY=clampY(anchor.y-size.height/2);
  const preferred:ToolbarPosition[]=[
    {x:centeredX,y:bounds.top-gap-size.height},
    {x:centeredX,y:bounds.bottom+gap},
    {x:bounds.left-gap-size.width,y:centeredY},
    {x:bounds.right+gap,y:centeredY},
  ];
  const clear=preferred.find(p=>p.x>=minX&&p.x<=maxX&&p.y>=minY&&p.y<=maxY&&overlap(rect(p),body)===0&&overlap(rect(p),pointer)===0);
  if(clear)return clear;

  const candidates=[...preferred.map(p=>({x:clampX(p.x),y:clampY(p.y)})),
    {x:minX,y:minY},{x:maxX,y:minY},{x:minX,y:maxY},{x:maxX,y:maxY},
    {x:centeredX,y:minY},{x:centeredX,y:maxY},{x:minX,y:centeredY},{x:maxX,y:centeredY},
  ];
  const score=(p:ToolbarPosition)=>[
    overlap(rect(p),pointer)>0?1:0,
    overlap(rect(p),body),
    (p.x+size.width/2-anchor.x)**2+(p.y+size.height/2-anchor.y)**2,
  ];
  return candidates.reduce((best,p)=>{
    const a=score(p),b=score(best);
    for(let i=0;i<a.length;i++){if(a[i]<b[i])return p;if(a[i]>b[i])return best;}
    return best;
  });
}
