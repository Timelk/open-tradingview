// Isolated DEV browser only, standard desktop layout. Never use the user's tab.
// 1. agent-browser --session layout-check eval --stdin < tests/browser-layout-stability.js
// 2. Focus the "调整右侧面板宽度" separator; send six ArrowLeft and six ArrowRight
//    keypresses using the browser driver (native trusted keyboard input).
// 3. agent-browser --session layout-check --json eval 'window.__layoutStabilityProbe.finish()'
// The final result contains frame samples and assertions. No readPixels calls:
// preserveDrawingBuffer=false makes reads outside rendering misleading.
(async () => {
  const c = window.__chart, host = document.querySelector('.chart-host');
  if (!c || !host || c.state.loading || c.engine.pending) throw new Error('Wait for the chart and its indicators to finish loading');
  if (document.querySelector('.dock-grid.mobile')) throw new Error('Desktop layout required');
  if (window.__layoutStabilityProbe) throw new Error('Finish or reload the prior isolated probe first');
  const frames = count => new Promise(resolve => {
    const next = () => --count > 0 ? requestAnimationFrame(next) : resolve();
    requestAnimationFrame(next);
  });
  const click = selector => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error(`Missing UI control: ${selector}`);
    element.click(); return element;
  };
  const pausedByProbe = c.state.source === 'mock' && !c.state.paused;
  if (pausedByProbe) click('button[aria-label="暂停模拟行情"]');
  click('button[aria-label="工作区布局设置"]'); await frames(2);
  click('button[aria-label="标准布局"]'); await frames(2);
  click('button[aria-label="关闭布局设置"]'); await frames(12);
  if (window.__chart !== c || document.querySelector('.chart-host') !== host) throw new Error('Standard layout replaced the chart');

  const canvases = [...host.querySelectorAll('canvas')];
  const started = performance.now(), startGeneration = c.generation;
  const initial = {width:host.clientWidth,height:host.clientHeight,from:c.viewport.from,to:c.viewport.to,generation:c.generation,source:c.state.source,symbol:c.state.symbol,interval:c.state.interval};
  const samples = [], resizes = [], bufferWrites = [], actions = [], nativeKeys = [], identityFailures = [];
  const panelNodes = new Map(), replacements = [];
  let phase = 'right-panels', serial = 0, currentFrame = null, nativeUntil = 0, finished = false;
  const restore = [];

  function inspectIdentity(frameId) {
    if (window.__chart !== c) identityFailures.push({frameId,kind:'controller'});
    if (document.querySelector('.chart-host') !== host || !host.isConnected) identityFailures.push({frameId,kind:'host'});
    const current = [...host.querySelectorAll('canvas')];
    if (current.length !== canvases.length || current.some((canvas,i)=>canvas !== canvases[i])) identityFailures.push({frameId,kind:'canvas'});
    if (c.generation !== startGeneration) identityFailures.push({frameId,kind:'market-generation',value:c.generation});
    for (const node of document.querySelectorAll('.dock-surface[data-panel]')) {
      const id = node.dataset.panel;
      if (!panelNodes.has(id)) panelNodes.set(id,node);
      else if (panelNodes.get(id) !== node) replacements.push({frameId,id});
    }
  }
  function wrap(name, replacement) {
    const own = Object.getOwnPropertyDescriptor(c,name), original = c[name];
    c[name] = replacement(original);
    restore.push(() => own ? Object.defineProperty(c,name,own) : delete c[name]);
  }
  for (const [index,canvas] of canvases.entries()) for (const property of ['width','height']) {
    const own = Object.getOwnPropertyDescriptor(canvas,property), descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,property);
    Object.defineProperty(canvas,property,{
      configurable:true, get(){return descriptor.get.call(this);},
      set(value){bufferWrites.push({frameId:currentFrame?.id??null,phase,index,property,value});descriptor.set.call(this,value);},
    });
    restore.push(() => own ? Object.defineProperty(canvas,property,own) : delete canvas[property]);
  }
  wrap('resize', original => function(...args) {
    const before = [this.width,this.height,this.dpr];
    const value = original.apply(this,args), after = [this.width,this.height,this.dpr];
    const record = {frameId:currentFrame?.id??null,phase,before,after,changed:before.some((v,i)=>v!==after[i])};
    resizes.push(record);if (currentFrame) currentFrame.resizes.push(record);
    return value;
  });
  for (const name of ['draw','drawOverlay']) wrap(name, original => function(...args) {
    const value = original.apply(this,args);
    if (currentFrame) currentFrame[name]++;
    return value;
  });
  wrap('frame', original => function(time) {
    const frame = {id:++serial,phase,ms:Number((time-started).toFixed(2)),width:host.clientWidth,height:host.clientHeight,draw:0,drawOverlay:0,resizes:[]};
    currentFrame = frame;
    try { return original.call(this,time); }
    finally {
      inspectIdentity(frame.id);
      frame.controllerWidth = this.width; frame.controllerHeight = this.height;
      frame.generation = this.generation;
      frame.backend = this.renderer.mode;
      frame.surface = this.renderer.directGPU ? this.renderer.directOverlay?'gpu-plus-drawings':'direct-gpu' : 'canvas-composition';
      if (phase === 'right-panels' || phase === 'left-tools' || performance.now() < nativeUntil || frame.resizes.length) samples.push(frame);
      currentFrame = null;
    }
  });
  const onKey = event => {
    if (!(event.target instanceof Element) || !event.target.matches('.dock-divider[aria-label="调整右侧面板宽度"]')) return;
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    phase = 'native-divider'; nativeUntil = performance.now()+350;
    nativeKeys.push({key:event.key,trusted:event.isTrusted,ms:Number((performance.now()-started).toFixed(2))});
  };
  window.addEventListener('keydown',onKey,true);restore.push(()=>window.removeEventListener('keydown',onKey,true));
  inspectIdentity(0);

  const summary = phaseName => {
    const group = samples.filter(frame=>frame.phase===phaseName), resize = resizes.filter(item=>item.phase===phaseName);
    return {frames:group.length,widths:[...new Set(group.map(frame=>frame.width))].sort((a,b)=>a-b),heights:[...new Set(group.map(frame=>frame.height))],resizeCalls:resize.length,changedResizes:resize.filter(item=>item.changed).length,drawCalls:group.reduce((sum,frame)=>sum+frame.draw,0),overlayCalls:group.reduce((sum,frame)=>sum+frame.drawOverlay,0)};
  };
  window.__layoutStabilityProbe = {
    async finish() {
      if (finished) throw new Error('Probe already finished');
      await frames(8);finished=true;
      const rightPanels=summary('right-panels'),leftTools=summary('left-tools'),nativeDivider=summary('native-divider');
      const unpaintedResizes=resizes.filter(item=>item.changed&&!samples.some(frame=>frame.id===item.frameId&&frame.draw>0&&frame.drawOverlay>0));
      const checks={
        controllerHostCanvasAndMarketStable:identityFailures.length===0,
        mountedPanelNodesStable:replacements.length===0&&['watchlist','objects','data'].every(id=>panelNodes.has(id)),
        panelSwitchWidthStable:rightPanels.widths.length===1&&rightPanels.resizeCalls===0,
        toolMenuWidthStable:leftTools.widths.length===1&&leftTools.resizeCalls===0,
        nativeKeyboardExercised:nativeKeys.length>=6&&nativeKeys.every(event=>event.trusted),
        dividerActuallyResized:nativeDivider.widths.length>1&&nativeDivider.changedResizes>0,
        everyResizeInsideFrame:resizes.every(item=>item.frameId!==null),
        everyCanvasResetInsideFrame:bufferWrites.every(item=>item.frameId!==null),
        everyResizePaintedSameFrame:unpaintedResizes.length===0,
        viewportAndHistoryUnchanged:c.viewport.from===initial.from&&c.viewport.to===initial.to&&JSON.stringify(c.drawing.document)===initialDocument,
      };
      const result={capturedAt:new Date().toISOString(),url:location.href,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},initial,passed:Object.values(checks).every(Boolean),checks,phases:{rightPanels,leftTools,nativeDivider},nativeKeys,actions,identityFailures,panelReplacements:replacements,unpaintedResizes,resizeCalls:resizes,canvasDimensionWrites:bufferWrites,frames:samples,method:'Real Chromium DOM, UI button clicks, trusted browser-driver keyboard input; controller.frame/resize/draw/drawOverlay and canvas dimension setters instrumented. No cross-frame WebGL readback; no idle FPS assertion.'};
      for(const undo of restore.reverse())undo();delete window.__layoutStabilityProbe;
      if(pausedByProbe&&c.state.paused)c.togglePause();
      return result;
    },
  };
  const initialDocument=JSON.stringify(c.drawing.document);
  for(let round=0;round<6;round++)for(const id of ['objects','data','watchlist']){
    click(`#workspace-tab-${id}`);actions.push({phase,kind:'panel-tab',id,round});await frames(4);
  }
  phase='left-tools';
  for(let round=0;round<3;round++)for(const [expand,tool] of [['展开趋势线工具','水平线'],['展开斐波那契','斐波那契回撤'],['展开几何图形','画笔']]){
    click(`button[aria-label="${expand}"]`);actions.push({phase,kind:'tool-menu',label:expand,round});await frames(4);
    click(`.tool-popup button[aria-label="${tool}"]`);actions.push({phase,kind:'select-tool',label:tool,round});await frames(4);
    click('.drawing-rail button[aria-label="十字线 / 选择"]');await frames(3);
  }
  phase='awaiting-native-input';
  document.querySelector('.dock-divider[aria-label="调整右侧面板宽度"]')?.focus();
  return {readyForNativeKeyboard:true,selector:'.dock-divider[aria-label="调整右侧面板宽度"]',instructions:'Send six ArrowLeft and six ArrowRight keypresses, then evaluate window.__layoutStabilityProbe.finish()',rightPanels:summary('right-panels'),leftTools:summary('left-tools')};
})()
