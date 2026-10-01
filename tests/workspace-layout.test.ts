import { afterEach,describe,expect,it,vi } from 'vitest';
import { defaultWorkspaceLayout,loadWorkspaceLayout,WorkspaceLayoutStore,WORKSPACE_LAYOUT_STORAGE_KEY,DOCK_ZONES,resolveDockSizes,type WorkspaceLayout,type DockZone } from '../src/lib/workspace/layout';

function memory(initial?:string){
  const data=new Map<string,string>();if(initial!==undefined)data.set(WORKSPACE_LAYOUT_STORAGE_KEY,initial);
  return {getItem:vi.fn((key:string)=>data.get(key)??null),setItem:vi.fn((key:string,value:string)=>{data.set(key,value);}),data};
}
afterEach(()=>vi.unstubAllGlobals());

describe('workspace layout loading and snapshot boundaries',()=>{
  it('defaults to a right watchlist without sharing mutable arrays between callers',()=>{
    const a=defaultWorkspaceLayout(),b=defaultWorkspaceLayout();expect(a.zones.right).toEqual({size:320,open:true,active:'watchlist',panels:['watchlist','objects','data']});
    expect(a.zones.left.size).toBe(260);expect(a.zones.bottom.size).toBe(220);expect(a.density).toBe('compact');
    a.zones.right.panels.pop();a.hidden.push('objects');expect(b.zones.right.panels).toHaveLength(3);expect(b.hidden).toEqual([]);
  });
  it('loads pure layout preferences and never reads or writes market/scene storage',()=>{
    const doc=defaultWorkspaceLayout();doc.density='comfortable';const storage=memory(JSON.stringify(doc));
    expect(loadWorkspaceLayout(storage)).toEqual(doc);expect(storage.getItem).toHaveBeenCalledWith(WORKSPACE_LAYOUT_STORAGE_KEY);expect(storage.setItem).not.toHaveBeenCalled();
    const store=new WorkspaceLayoutStore(storage);const snapshot=store.snapshot;snapshot.zones.right.panels.length=0;snapshot.hidden.push('watchlist');
    expect(store.snapshot).toEqual(doc);expect(storage.setItem).not.toHaveBeenCalled();store.destroy();
  });
  it.each(['invalid JSON','bad version','duplicate ID','orphan active','orphan hidden','zero size','excess size','invalid density'] as const)('recovers from %s without overwriting the original saved record',kind=>{
    const doc=defaultWorkspaceLayout();let raw:string;
    if(kind==='bad version')(doc as {version:number}).version=2;
    if(kind==='duplicate ID')doc.zones.left={size:260,open:true,active:'watchlist',panels:['watchlist']};
    if(kind==='orphan active')doc.zones.right.active='missing';
    if(kind==='orphan hidden')doc.hidden=['missing'];
    if(kind==='zero size')doc.zones.right.size=0;
    if(kind==='excess size')doc.zones.bottom.size=99999;
    if(kind==='invalid density')(doc as {density:string}).density='dense';
    raw=kind==='invalid JSON'?'not-json':JSON.stringify(doc);const storage=memory(raw);
    expect(loadWorkspaceLayout(storage)).toEqual(defaultWorkspaceLayout());expect(storage.setItem).not.toHaveBeenCalled();expect(storage.data.get(WORKSPACE_LAYOUT_STORAGE_KEY)).toBe(raw);
  });
  it('retains an unknown masked plugin in its saved dock and restores that dock when opened',()=>{
    const doc=defaultWorkspaceLayout();doc.zones.left={size:410,open:false,active:null,panels:['plugin:notes']};doc.hidden=['plugin:notes'];
    const storage=memory(JSON.stringify(doc)),store=new WorkspaceLayoutStore(storage);expect(store.snapshot).toEqual(doc);
    store.openPanel('plugin:notes','bottom');expect(store.snapshot.zones.left).toEqual({size:410,open:true,active:'plugin:notes',panels:['plugin:notes']});expect(store.snapshot.hidden).toEqual([]);
    expect(store.snapshot.zones.bottom.panels).toEqual([]);store.destroy();
  });
  it('ignores retired panels in old layouts without clearing or rewriting saved preferences',()=>{
    const doc=defaultWorkspaceLayout();doc.zones.right.panels.push('pine-editor','plugin:notes');doc.zones.right.active='pine-editor';doc.zones.bottom={size:440,open:true,active:'backtest-report',panels:['backtest-report']};doc.hidden=['pine-editor'];
    const raw=JSON.stringify(doc),storage=memory(raw),store=new WorkspaceLayoutStore(storage);
    expect(store.snapshot.zones.right.panels).toEqual(['watchlist','objects','data','plugin:notes']);expect(store.snapshot.zones.right.active).toBe('watchlist');expect(store.snapshot.zones.bottom).toEqual({size:440,open:false,active:null,panels:[]});expect(store.snapshot.hidden).toEqual([]);
    expect(storage.data.get(WORKSPACE_LAYOUT_STORAGE_KEY)).toBe(raw);expect(storage.setItem).not.toHaveBeenCalled();
    expect(store.openPanel('pine-editor')).toBe(false);expect(store.openPanel('backtest-report')).toBe(false);expect(store.setPlacement('pine-editor','right')).toBe(false);store.destroy();
  });
  it('survives unavailable browser storage and read errors',()=>{
    vi.stubGlobal('localStorage',{getItem(){throw Error('denied');},setItem(){throw Error('denied');}});
    expect(loadWorkspaceLayout()).toEqual(defaultWorkspaceLayout());const store=new WorkspaceLayoutStore();expect(()=>store.setChrome({quoteHeader:false})).not.toThrow();expect(store.snapshot.quoteHeader).toBe(false);store.destroy();
  });
});

