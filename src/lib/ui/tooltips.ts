/** One delegated tooltip for dynamic Svelte controls and controller-owned pane buttons. */
export function tooltipPosition(anchor:{left:number;right:number;top:number;bottom:number},width:number,height:number,viewport:{width:number;height:number},side:'right'|'left'|'bottom'='bottom'){
 let x=side==='right'?anchor.right+8:side==='left'?anchor.left-width-8:(anchor.left+anchor.right-width)/2;
 let y=side==='bottom'?anchor.bottom+8:(anchor.top+anchor.bottom-height)/2;
 if(side==='bottom'&&y+height>viewport.height-8)y=anchor.top-height-8;
 if(side==='right'&&x+width>viewport.width-8)x=anchor.left-width-8;
 if(side==='left'&&x<8)x=anchor.right+8;
 return {x:Math.max(8,Math.min(viewport.width-width-8,x)),y:Math.max(8,Math.min(viewport.height-height-8,y))};
}
export function installTooltips(){
 const selector='button,summary,select,[role="tab"],[role="separator"],[data-tooltip]';
 const titles=new Map<HTMLElement,string>(),abort=new AbortController(),opts={signal:abort.signal};
 const tip=document.createElement('div');tip.id='workspace-tooltip';tip.className='workspace-tooltip';tip.setAttribute('role','tooltip');tip.setAttribute('popover','manual');document.body.append(tip);
 let owner:HTMLElement|null=null,timer:ReturnType<typeof setTimeout>|undefined,leave:ReturnType<typeof setTimeout>|undefined;
 function text(el:HTMLElement){return el.dataset.tooltip||titles.get(el)||el.getAttribute('aria-label')||'';}
 function prepare(root:ParentNode){const elements=[...(root instanceof HTMLElement&&root.matches(selector+'[title]')?[root]:[]),...root.querySelectorAll<HTMLElement>('[title]')];for(const el of elements){if(!el.matches(selector))continue;const value=el.getAttribute('title');if(value){titles.set(el,value);el.removeAttribute('title');}}}
 function clear(){clearTimeout(timer);clearTimeout(leave);timer=leave=undefined;}
 function hide(){clear();if(owner){const ids=(owner.getAttribute('aria-describedby')??'').split(/\s+/).filter(id=>id&&id!==tip.id);if(ids.length)owner.setAttribute('aria-describedby',ids.join(' '));else owner.removeAttribute('aria-describedby');}owner=null;if(tip.matches(':popover-open'))tip.hidePopover();tip.style.display='none';}
 function show(el:HTMLElement){
  if(el.matches('.tool-main[aria-expanded="true"]')||!el.isConnected||el.closest('[inert],[hidden]')||el.closest('dialog:not([open])')||!el.getClientRects().length){hide();return;}
  const content=text(el);if(!content){hide();return;}tip.textContent=content;tip.style.display='block';if(!tip.matches(':popover-open'))tip.showPopover();
  const side=el.closest('.drawing-rail')?'right':el.closest('.right-rail')?'left':'bottom',p=tooltipPosition(el.getBoundingClientRect(),tip.offsetWidth,tip.offsetHeight,{width:innerWidth,height:innerHeight},side);
  tip.style.left=p.x+'px';tip.style.top=p.y+'px';const ids=new Set((el.getAttribute('aria-describedby')??'').split(/\s+/).filter(Boolean));ids.add(tip.id);el.setAttribute('aria-describedby',[...ids].join(' '));
 }
 function enter(el:HTMLElement,delay:number){if(owner===el){clearTimeout(leave);return;}hide();prepare(el);if(!text(el))return;owner=el;timer=setTimeout(()=>{timer=undefined;if(owner===el)show(el);},delay);}
 function target(event:Event){return event.target instanceof Element?event.target.closest<HTMLElement>(selector):null;}
 prepare(document);
 document.addEventListener('pointerover',e=>{if(e.pointerType==='touch'||e.buttons)return;if(tip.contains(e.target as Node)){clearTimeout(leave);return;}const el=target(e);if(el)enter(el,360);},opts);
 document.addEventListener('pointerout',e=>{if(!owner)return;const next=e.relatedTarget;if(next instanceof Node&&(owner.contains(next)||tip.contains(next)))return;clearTimeout(leave);leave=setTimeout(hide,120);},opts);
 document.addEventListener('focusin',e=>{const el=target(e);if(el?.matches(':focus-visible'))enter(el,100);},opts);
 document.addEventListener('focusout',hide,opts);
 document.addEventListener('pointerdown',hide,{...opts,capture:true});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&owner){const visible=tip.matches(':popover-open');hide();if(visible){e.preventDefault();e.stopPropagation();}}},{...opts,capture:true});
 document.addEventListener('scroll',hide,{...opts,capture:true});window.addEventListener('resize',hide,opts);window.addEventListener('blur',hide,opts);
 const observer=new MutationObserver(records=>{for(const record of records){if(record.target===tip||tip.contains(record.target))continue;if(record.type==='attributes'&&['title','data-tooltip','aria-label'].includes(record.attributeName??'')){if(record.attributeName==='title')prepare(record.target as HTMLElement);if(record.target===owner&&tip.matches(':popover-open'))show(owner!);}for(const node of record.addedNodes)if(node instanceof HTMLElement)prepare(node);}if(records.some(record=>[...record.removedNodes].some(node=>node instanceof HTMLElement)))for(const el of titles.keys())if(!el.isConnected)titles.delete(el);if(owner&&(!owner.isConnected||owner.closest('[inert],[hidden],dialog:not([open])')))hide();});
 observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['title','data-tooltip','aria-label','hidden','inert','open']});
 return()=>{observer.disconnect();abort.abort();hide();tip.remove();for(const [el,title] of titles)if(el.isConnected&&!el.hasAttribute('title'))el.setAttribute('title',title);titles.clear();};
}
