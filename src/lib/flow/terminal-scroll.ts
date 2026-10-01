export interface BookCenterFollower {
  update(identity:string,shape:string):void;
  resume():void;
  following():boolean;
  destroy():void;
}
export interface BookCenterDependencies {
  requestFrame?:(callback:FrameRequestCallback)=>number;
  cancelFrame?:(id:number)=>void;
  observeResize?:(element:HTMLElement,onResize:()=>void)=>(()=>void);
}

/** Keep the spread centered through actual layout changes, not every quote.
 * User scroll intent suspends following until an explicit center or view change.
 * CSS overflow-anchor:none separately prevents the browser from following a
 * surviving keyed price row while the bid/ask ladder changes around it. */
export function followBookCenter(element:HTMLElement,dependencies:BookCenterDependencies={}):BookCenterFollower {
  const request=dependencies.requestFrame??requestAnimationFrame,cancel=dependencies.cancelFrame??cancelAnimationFrame;
  let following=true,disposed=false,frame:number|undefined,identity:string|undefined,shape:string|undefined;
  const schedule=()=>{
    if(disposed||!following||frame!==undefined)return;
    frame=request(()=>{
      frame=undefined;if(disposed||!following||!element.isConnected||element.clientHeight<=0)return;
      const marker=element.querySelector<HTMLElement>('.book-mid');if(!marker)return;
      const box=element.getBoundingClientRect(),mid=marker.getBoundingClientRect(),
        wanted=element.scrollTop+mid.top+mid.height/2-box.top-element.clientHeight/2,
        next=Math.max(0,Math.min(element.scrollHeight-element.clientHeight,wanted));
      if(Math.abs(next-element.scrollTop)>.5)element.scrollTop=next;
    });
  };
  const manual=()=>{following=false;if(frame!==undefined){cancel(frame);frame=undefined;}};
  const keys=(event:Event)=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes((event as KeyboardEvent).key)){manual();event.stopPropagation();}};
  const events=['wheel','touchmove','pointerdown'] as const;
  for(const name of events)element.addEventListener(name,manual,{passive:true});
  element.addEventListener('keydown',keys);
  const observe=dependencies.observeResize??((node:HTMLElement,callback:()=>void)=>{
    const observer=new ResizeObserver(callback);observer.observe(node);return()=>observer.disconnect();
  });
  const stopObserving=observe(element,schedule);schedule();
  return {
    update(nextIdentity,nextShape){
      const changed=identity!==nextIdentity||shape!==nextShape;
      if(identity!==undefined&&identity!==nextIdentity)following=true;
      identity=nextIdentity;shape=nextShape;if(changed)schedule();
    },
    resume(){following=true;schedule();},following:()=>following,
    destroy(){disposed=true;stopObserving();if(frame!==undefined)cancel(frame);for(const name of events)element.removeEventListener(name,manual);element.removeEventListener('keydown',keys);},
  };
}