describe('independent dock operations and presets',()=>{
  it('moves each panel exactly once, falls back to a visible tab, and opens multiple docks together',()=>{
    const store=new WorkspaceLayoutStore(memory());store.setPlacement('watchlist','left');store.setPlacement('data','bottom');
    const doc=store.snapshot;expect(doc.zones.left.active).toBe('watchlist');expect(doc.zones.right.active).toBe('objects');expect(doc.zones.bottom.active).toBe('data');
    expect(DOCK_ZONES.every(zone=>doc.zones[zone].open)).toBe(true);expect(DOCK_ZONES.flatMap(zone=>doc.zones[zone].panels).sort()).toEqual(['data','objects','watchlist']);
    store.setPlacement('watchlist','left');expect(store.snapshot.zones.left.panels).toEqual(['watchlist']);store.destroy();
  });
  it('uses hidden as a reversible mask rather than deleting the panel placement',()=>{
    const store=new WorkspaceLayoutStore(memory());store.setPlacement('data','bottom');store.setPlacement('data','hidden');
    expect(store.snapshot.zones.bottom.panels).toEqual(['data']);expect(store.snapshot.hidden).toEqual(['data']);expect(store.snapshot.zones.bottom.open).toBe(false);
    store.openPanel('data');expect(store.snapshot.zones.bottom.active).toBe('data');expect(store.snapshot.zones.bottom.open).toBe(true);expect(store.snapshot.hidden).toEqual([]);
    store.setPlacement('data','hidden');store.setPlacement('data','left');expect(store.snapshot.zones.bottom.panels).toEqual([]);expect(store.snapshot.zones.left.active).toBe('data');expect(store.snapshot.hidden).toEqual([]);store.destroy();
  });
  it('toggles only the active dock and honours a new plugin default without overwriting a saved position',()=>{
    const store=new WorkspaceLayoutStore(memory());store.openPanel('plugin:study','bottom');store.togglePanel('plugin:study','left');
    expect(store.snapshot.zones.bottom.open).toBe(false);expect(store.snapshot.zones.bottom.panels).toEqual(['plugin:study']);
    store.togglePanel('plugin:study','left');expect(store.snapshot.zones.bottom.open).toBe(true);expect(store.snapshot.zones.left.panels).toEqual([]);
    store.togglePanel('objects');expect(store.snapshot.zones.right.active).toBe('objects');expect(store.snapshot.zones.bottom.open).toBe(true);store.destroy();
  });
  it('focus preserves assigned panels and sizes, while presets/reset preserve unknown plugin entries',()=>{
    const store=new WorkspaceLayoutStore(memory());store.openPanel('plugin:signals','bottom');store.setPlacement('plugin:signals','hidden');store.applyPreset('analysis');store.setSize('left',400);store.setDensity('comfortable');
    const before=store.snapshot;expect(before.zones.left.panels).toEqual([]);expect(before.zones.right.panels).toEqual(['watchlist','objects','data','patterns']);expect(before.zones.bottom.panels).toEqual(['plugin:signals']);
    store.applyPreset('focus');const focused=store.snapshot;expect(focused.drawingTools).toBe(false);expect(focused.quoteHeader).toBe(false);expect(focused.density).toBe('comfortable');
    for(const zone of DOCK_ZONES){expect(focused.zones[zone].open).toBe(false);expect(focused.zones[zone].panels).toEqual(before.zones[zone].panels);expect(focused.zones[zone].size).toBe(before.zones[zone].size);}
    store.openPanel('objects');expect(store.snapshot.zones.right.open).toBe(true);expect(store.snapshot.zones.left.open).toBe(false);
    store.applyPreset('standard');expect(store.snapshot.zones.right.panels).toEqual(['watchlist','objects','data','patterns']);expect(store.snapshot.zones.bottom.panels).toEqual(['plugin:signals']);expect(store.snapshot.density).toBe('comfortable');
    store.reset();expect(store.snapshot.density).toBe('compact');expect(store.snapshot.drawingTools).toBe(true);expect(store.snapshot.quoteHeader).toBe(true);expect(store.snapshot.hidden).toEqual(['plugin:signals']);store.destroy();
  });
  it('does not allow invalid mutations or opening an empty dock to reserve blank space',()=>{
    const storage=memory(),store=new WorkspaceLayoutStore(storage),before=store.snapshot;
    expect(store.openPanel('bad id')).toBe(false);expect(store.setPlacement('objects','center' as DockZone)).toBe(false);
    expect(store.setZoneOpen('left',true)).toBe(false);expect(store.setSize('right',NaN)).toBe(false);expect(store.setSize('right',0)).toBe(false);expect(store.setDensity('wide' as 'compact')).toBe(false);
    expect(store.snapshot).toEqual(before);expect(storage.setItem).not.toHaveBeenCalled();store.destroy();
  });
});

