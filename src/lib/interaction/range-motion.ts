export interface MotionRange { min:number;max:number }

/** Short finite transitions. Retargeting starts at the currently displayed value,
 * so a new wheel event or user action never jumps back to an earlier frame. */
export class RangeMotion {
  value:MotionRange;
  target:MotionRange;
  private origin:MotionRange;
  private started=0;
  private duration=0;
  constructor(value:MotionRange){this.value={...value};this.target={...value};this.origin={...value};}
  get active():boolean{return this.duration>0;}
  snap(value:MotionRange):void {this.value={...value};this.target={...value};this.origin={...value};this.duration=0;}
  set(target:MotionRange,now:number,duration:number):void {
    if(target.min===this.target.min&&target.max===this.target.max)return;
    this.step(now);this.origin={...this.value};this.target={...target};this.started=now;this.duration=Math.max(0,duration);
    if(!this.duration)this.snap(target);
  }
  step(now:number):MotionRange {
    if(!this.duration)return this.value;
    const progress=Math.max(0,Math.min(1,(now-this.started)/this.duration)),ease=1-(1-progress)**3;
    this.value={min:this.origin.min+(this.target.min-this.origin.min)*ease,max:this.origin.max+(this.target.max-this.origin.max)*ease};
    if(progress===1)this.snap(this.target);
    return this.value;
  }
}
