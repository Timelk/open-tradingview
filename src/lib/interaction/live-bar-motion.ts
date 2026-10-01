import type { BarInput } from '../core/types';

/** A display-only envelope between received ticks. Raw OHLCV and indicators
 * are never written from these interpolated coordinates. */
export class LiveBarMotion {
  private target:BarInput|null=null;
  private origin:BarInput|null=null;
  private started=0;
  private duration=0;
  private originReveal=1;
  get active():boolean{return this.duration>0;}
  get time():number|null{return this.target?.time??null;}
  snap(bar:BarInput):void{this.target={...bar};this.origin={...bar};this.duration=0;this.originReveal=1;}
  update(bar:BarInput,now:number,duration=90):void {
    if(!this.target||duration<=0){this.snap(bar);return;}
    const current=this.peek(now)!,entering=bar.time!==this.target.time;
    this.origin=entering?{...bar,high:bar.open,low:bar.open,close:bar.open,volume:0}:{...current.bar};
    this.originReveal=entering?.35:current.reveal;
    this.target={...bar};this.started=now;this.duration=duration;
  }
  /** Diagnostics may inspect a future endpoint without consuming its paint. */
  peek(now:number):{bar:BarInput;reveal:number}|null {
    if(!this.target||!this.origin)return null;
    if(!this.duration||now-this.started>=this.duration)return {bar:{...this.target},reveal:1};
    const t=Math.max(0,Math.min(1,(now-this.started)/this.duration)),ease=1-(1-t)**3;
    const lerp=(key:'high'|'low'|'close'|'volume')=>this.origin![key]+(this.target![key]-this.origin![key])*ease;
    const close=lerp('close');
    const bar={...this.target,close,high:Math.max(this.target.open,close,lerp('high')),low:Math.min(this.target.open,close,lerp('low')),volume:lerp('volume')};
    return {bar,reveal:this.originReveal+(1-this.originReveal)*ease};
  }
  sample(now:number):{bar:BarInput;reveal:number}|null {
    const result=this.peek(now);
    if(this.duration>0&&now-this.started>=this.duration){this.duration=0;this.originReveal=1;}
    return result;
  }
  finish():void{if(this.target)this.snap(this.target);}
  clear():void{this.target=null;this.origin=null;this.duration=0;this.originReveal=1;}
}