describe('resize previews, persistence and subscriptions',()=>{
  it('publishes resize previews without writing until save, and flushes an identical final persisted value',()=>{
    const storage=memory(),store=new WorkspaceLayoutStore(storage),seen:number[]=[];store.subscribe(doc=>seen.push(doc.zones.right.size));
    store.setSize('right',380,false);store.setSize('right',420,false);expect(storage.setItem).not.toHaveBeenCalled();expect(seen).toEqual([320,380,420]);
    expect(store.save()).toBe(true);expect(storage.setItem).toHaveBeenCalledTimes(1);expect(loadWorkspaceLayout(storage).zones.right.size).toBe(420);
    store.setSize('right',460,false);store.setSize('right',460,true);expect(loadWorkspaceLayout(storage).zones.right.size).toBe(460);expect(storage.setItem).toHaveBeenCalledTimes(2);store.destroy();
  });
  it('clamps valid out-of-bounds resize input and rejects non-finite sizes',()=>{
    const store=new WorkspaceLayoutStore(memory());store.setSize('left',1);store.setSize('right',10000);store.setSize('bottom',1);
    expect(store.snapshot.zones.left.size).toBe(180);expect(store.snapshot.zones.right.size).toBe(800);expect(store.snapshot.zones.bottom.size).toBe(120);
    expect(store.setSize('left',Infinity)).toBe(false);expect(store.snapshot.zones.left.size).toBe(180);store.destroy();
  });
  it('retains changes after write failures, allows retry, and ignores mutations after destroy',()=>{
    const storage=memory();let fail=true;const write=storage.setItem;storage.setItem=vi.fn((key,value)=>{if(fail)throw Error('quota');write(key,value);});
    const store=new WorkspaceLayoutStore(storage),listener=vi.fn();store.subscribe(listener);expect(store.setDensity('comfortable')).toBe(true);expect(store.snapshot.density).toBe('comfortable');expect(store.error).toContain('保存失败');
    fail=false;expect(store.save()).toBe(true);expect(store.error).toBe('');expect(loadWorkspaceLayout(storage).density).toBe('comfortable');
    store.destroy();const calls=listener.mock.calls.length,writes=storage.setItem.mock.calls.length;expect(store.openPanel('objects')).toBe(false);expect(store.save()).toBe(false);expect(listener).toHaveBeenCalledTimes(calls);expect(storage.setItem).toHaveBeenCalledTimes(writes);
  });
  it('isolates subscriber snapshots and supports unsubscribe',()=>{
    const store=new WorkspaceLayoutStore(memory()),seen:WorkspaceLayout[]=[];store.subscribe(snapshot=>{snapshot.zones.right.panels.length=0;});const unsubscribe=store.subscribe(snapshot=>seen.push(snapshot));
    expect(seen[0].zones.right.panels).toHaveLength(3);store.setChrome({quoteHeader:false});expect(seen).toHaveLength(2);unsubscribe();store.setChrome({drawingTools:false});expect(seen).toHaveLength(2);expect(store.snapshot.zones.right.panels).toHaveLength(3);store.destroy();
  });
});

