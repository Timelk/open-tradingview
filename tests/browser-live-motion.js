// Run only in an isolated dev browser: agent-browser --session chart-drag-fix eval --stdin < tests/browser-live-motion.js
// Uses controlled ticks, then reloads the original market; never run in a user's workspace tab.
(async () => {
  const c = window.__chart;
  const source = c.state.source, symbol = c.state.symbol, interval = c.state.interval;
  if (source !== 'mock') throw new Error('This check requires the isolated mock feed');
  if (!c.state.paused) c.togglePause();
  c.setSmoothMotion(true);c.followLatest();
  const capture = duration => new Promise(resolve => {
    const start = performance.now(), frames = [];
    function frame(now) {
      const live = c.getDiagnostics().liveBar;
      frames.push({ms:now-start,close:live.bar.close,reveal:live.reveal,raw:c.store.col('close')[c.store.length-1],from:c.viewport.from,priceY:c.axes?.lastPrice?.y});
      if (now-start < duration) requestAnimationFrame(frame); else resolve(frames);
    }
    requestAnimationFrame(frame);
  });
  try {
    await capture(180);
    const prior = c.barAt(c.store.length-1), step = (c.panes[0].max-c.panes[0].min)*.04;
    const tick = {...prior,close:prior.close+step,high:Math.max(prior.high,prior.close+step)};
    c.acceptBar({...tick,isNew:false});
    const updates = await capture(150);
    const from = c.viewport.from;
    const newBar = {...tick,time:tick.time+60_000,open:tick.close,close:tick.close+step,high:tick.close+step,low:tick.close,volume:20};
    c.acceptBar({...newBar,isNew:true});
    const entry = await capture(170);
    c.setSmoothMotion(false);
    c.acceptBar({...newBar,close:newBar.open,isNew:false});
    const immediate = !c.liveBarMotion.active && c.liveBarMotion.peek(performance.now()).bar.close === newBar.open;
    const checks = {
      intermediatePrices:updates.filter(f=>f.close>prior.close&&f.close<tick.close).length,
      rawDataAlreadyExact:updates.every(f=>f.raw===tick.close),
      finalPriceExact:updates.at(-1).close===tick.close,
      distinctPriceLinePositions:new Set(updates.map(f=>f.priceY)).size,
      newCandleUnfolds:entry.some(f=>f.reveal<1)&&entry.at(-1).reveal===1,
      continuousFollow:entry.some(f=>f.from>from&&f.from<from+1)&&Math.abs(entry.at(-1).from-from-1)<1e-8,
      immediateMode:immediate,
    };
    if(checks.intermediatePrices<2||checks.distinctPriceLinePositions<2||Object.values(checks).includes(false))throw new Error(JSON.stringify(checks));
    return {checks,updates,entry};
  } finally {
    c.setSmoothMotion(true);await c.setMarket(source,symbol,interval);
  }
})()
