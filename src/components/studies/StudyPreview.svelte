<script lang="ts">
  import {onDestroy} from 'svelte';
  import type {StudyPreviewData} from '../../lib/studies/preview';
  import {prefersReducedMotion} from '../../lib/ui/motion';

  /** Canvas preview of a study over the chart's recent candles. */
  let {data,height=176}:{data:StudyPreviewData;height?:number}=$props();
  let canvas=$state<HTMLCanvasElement>(),width=$state(300),frame=0;

  $effect(()=>{
    if(!canvas)return;const node=canvas.parentElement!;
    const observer=new ResizeObserver(()=>{width=Math.max(160,node.clientWidth);});
    observer.observe(node);return()=>observer.disconnect();
  });
  // Re-run the reveal whenever the study or the size changes.
  $effect(()=>{
    const current=data,w=width;if(!canvas)return;
    cancelAnimationFrame(frame);
    if(prefersReducedMotion()){paint(current,w,1);return;}
    const start=performance.now();
    const tick=(now:number)=>{const t=Math.min(1,(now-start)/420);paint(current,w,1-(1-t)**3);if(t<1)frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);
  });
  onDestroy(()=>cancelAnimationFrame(frame));

  function paint(d:StudyPreviewData,w:number,progress:number){
    const c=canvas!,dpr=window.devicePixelRatio||1;
    c.width=Math.round(w*dpr);c.height=Math.round(height*dpr);c.style.width=`${w}px`;c.style.height=`${height}px`;
    const ctx=c.getContext('2d')!;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,height);
    const css=getComputedStyle(c),up=css.getPropertyValue('--up').trim()||'#6fd0a8',down=css.getPropertyValue('--down').trim()||'#f28b90',grid=css.getPropertyValue('--line').trim()||'#2b2d34';
    const lower=d.series.filter(s=>s.pane!=='main'),hasLower=lower.length>0,gap=6;
    const priceH=hasLower?Math.round(height*.56):height,lowerTop=priceH+gap,lowerH=height-lowerTop;
    const n=d.close.length,step=w/n,x=(i:number)=>(i+.5)*step;
    ctx.save();ctx.beginPath();ctx.rect(0,0,w*progress,height);ctx.clip();
    // Price pane: candles plus overlays sharing the price scale.
    const overlays=d.series.filter(s=>s.pane==='main');
    let min=Infinity,max=-Infinity;
    for(let i=0;i<n;i++){if(d.low[i]<min)min=d.low[i];if(d.high[i]>max)max=d.high[i];}
    for(const s of overlays)for(const v of s.values)if(Number.isFinite(v)){if(v<min)min=v;if(v>max)max=v;}
    const pad=(max-min)*.08||1,py=(v:number)=>4+(1-(v-min+pad)/(max-min+pad*2))*(priceH-8);
    ctx.strokeStyle=grid;ctx.lineWidth=1;ctx.setLineDash([2,3]);
    for(const f of [.25,.5,.75]){const y=Math.round(priceH*f)+.5;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
    ctx.setLineDash([]);
    const body=Math.max(1,step*.6);
    for(let i=0;i<n;i++){
      const o=d.open[i],h=d.high[i],l=d.low[i],cl=d.close[i];if(![o,h,l,cl].every(Number.isFinite))continue;
      const color=cl>=o?up:down;ctx.globalAlpha=overlays.length?.55:.85;ctx.fillStyle=color;
      ctx.fillRect(x(i)-.5,py(h),1,Math.max(1,py(l)-py(h)));
      ctx.fillRect(x(i)-body/2,Math.min(py(o),py(cl)),body,Math.max(1,Math.abs(py(o)-py(cl))));
    }
    ctx.globalAlpha=1;
    for(const s of overlays)line(ctx,s.values,x,py,s.color,1.6);
    // Lower pane: oscillator / volume outputs on their own scale.
    if(hasLower){
      let lo=Infinity,hi=-Infinity;
      for(const s of lower)for(const v of s.values)if(Number.isFinite(v)){if(v<lo)lo=v;if(v>hi)hi=v;}
      if(lower.some(s=>s.plot==='hist')){lo=Math.min(lo,0);hi=Math.max(hi,0);}
      const span=hi-lo||1,ly=(v:number)=>lowerTop+2+(1-(v-lo)/span)*(lowerH-4);
      ctx.strokeStyle=grid;ctx.beginPath();ctx.moveTo(0,lowerTop-gap/2+.5);ctx.lineTo(w,lowerTop-gap/2+.5);ctx.stroke();
      if(lo<0&&hi>0){ctx.setLineDash([2,3]);ctx.beginPath();ctx.moveTo(0,Math.round(ly(0))+.5);ctx.lineTo(w,Math.round(ly(0))+.5);ctx.stroke();ctx.setLineDash([]);}
      for(const s of lower.filter(s=>s.plot==='hist')){
        const zero=ly(Math.max(lo,Math.min(hi,0)));
        for(let i=0;i<n;i++){const v=s.values[i];if(!Number.isFinite(v))continue;ctx.fillStyle=s.pane==='volume'?(d.close[i]>=d.open[i]?up:down):v>=0?up:down;ctx.globalAlpha=.55;ctx.fillRect(x(i)-body/2,Math.min(zero,ly(v)),body,Math.max(1,Math.abs(zero-ly(v))));}
        ctx.globalAlpha=1;
      }
      for(const s of lower.filter(s=>s.plot==='line'))line(ctx,s.values,x,ly,s.color,1.4);
    }
    ctx.restore();
  }
  function line(ctx:CanvasRenderingContext2D,values:Float64Array,x:(i:number)=>number,y:(v:number)=>number,color:string,width:number){
    ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineJoin='round';ctx.beginPath();let open=false;
    for(let i=0;i<values.length;i++){const v=values[i];if(!Number.isFinite(v)){open=false;continue;}if(open)ctx.lineTo(x(i),y(v));else{ctx.moveTo(x(i),y(v));open=true;}}
    ctx.stroke();
  }
</script>

<div class="study-preview"><canvas bind:this={canvas} aria-hidden="true"></canvas></div>
<ul class="preview-legend" aria-label="legend">
  {#each data.series as s (s.name)}<li><i style:background={s.color}></i>{s.name}</li>{/each}
</ul>

<style>
  .study-preview{width:100%;border-radius:var(--radius-lg);overflow:hidden;background:color-mix(in srgb,var(--bg) 70%,transparent)}
  canvas{display:block}
  .preview-legend{display:flex;flex-wrap:wrap;gap:6px 12px;margin:8px 0 0;padding:0;list-style:none;font:500 11px var(--mono);color:var(--text-dim)}
  .preview-legend li{display:inline-flex;align-items:center;gap:5px}
  .preview-legend i{width:10px;height:2px;border-radius:var(--radius-xs)}
</style>