describe('render-only dock size resolution',()=>{
  const analysis=()=>{const doc=defaultWorkspaceLayout();doc.zones.left={size:260,open:true,active:'objects',panels:['objects']};doc.zones.right.panels=['watchlist'];doc.zones.bottom={size:220,open:true,active:'data',panels:['data']};return doc;};
  it('supports three visible docks while reserving the chart minimum',()=>{
    const doc=analysis(),size=resolveDockSizes(doc,{width:1000,height:600});expect(size).toEqual({left:260,right:320,bottom:220,chartWidth:420,chartHeight:380,suppressed:[]});
    const tight=resolveDockSizes(doc,{width:700,height:300});expect(tight.left+tight.right).toBe(380);expect(tight.chartWidth).toBe(320);expect(tight.bottom).toBe(120);expect(tight.chartHeight).toBe(180);
  });
  it('does not overwrite saved preferences when a narrow window temporarily suppresses a dock',()=>{
    const doc=analysis(),before=structuredClone(doc),small=resolveDockSizes(doc,{width:600,height:250});
    expect(small.left).toBe(0);expect(small.right).toBe(280);expect(small.chartWidth).toBe(320);expect(small.bottom).toBe(0);expect(small.suppressed).toContain('left');expect(doc).toEqual(before);
    expect(resolveDockSizes(doc,{width:1400,height:900})).toMatchObject({left:260,right:320,bottom:220});
  });
  it('uses all available chart space on tiny screens and never returns negative geometry',()=>{
    const doc=analysis();expect(resolveDockSizes(doc,{width:260,height:140})).toMatchObject({left:0,right:0,bottom:0,chartWidth:260,chartHeight:140});
    expect(resolveDockSizes(doc,{width:NaN,height:-20})).toMatchObject({left:0,right:0,bottom:0,chartWidth:0,chartHeight:0});
  });
  it('respects larger chart minimums and does not allocate masked/closed docks',()=>{
    const doc=analysis();const large=resolveDockSizes(doc,{width:1000,height:600,minChartWidth:600,minChartHeight:400});expect(large.chartWidth).toBeGreaterThanOrEqual(600);expect(large.chartHeight).toBeGreaterThanOrEqual(400);
    doc.zones.left.open=false;doc.hidden=['watchlist'];expect(resolveDockSizes(doc,{width:1000,height:600})).toMatchObject({left:0,right:0,chartWidth:1000});
  });
});

describe('task layouts, history and portable snapshots',()=>{
 it('records one undo entry per completed resize gesture and clears redo after another action',()=>{const store=new WorkspaceLayoutStore(memory());store.setSize('right',360,false);store.setSize('right',410,false);store.save();expect(store.undo()).toBe(true);expect(store.snapshot.zones.right.size).toBe(320);expect(store.canUndo).toBe(false);expect(store.redo()).toBe(true);expect(store.snapshot.zones.right.size).toBe(410);store.undo();store.setDensity('comfortable');expect(store.canRedo).toBe(false);});
 it('round trips named layouts and portable files without duplicating panels or losing unknown plugins',()=>{const storage=memory(),store=new WorkspaceLayoutStore(storage);store.openPanel('custom:notes','left');store.setPlacement('custom:notes','hidden');store.applyPreset('analysis');expect(store.saveNamed('研究')).toBe(true);const named=store.namedLayouts[0];store.applyPreset('orderflow');expect(store.loadNamed(named.id)).toBe(true);expect(store.snapshot).toEqual(named.layout);const restored=new WorkspaceLayoutStore(storage);expect(restored.namedLayouts).toEqual([named]);restored.applyPreset('focus');expect(restored.importLayout(store.exportLayout())).toBe(true);expect(restored.snapshot).toEqual(store.snapshot);const before=restored.snapshot;expect(restored.importLayout('{"format":"tvchart-layout","version":99}')).toBe(false);expect(restored.snapshot).toEqual(before);expect(restored.saveNamed('研究')).toBe(false);expect(restored.removeNamed(named.id)).toBe(true);expect(new WorkspaceLayoutStore(storage).namedLayouts).toEqual([]);});
 it('keeps each registered panel only once across all task presets',()=>{const store=new WorkspaceLayoutStore(memory());for(const preset of ['analysis','orderflow','standard','focus'] as const){store.applyPreset(preset);const ids=DOCK_ZONES.flatMap(zone=>store.snapshot.zones[zone].panels);expect(new Set(ids).size).toBe(ids.length);}store.destroy();expect(store.undo()).toBe(false);expect(store.saveNamed('closed')).toBe(false);});
});
