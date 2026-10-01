<script lang="ts">
  /** Minimal close-price sparkline. Direction color comes from first → last. */
  let {values,width=72,height=24,area=false,loading=false,label=''}:{values?:readonly number[];width?:number;height?:number;area?:boolean;loading?:boolean;label?:string}=$props();
  const id=`spark-${Math.random().toString(36).slice(2,9)}`;
  const geometry=$derived.by(()=>{
    if(!values||values.length<2)return undefined;
    let min=Infinity,max=-Infinity;for(const v of values){if(v<min)min=v;if(v>max)max=v;}
    const span=max-min||Math.abs(max)*1e-6||1,pad=area?4:2,h=height-pad*2;
    const points=values.map((v,i)=>[i/(values.length-1)*width,pad+(1-(v-min)/span)*h] as const);
    const line=points.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join('');
    return {line,fill:`${line}L${width} ${height}L0 ${height}Z`,up:values.at(-1)!>=values[0],last:points.at(-1)!};
  });
</script>

<svg class="sparkline" class:up={geometry?.up} class:down={geometry&&!geometry.up} class:loading={!geometry&&loading} {width} {height} viewBox={`0 0 ${width} ${height}`} role={label?'img':undefined} aria-label={label||undefined} aria-hidden={label?undefined:true}>
  {#if geometry}
    {#if area}
      <defs><linearGradient {id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".28"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
      <path d={geometry.fill} fill={`url(#${id})`} stroke="none"/>
    {/if}
    <path d={geometry.line} fill="none" stroke="currentColor" stroke-width={area?1.6:1.25} stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    {#if area}<circle cx={geometry.last[0]} cy={geometry.last[1]} r="2.5" fill="currentColor"/>{/if}
  {:else if loading}
    <rect x="0" y={height/2-1} width={width} height="2" rx="1" class="skeleton"/>
  {/if}
</svg>

<style>
  .sparkline{display:block;flex-shrink:0;color:var(--text-dim);overflow:visible}
  .sparkline.up{color:var(--up)}.sparkline.down{color:var(--down)}
  .sparkline path{transition:d 240ms cubic-bezier(.22,1,.36,1)}
  .skeleton{fill:var(--line);animation:spark-pulse 1.1s ease-in-out infinite}
  @keyframes spark-pulse{50%{opacity:.35}}
  @media(prefers-reduced-motion:reduce){.sparkline path{transition:none}.skeleton{animation:none}}
</style>
