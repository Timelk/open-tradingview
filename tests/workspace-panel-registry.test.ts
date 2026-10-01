import { describe,expect,it,vi } from 'vitest';
import { PanelRegistry } from '../src/lib/workspace/registry';
import { WorkspaceLayoutStore } from '../src/lib/workspace/layout';

describe('workspace panel registry',()=>{
  it('keeps component references and provides copied metadata in registration order',()=>{
    const registry=new PanelRegistry<()=>void>(),first=()=>{},second=()=>{};
    registry.register({id:'objects',title:'对象树',icon:'layers',component:first,defaultZone:'left'});registry.register({id:'custom:flow',title:'订单流',icon:'data',component:second});
    expect(registry.list().map(panel=>panel.id)).toEqual(['objects','custom:flow']);expect(registry.get('objects')!.component).toBe(first);expect(registry.get('missing')).toBeUndefined();
    registry.get('objects')!.title='mutated';const list=registry.list();list[0].icon='changed';list.pop();expect(registry.get('objects')!.title).toBe('对象树');expect(registry.get('objects')!.icon).toBe('layers');expect(registry.list()).toHaveLength(2);
  });
  it('notifies registration/unregistration and allows no-argument subscribers',()=>{
    const registry=new PanelRegistry<string>(),listener=vi.fn();const unsubscribe=registry.subscribe(listener);expect(listener).toHaveBeenCalledOnce();
    const remove=registry.register({id:'watchlist',title:'自选',icon:'list',component:'component'});expect(listener).toHaveBeenCalledTimes(2);remove();remove();expect(listener).toHaveBeenCalledTimes(3);
    expect(registry.get('watchlist')).toBeUndefined();unsubscribe();registry.register({id:'watchlist',title:'自选',icon:'list',component:'again'});expect(listener).toHaveBeenCalledTimes(3);
  });
  it('rejects duplicates and invalid definitions atomically',()=>{
    const registry=new PanelRegistry<string>();registry.register({id:'objects',title:'对象树',icon:'layers',component:'first'});
    expect(()=>registry.register({id:'objects',title:'Duplicate',icon:'layers',component:'second'})).toThrow();
    expect(()=>registry.register({id:'bad id',title:'Bad',icon:'layers',component:'bad'})).toThrow();expect(()=>registry.register({id:'blank',title:' ',icon:'layers',component:'bad'})).toThrow();
    expect(()=>registry.register({id:'bad-zone',title:'Bad',icon:'layers',component:'bad',defaultZone:'center' as 'left'})).toThrow();expect(registry.list()).toHaveLength(1);expect(registry.get('objects')!.component).toBe('first');
  });
  it('keeps unknown layout IDs independently of whether the plugin is installed',()=>{
    const registry=new PanelRegistry<string>(),layout=new WorkspaceLayoutStore(null);layout.openPanel('plugin:notes','left');const before=layout.snapshot;
    expect(registry.get('plugin:notes')).toBeUndefined();const remove=registry.register({id:'plugin:notes',title:'笔记',icon:'text',component:'notes',defaultZone:'bottom'});
    expect(layout.snapshot).toEqual(before);layout.openPanel('plugin:notes',registry.get('plugin:notes')!.defaultZone);expect(layout.snapshot.zones.left.active).toBe('plugin:notes');
    remove();expect(registry.get('plugin:notes')).toBeUndefined();expect(layout.snapshot.zones.left.panels).toEqual(['plugin:notes']);layout.destroy();
  });
});
it('validates plugin dock constraints and isolates mutable allowed-zone metadata',()=>{const registry=new PanelRegistry<string>(),zones:('left'|'right'|'bottom')[]=['right'];registry.register({id:'editor',title:'Editor',icon:'code',component:'editor',defaultZone:'right',allowedZones:zones,motionPolicy:'none'});zones.push('bottom');expect(registry.get('editor')?.allowedZones).toEqual(['right']);const result=registry.get('editor')!;(result.allowedZones as string[]).push('left');expect(registry.get('editor')?.allowedZones).toEqual(['right']);expect(()=>registry.register({id:'bad',title:'Bad',icon:'code',component:'bad',defaultZone:'left',allowedZones:['right']})).toThrow();});
it('carries task groups and keeps built-in panels ordered market → chart → research',async()=>{
  const registry=new PanelRegistry<string>();registry.register({id:'a',title:'A',icon:'x',component:'A',group:' market '});
  expect(registry.get('a')!.group).toBe('market');
  expect(()=>registry.register({id:'b',title:'B',icon:'x',component:'B',group:''})).toThrow();
  expect(()=>registry.register({id:'c',title:'C',icon:'x',component:'C',group:'x'.repeat(33)})).toThrow();
  const {BUILTIN_PANELS,PANEL_GROUPS}=await import('../src/lib/workspace/panel-catalog');
  const order=PANEL_GROUPS.map(group=>group.id as string),panels=BUILTIN_PANELS;
  expect(panels.every(panel=>order.includes(panel.group!))).toBe(true);
  expect(panels.map(panel=>order.indexOf(panel.group!))).toEqual([...panels.map(panel=>order.indexOf(panel.group!))].sort((a,b)=>a-b));
  expect(new Set(panels.map(panel=>panel.icon)).size).toBe(panels.length);// every rail entry has a distinct icon
});
