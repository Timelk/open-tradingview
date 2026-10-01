import { GLRenderer } from './gl';

/** Display GPU primitives directly beneath transparent Canvas drawings when
 * paint order allows it. Interleaved layers retain ordered run compositing. */
export class RenderBackend {
  readonly gl: GLRenderer;
  private ctx: CanvasRenderingContext2D;
  private dpr=1;
  private fallback=false;
  private clipped=false;
  private pendingGPU=false;
  private opacity=1;
  private directGPU=false;
  private directOverlay=false;
  get mode():'WebGL2'|'Canvas2D'{return this.fallback?'Canvas2D':'WebGL2';}
  constructor(private gpu:HTMLCanvasElement,private cpu:HTMLCanvasElement,onLost:()=>void,onRestored:()=>void){
    this.ctx=cpu.getContext('2d')!;
    this.gl=new GLRenderer(gpu,{
      onContextLost:()=>{this.fallback=true;this.directGPU=false;this.directOverlay=false;this.gpu.style.visibility='hidden';this.cpu.style.visibility='visible';this.pendingGPU=false;onLost();},
      onContextRestored:()=>{this.fallback=!this.gl.ok;onRestored();},
    });
    this.fallback=!this.gl.ok;
    this.gpu.style.visibility='hidden';this.cpu.style.visibility='visible';
  }
  rebuild(){this.fallback=!this.gl.reinit();}
  resize(w:number,h:number,dpr:number){
    this.clearClip();this.dpr=dpr;this.gl.resize(w,h,dpr);
    const width=Math.round(w*dpr),height=Math.round(h*dpr);
    if(this.cpu.width!==width)this.cpu.width=width;
    if(this.cpu.height!==height)this.cpu.height=height;
    this.ctx.setTransform(dpr,0,0,dpr,0,0);this.clipped=false;this.pendingGPU=false;
  }
  begin(bg:string,needsComposition=true,overlayVisible=false,gradientEnd?:string){
    this.clearClip();this.pendingGPU=false;this.opacity=1;
    const direct=!this.fallback&&!needsComposition,transparentOverlay=direct&&overlayVisible;
    if(direct!==this.directGPU||transparentOverlay!==this.directOverlay){
      this.directGPU=direct;this.directOverlay=transparentOverlay;
      this.gpu.style.visibility=direct?'visible':'hidden';this.cpu.style.visibility=direct&&!transparentOverlay?'hidden':'visible';
    }
    this.ctx.globalAlpha=1;
    if(this.directOverlay)this.ctx.clearRect(0,0,this.cpu.width/this.dpr,this.cpu.height/this.dpr);
    else if(!this.directGPU){
      if(gradientEnd&&gradientEnd!==bg){
        const gradient=this.ctx.createLinearGradient(0,0,0,this.cpu.height/this.dpr);gradient.addColorStop(0,bg);gradient.addColorStop(1,gradientEnd);this.ctx.fillStyle=gradient;
      }else this.ctx.fillStyle=bg;
      this.ctx.fillRect(0,0,this.cpu.width/this.dpr,this.cpu.height/this.dpr);
    }
    if(!this.fallback)this.gl.begin(bg,this.directGPU?1:0);
    // Keep the direct GPU path: bounded one-device-pixel strips avoid routing
    // the entire scene through Canvas just to display a background gradient.
    if(this.directGPU&&gradientEnd&&gradientEnd!==bg){
      const start=bg.slice(1).match(/../g)!.map(c=>parseInt(c,16)),end=gradientEnd.slice(1).match(/../g)!.map(c=>parseInt(c,16));
      const height=this.cpu.height,width=this.cpu.width,steps=Math.min(256,height);
      for(let i=0;i<steps;i++){
        const t=(i+.5)/steps,color='#'+start.map((c,j)=>Math.round(c+(end[j]-c)*t).toString(16).padStart(2,'0')).join('');
        this.gl.rect(0,Math.floor(i*height/steps),width,Math.ceil((i+1)*height/steps),color,1);
      }
      this.pendingGPU=true;
    }
  }
  setOpacity(opacity:number){this.opacity=opacity;}
  clip(x:number,y:number,w:number,h:number){
    this.clearClip();
    if(this.fallback){this.ctx.save();this.ctx.beginPath();this.ctx.rect(x,y,w,h);this.ctx.clip();this.clipped=true;}
    else this.gl.clip(x*this.dpr,y*this.dpr,w*this.dpr,h*this.dpr);
  }
  private clearClip(){
    if(this.clipped){this.ctx.restore();this.clipped=false;}
    if(!this.fallback)this.gl.clearClip();
  }
  private composite(){
    if(this.fallback||!this.pendingGPU||this.directGPU)return;
    this.gl.clearClip();this.ctx.globalAlpha=1;
    this.ctx.drawImage(this.gpu,0,0,this.cpu.width/this.dpr,this.cpu.height/this.dpr);
    this.gl.begin('#000000',0);this.pendingGPU=false;
  }
  canvasLayer(draw:(ctx:CanvasRenderingContext2D)=>void){
    this.clearClip();this.composite();this.ctx.save();
    draw(this.ctx);this.ctx.restore();
  }
  rect(x0:number,y0:number,x1:number,y1:number,color:string,alpha=1){
    alpha*=this.opacity;
    if(!this.fallback){this.pendingGPU=true;this.gl.rect(x0*this.dpr,y0*this.dpr,x1*this.dpr,y1*this.dpr,color,alpha);}
    else {this.ctx.fillStyle=color;this.ctx.globalAlpha=alpha;this.ctx.fillRect(x0,y0,x1-x0,y1-y0);this.ctx.globalAlpha=1;}
  }
  /** Filled rounded rectangle (CSS px radius). */
  roundRect(x0:number,y0:number,x1:number,y1:number,radius:number,color:string,alpha=1){
    alpha*=this.opacity;
    if(!this.fallback){this.pendingGPU=true;this.gl.roundRect(x0*this.dpr,y0*this.dpr,x1*this.dpr,y1*this.dpr,radius*this.dpr,color,alpha);return;}
    const c=this.ctx,r=Math.min(radius,(x1-x0)/2,(y1-y0)/2);
    c.fillStyle=color;c.globalAlpha=alpha;c.beginPath();c.roundRect(x0,y0,x1-x0,y1-y0,Math.max(0,r));c.fill();c.globalAlpha=1;
  }
  /** Rounded outline `width` CSS px wide (hollow candles, distinct borders). */
  roundRing(x0:number,y0:number,x1:number,y1:number,radius:number,width:number,color:string,alpha=1){
    alpha*=this.opacity;
    if(!this.fallback){this.pendingGPU=true;this.gl.roundRing(x0*this.dpr,y0*this.dpr,x1*this.dpr,y1*this.dpr,radius*this.dpr,width*this.dpr,color,alpha);return;}
    const c=this.ctx,r=Math.min(radius,(x1-x0)/2,(y1-y0)/2);
    c.fillStyle=color;c.globalAlpha=alpha;c.beginPath();
    c.roundRect(x0,y0,x1-x0,y1-y0,Math.max(0,r));c.roundRect(x0+width,y0+width,x1-x0-width*2,y1-y0-width*2,Math.max(0,r-width));
    c.fill('evenodd');c.globalAlpha=1;
  }
  /** Same as {@link rect} with 0..1 channels; avoids color string parsing for
   * dense palette-driven layers such as the CPU heatmap fallback. */
  rectRgb(x0:number,y0:number,x1:number,y1:number,red:number,green:number,blue:number,alpha=1){
    alpha*=this.opacity;
    if(!this.fallback){this.pendingGPU=true;this.gl.rectRgb(x0*this.dpr,y0*this.dpr,x1*this.dpr,y1*this.dpr,red,green,blue,alpha);}
    else {this.ctx.fillStyle=`rgb(${Math.round(red*255)},${Math.round(green*255)},${Math.round(blue*255)})`;this.ctx.globalAlpha=alpha;this.ctx.fillRect(x0,y0,x1-x0,y1-y0);this.ctx.globalAlpha=1;}
  }
  /** Instanced GPU heatmap (see GLRenderer.heatmap). Returns false when the
   * caller must paint cells itself (Canvas2D fallback or no WebGL2). */
  heatmap(instances:Float32Array,count:number,translateX:number,translateY:number,threshold:number,ceiling:number,opacity:number,palette:{theme:string;bytes:Uint8Array}):boolean{
    if(this.fallback)return false;
    const drawn=this.gl.heatmap(instances,count,translateX,translateY,this.dpr,threshold,ceiling,opacity*this.opacity,palette);
    if(drawn)this.pendingGPU=true;
    return drawn;
  }
  seg(x0:number,y0:number,x1:number,y1:number,color:string,alpha=1,width=1){
    alpha*=this.opacity;
    if(!this.fallback){this.pendingGPU=true;this.gl.seg(x0*this.dpr,y0*this.dpr,x1*this.dpr,y1*this.dpr,color,alpha,width*this.dpr);}
    else {const c=this.ctx;c.strokeStyle=color;c.globalAlpha=alpha;c.lineWidth=width;c.beginPath();c.moveTo(x0,y0);c.lineTo(x1,y1);c.stroke();c.globalAlpha=1;}
  }
  marker(x:number,y:number,size:number,up:boolean,color:string){
    if(!this.fallback){this.pendingGPU=true;this.gl.marker(x*this.dpr,y*this.dpr,size*this.dpr,up,color,this.opacity);}
    else {const c=this.ctx;c.globalAlpha=this.opacity;c.fillStyle=color;c.beginPath();c.moveTo(x,y);c.lineTo(x-size,y+(up?size:-size));c.lineTo(x+size,y+(up?size:-size));c.closePath();c.fill();c.globalAlpha=1;}
  }
  flush(){this.clearClip();this.composite();}
  destroy(){this.gl.destroy();}
}
