// Supplement agent-browser's mouse CLI (which omits held modifiers) with trusted
// CDP input. Pass the isolated session's `agent-browser get cdp-url` as argv[2].
import { writeFile } from 'node:fs/promises';
const socket=new WebSocket(process.argv[2]);
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
let serial=0;const pending=new Map();
socket.onmessage=event=>{const response=JSON.parse(event.data);if(!response.id)return;const entry=pending.get(response.id);pending.delete(response.id);response.error?entry.reject(Error(response.error.message)):entry.resolve(response.result);};
const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
const {targetInfos}=await call('Target.getTargets');
const target=targetInfos.find(item=>item.type==='page'&&item.url==='http://127.0.0.1:5188/');
if(!target)throw Error('Open the isolated development page first');
const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
const send=(method,params)=>call(method,params,sessionId);
const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
const frame=()=>evaluate('(async()=>{for(let n=0;n<3;n++)await new Promise(requestAnimationFrame);return true;})()');
const mouse=async(type,x,y,modifiers=0)=>{await send('Input.dispatchMouseEvent',{type,x,y,modifiers,button:type==='mouseMoved'?'none':'left',buttons:type==='mousePressed'?1:type==='mouseReleased'?0:pressed?1:0,clickCount:type==='mouseMoved'?0:1});if(type!=='mouseMoved')pressed=type==='mousePressed';await frame();};
let pressed=false;
const key=async(type,name)=>{const meta=name==='Meta';await send('Input.dispatchKeyEvent',{type,key:name,code:meta?'MetaLeft':'ControlLeft',windowsVirtualKeyCode:meta?91:17,modifiers:type==='keyUp'?0:meta?4:2});await frame();};
const platform=await evaluate('navigator.platform');
const evidence={capturedAt:new Date().toISOString(),platform,method:'Isolated Chromium. CDP trusted keyboard and pointer events with explicit held modifier flags. Uses the native platform modifier; Control-click on macOS is a context-menu gesture.',runs:[]};
try{
  await evaluate(`(()=>{const c=window.__chart;if(c.state.loading)throw Error('Chart not ready');if(!c.state.paused&&c.state.source==='mock')c.togglePause();c.drawing.setMagnetMode('off');window.magnetInputLog=[];for(const type of ['keydown','keyup','pointerdown','pointermove','pointerup'])document.addEventListener(type,event=>window.magnetInputLog.push({type,key:event.key,meta:event.metaKey,ctrl:event.ctrlKey,trusted:event.isTrusted}),true);return true;})()`);
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await frame();
  for(const name of /Mac|iPhone|iPad/.test(platform)?['Meta']:['Control']){
    const mod=name==='Meta'?4:2;
    await evaluate(`window.__chart.drawing.selectTool('trend-line');true`);await frame();
    const area=await evaluate(`(()=>{const c=window.__chart,b=document.querySelector('.chart-host').getBoundingClientRect(),p=c.getDiagnostics().panes.find(p=>p.id==='main');return {left:b.left,top:b.top+p.top,width:c.viewport.plotW,height:p.height};})()`);
    const start={x:area.left+area.width*.39,y:area.top+area.height*.3},end={x:area.left+area.width*.63,y:area.top+area.height*.73};
    await mouse('mouseMoved',start.x,start.y);await key('keyDown',name);
    const first=await evaluate('window.__chart.magnetFeedback?.target?.anchor');
    await mouse('mousePressed',start.x,start.y,mod);await mouse('mouseMoved',end.x,end.y,mod);
    const last=await evaluate('window.__chart.magnetFeedback?.target?.anchor');
    await mouse('mouseReleased',end.x,end.y,mod);await key('keyUp',name);
    const created=await evaluate(`(()=>{const c=window.__chart,d=c.drawing.document.drawings.at(-1);window.magnetTestId=d.id;return {id:d.id,points:d.points,modifier:c.drawing.state.magnetModifier,effective:c.drawing.state.effectiveMagnet,feedback:c.magnetFeedback};})()`);
    const edits=[];
    for(let round=0;round<2;round++){
      const point=await evaluate(`(()=>{const c=window.__chart,d=c.drawing.document.drawings.find(d=>d.id===window.magnetTestId),b=document.querySelector('.chart-host').getBoundingClientRect(),p=c.drawingProjection(d.paneId).project(d.points[1]);return {x:b.left+p.x,y:b.top+p.y};})()`);
      const destination={x:area.left+area.width*(.68+round*.07),y:area.top+area.height*(.5+round*.2)};
      await mouse('mouseMoved',point.x,point.y);await key('keyDown',name);await mouse('mousePressed',point.x,point.y,mod);await mouse('mouseMoved',destination.x,destination.y,mod);
      const expected=await evaluate('window.__chart.magnetFeedback?.target?.anchor');
      await mouse('mouseReleased',destination.x,destination.y,mod);await key('keyUp',name);
      const points=await evaluate('window.__chart.drawing.document.drawings.find(d=>d.id===window.magnetTestId).points');
      edits.push({expected,actual:points[1],otherEndpointUnchanged:JSON.stringify(points[0])===JSON.stringify(first),matches:!!expected&&JSON.stringify(points[1])===JSON.stringify(expected)});
    }
    evidence.runs.push({key:name,first,last,created,edits,creationMatches:!!first&&!!last&&JSON.stringify(created.points)===JSON.stringify([first,last]),released:!created.modifier&&!created.effective&&created.feedback===null});
  }
  await evaluate(`window.__chart.drawing.setMagnetMode('weak');true`);await key('keyDown','Meta');
  const held=await evaluate('window.__chart.drawing.state.effectiveMagnet');await key('keyUp','Meta');
  evidence.permanentRestored=await evaluate(`({magnet:window.__chart.drawing.state.magnet,strength:window.__chart.drawing.state.magnetStrength,effective:window.__chart.drawing.state.effectiveMagnet})`);
  evidence.permanentInversion=held===false&&evidence.permanentRestored.magnet&&evidence.permanentRestored.strength==='weak'&&evidence.permanentRestored.effective;
  const input=await evaluate('window.magnetInputLog');evidence.allInputTrusted=input.every(event=>event.trusted);evidence.inputEvents=input;
  evidence.passed=evidence.allInputTrusted&&evidence.permanentInversion&&evidence.runs.every(run=>run.creationMatches&&run.released&&run.edits.every(edit=>edit.matches&&edit.otherEndpointUnchanged));
  await evaluate(`window.__chart.drawing.setMagnetMode('off');true`);
  await writeFile('docs/validation/drawing-magnet-input.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({passed:evidence.passed,runs:evidence.runs,permanentInversion:evidence.permanentInversion,allInputTrusted:evidence.allInputTrusted},null,2));
  if(!evidence.passed)process.exitCode=1;
}finally{await key('keyUp','Meta');await key('keyUp','Control');await call('Target.detachFromTarget',{sessionId});socket.close();}
