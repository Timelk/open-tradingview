import type { DrawingTool, ToolGroup } from './types';

export class ToolRegistry {
  private tools=new Map<string,DrawingTool>();
  private groups=new Map<string,ToolGroup>();
  private listeners=new Set<()=>void>();
  registerGroup(group:ToolGroup):void {
    if(this.groups.has(group.id))throw new Error(`Duplicate tool group: ${group.id}`);
    this.groups.set(group.id,group);this.emit();
  }
  register(tool:DrawingTool):()=>void {
    if(this.tools.has(tool.id))throw new Error(`Duplicate drawing tool: ${tool.id}`);
    if(!this.groups.has(tool.group))throw new Error(`Unknown tool group: ${tool.group}`);
    this.tools.set(tool.id,tool);this.emit();
    return ()=>{this.tools.delete(tool.id);this.emit();};
  }
  get(id:string):DrawingTool|undefined{return this.tools.get(id);}
  list():DrawingTool[]{return [...this.tools.values()].sort((a,b)=>(a.order??0)-(b.order??0));}
  listGroups():ToolGroup[]{return [...this.groups.values()].sort((a,b)=>a.order-b.order);}
  subscribe(fn:()=>void):()=>void{this.listeners.add(fn);return ()=>this.listeners.delete(fn);}
  private emit(){for(const fn of this.listeners)fn();}
}
