import type { Component } from 'svelte';
import type { Drawing, DrawingProps, DrawingTool, ToolGroup } from '../../lib/drawing/types';
import { ToolRegistry } from '../../lib/drawing/registry';
export interface ToolEditorProps { drawing:Drawing; update:(props:DrawingProps)=>void; disabled?:boolean }
export interface DrawingToolPlugin {
  definition:DrawingTool;
  group?:ToolGroup;
  Editor?:Component<ToolEditorProps>;
  Icon?:Component;
}
/** Svelte-specific extensions live in the UI adapter, never in the chart core. */
export class DrawingPluginRegistry {
  readonly core=new ToolRegistry();
  private plugins=new Map<string,DrawingToolPlugin>();
  register(plugin:DrawingToolPlugin):()=>void {
    if(plugin.group&&!this.core.listGroups().some(g=>g.id===plugin.group!.id))this.core.registerGroup(plugin.group);
    if(this.core.get(plugin.definition.id))throw new Error(`Duplicate plugin: ${plugin.definition.id}`);
    this.plugins.set(plugin.definition.id,plugin);
    try {
      const unregister=this.core.register(plugin.definition);
      return ()=>{this.plugins.delete(plugin.definition.id);unregister();};
    } catch (error) { this.plugins.delete(plugin.definition.id); throw error; }
  }
  get(id:string):DrawingToolPlugin|undefined{return this.plugins.get(id);}
}
