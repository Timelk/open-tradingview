interface Point {x:number;y:number}
interface Box {left:number;right:number;top:number;bottom:number}
const overlaps=(a:Box,b:Box)=>a.left<b.right+3&&a.right>b.left-3&&a.top<b.bottom+3&&a.bottom>b.top-3;

/** Exact collision queries for dense annotation layers. The spatial buckets
 * only narrow candidates; the same padded rectangle test decides placement. */
export class OverlayLabelOccupancy {
  private cells=new Map<string,Box[]>();
  private large:Box[]=[];
  constructor(occupied:readonly Box[],private cellSize=64){for(const box of occupied)this.add(box);}
  private range(box:Box,padding=0){return {left:Math.floor((box.left-padding)/this.cellSize),right:Math.floor((box.right+padding)/this.cellSize),top:Math.floor((box.top-padding)/this.cellSize),bottom:Math.floor((box.bottom+padding)/this.cellSize)};}
  add(box:Box):void {
    if(![box.left,box.right,box.top,box.bottom].every(Number.isFinite))return;
    const cells=this.range(box,3);
    if((cells.right-cells.left+1)*(cells.bottom-cells.top+1)>4096){this.large.push(box);return;}
    for(let y=cells.top;y<=cells.bottom;y++)for(let x=cells.left;x<=cells.right;x++){
      const key=`${x}:${y}`,items=this.cells.get(key);if(items)items.push(box);else this.cells.set(key,[box]);
    }
  }
  collides(box:Box):boolean {
    if(this.large.some(existing=>overlaps(existing,box)))return true;
    const cells=this.range(box);
    for(let y=cells.top;y<=cells.bottom;y++)for(let x=cells.left;x<=cells.right;x++)
      if(this.cells.get(`${x}:${y}`)?.some(existing=>overlaps(existing,box)))return true;
    return false;
  }
}
/** Try the preferred side, then the opposite side. At a pane edge, clamping
 * every candidate to the same row must not make another label disappear. */
export function placeOverlayLabel(anchor:Point,width:number,height:number,bounds:Box,occupied:readonly Box[],preferred:1|-1,collision?:(box:Box)=>boolean):Box|undefined {
  if(width<=0||height<=0||bounds.right-bounds.left<width+8||bounds.bottom-bounds.top<height+6)return;
  const left=Math.max(bounds.left+4,Math.min(anchor.x-width/2,bounds.right-width-4));
  const marker={left:anchor.x-5,right:anchor.x+5,top:anchor.y-5,bottom:anchor.y+5};
  for(const side of [preferred,-preferred])for(let level=0;level<4;level++){
    const top=Math.max(bounds.top+3,Math.min(anchor.y+side*(19+level*(height+3))-(side<0?height:0),bounds.bottom-height-3));
    const rect={left,right:left+width,top,bottom:top+height};
    if(overlaps(rect,marker)||(collision?collision(rect):occupied.some(box=>overlaps(box,rect))))continue;
    return rect;
  }
}
