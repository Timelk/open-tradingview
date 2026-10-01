// Isolated DEV browser only. Compare the old copy path with the new overlay path
// using the same scene, viewport path, and controlled 100 ms live ticks.
(async()=>{
  const c=window.__chart,r=c.renderer;
  if(c.state.source!=='mock')throw new Error('Mock feed required');
  if(!c.state.paused)c.togglePause();c.setSmoothMotion(true);c.followLatest();c.finishMotion();c.draw();
  const bar=c.barAt(c.store.length-1),base=c.viewport.from,span=c.viewport.span;
  const begin=r.begin,copy=r.ctx.drawImage;let copies=0;
  r.ctx.drawImage=function(...args){copies++;return copy.apply(this,args);};
  const phase=forceCopy=>new Promise(resolve=>{
    r.begin=function(bg,needsComposition,overlayVisible){return begin.call(this,bg,forceCopy&&overlayVisible?true:needsComposition,overlayVisible);};
    c.acceptBar({...bar,isNew:false});c.finishMotion();c.viewport.from=base;c.viewport.to=base+span;c.draw();
    let start,last,tick=-1;const frames=[];copies=0;
    const frame=now=>{
      start??=now;const elapsed=now-start;
      if(last!==undefined)frames.push(now-last);last=now;
      const bucket=Math.floor(elapsed/100);
      if(bucket!==tick){tick=bucket;const close=bar.close+Math.sin(bucket*.5)*4;c.acceptBar({...bar,close,high:Math.max(bar.high,close),low:Math.min(bar.low,close),isNew:false});}
      c.viewport.from=base+Math.sin(elapsed/400)*15;c.viewport.to=c.viewport.from+span;c.dirty=true;
      if(elapsed<4000)requestAnimationFrame(frame);
      else {const ordered=[...frames].sort((a,b)=>a-b);resolve({fps:frames.length*1000/elapsed,frameP95Ms:ordered[Math.floor((ordered.length-1)*.95)],slowFrames:frames.filter(ms=>ms>25).length,frames:frames.length,durationMs:elapsed,gpuCopies:copies});}
    };
    requestAnimationFrame(frame);
  });
  try{
    const before=await phase(true),after=await phase(false);
    return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},total:c.store.length,drawings:c.drawing.document.drawings.length,indicators:c.drawing.document.indicators.length,before,after};
  }finally{r.begin=begin;r.ctx.drawImage=copy;await c.setMarket('mock',c.state.symbol,c.state.interval);}
})()
