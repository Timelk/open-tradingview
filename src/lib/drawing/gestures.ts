import type { Anchor, GestureInput, GestureResult, ToolGesture } from './types';

/** Supports both click-click placement and dragging the first two anchors. */
export class AnchoredGesture implements ToolGesture {
  private confirmed:Anchor[]=[];
  private preview:Anchor|null=null;
  private firstPress:GestureInput|null=null;
  private done=false;
  constructor(private count=2){}
  pointer(phase:'down'|'move'|'up',input:GestureInput):GestureResult {
    if(this.done)return {points:this.confirmed,complete:true};
    // Single-anchor tools follow the pressed pointer and commit at release too.
    if(this.count===1){
      if(phase==='down'){this.firstPress=input;this.preview={...input.anchor};}
      else if(this.firstPress){
        this.preview={...input.anchor};
        if(phase==='up'){this.confirmed=[this.preview];this.preview=null;this.firstPress=null;this.done=true;}
      }
      return {points:this.done?this.confirmed:this.preview?[this.preview]:[],complete:this.done};
    }
    if(phase==='down'){
      if(!this.confirmed.length)this.firstPress=input;
      this.confirmed.push({...input.anchor});this.preview=null;
    }else if(phase==='move')this.preview={...input.anchor};
    else if(this.firstPress){
      if(Math.hypot(input.pixel.x-this.firstPress.pixel.x,input.pixel.y-this.firstPress.pixel.y)>4)this.confirmed.push({...input.anchor});
      this.firstPress=null;this.preview=null;
    }
    this.done=this.confirmed.length>=this.count;
    return {points:this.done?this.confirmed.slice(0,this.count):[...this.confirmed,...(this.preview?[this.preview]:[])],complete:this.done};
  }
}
export class FreehandGesture implements ToolGesture {
  private points:Anchor[]=[];private last:GestureInput|null=null;
  pointer(phase:'down'|'move'|'up',input:GestureInput):GestureResult {
    if(phase==='down'||phase==='up'||(this.last&&Math.hypot(input.pixel.x-this.last.pixel.x,input.pixel.y-this.last.pixel.y)>=3)){
      if(this.points.length<2048){this.points.push({...input.anchor});this.last=input;}
    }
    return {points:this.points,complete:phase==='up'};
  }
}
