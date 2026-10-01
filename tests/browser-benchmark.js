// Run in a loaded dev page: agent-browser --session charts-verify eval --stdin < tests/browser-benchmark.js
// Dispatches continuous zoom events and measures actual browser rAF intervals.
new Promise((resolve) => {
  const host = document.querySelector('.chart-host');
  const box = host.getBoundingClientRect();
  const before = window.__chart.getDiagnostics();
  let start = 0;
  let last = 0;
  let count = 0;
  const frames = [];
  const renders = [];
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
  function step(time) {
    if (!start) start = time;
    else frames.push(time - last);
    last = time;
    host.dispatchEvent(new WheelEvent('wheel', {
      clientX: box.x + box.width * .5,
      clientY: box.y + Math.min(130, box.height * .3),
      deltaY: count % 120 < 60 ? -4 : 4,
      bubbles: true, cancelable: true,
    }));
    count++;
    renders.push(window.__chart.getDiagnostics().renderMs);
    if (time - start < 6000) requestAnimationFrame(step);
    else {
      const after = window.__chart.getDiagnostics();
      resolve({
        timestamp: new Date().toISOString(),
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        userAgent: navigator.userAgent,
        source: before.source, total: after.total, visibleAtStart: before.visible,
        indicatorCount: new Set(after.series.map(s => s.id)).size,
        engine: after.engine, renderer: after.backend, live: !after.paused,
        durationMs: time - start, frames: frames.length,
        fps: frames.length * 1000 / (time - start),
        frameP95Ms: percentile(frames, .95), renderP95Ms: percentile(renders, .95),
        renderMaxMs: Math.max(...renders), tickP95Ms: after.tickP95,
        tickLastMs: after.tickMs, drawnCandles: after.rendered,
      });
    }
  }
  requestAnimationFrame(step);
})
