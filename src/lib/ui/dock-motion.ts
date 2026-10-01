import {motionReduced} from './motion-preferences';
let cancelCurrent:(()=>void)|undefined;
export function cancelDockMotion(){cancelCurrent?.();cancelCurrent=undefined;}
/** Animate a non-interactive title proxy; never transform a live chart or editor. */
export function animateDockMove(from:DOMRect,label:string,target:HTMLElement){
 cancelDockMotion();if(motionReduced())return;
 const ghost=document.createElement('div');ghost.textContent=label;
 ghost.style.cssText='position:fixed;pointer-events:none;z-index:70;padding:7px 12px;border:1px solid #91baf2;border-radius:0;background:#26374df0;color:#e7eef7;font:12px system-ui;box-shadow:0 8px 20px #0005';
 ghost.style.left=from.left+'px';ghost.style.top=from.top+'px';ghost.style.width=Math.min(240,Math.max(120,from.width))+'px';document.body.append(ghost);
 const abort=new AbortController();let disposed=false,animation:Animation|undefined;
 const cancel=()=>{if(disposed)return;disposed=true;abort.abort();animation?.cancel();ghost.remove();if(cancelCurrent===cancel)cancelCurrent=undefined;};cancelCurrent=cancel;
 window.addEventListener('pointerdown',cancel,{once:true,signal:abort.signal});window.addEventListener('ui-motion-change',cancel,{once:true,signal:abort.signal});
 if(!target.isConnected||typeof ghost.animate!=='function'){cancel();return;}
 const to=target.getBoundingClientRect();
 try{
  animation=ghost.animate([
   {transform:'translate(0px, 0px)',opacity:1},
   {transform:`translate(${to.left-from.left}px, ${to.top-from.top}px)`,opacity:0},
  ],{duration:220,easing:'cubic-bezier(0.215, 0.61, 0.355, 1)',fill:'forwards'});
  animation.onfinish=cancel;animation.oncancel=cancel;
 }catch{cancel();}
}
