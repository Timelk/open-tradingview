/** A transform-only active indicator shared by stable tab strips. */
export function tabs(node:HTMLElement){
  const line=document.createElement('i');line.className='ui-tab-indicator';line.setAttribute('aria-hidden','true');node.append(line);let frame=0;
  const draw=()=>{frame=0;const active=node.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');if(!active)return;line.style.transform=`translateX(${active.offsetLeft}px) scaleX(${active.offsetWidth})`;};
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(draw);};
  const resize=new ResizeObserver(schedule),mutation=new MutationObserver(schedule);resize.observe(node);mutation.observe(node,{subtree:true,attributes:true,attributeFilter:['aria-selected'],childList:true});schedule();
  return {destroy(){cancelAnimationFrame(frame);resize.disconnect();mutation.disconnect();line.remove();}};
}
export function tabKeys(event:KeyboardEvent){
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||event.altKey||event.metaKey||event.ctrlKey)return;
  const root=event.currentTarget as HTMLElement,items=Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')),index=items.indexOf(document.activeElement as HTMLButtonElement);if(index<0||!items.length)return;
  event.preventDefault();event.stopPropagation();const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowRight'?1:-1)+items.length)%items.length;items[next].focus();items[next].click();items[next].scrollIntoView({block:'nearest',inline:'nearest'});
}
