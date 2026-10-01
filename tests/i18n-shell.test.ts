import {afterEach,describe,expect,it,vi} from 'vitest';
import {build} from 'esbuild';
import {compile} from 'svelte/compiler';
import {readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {commandSearchText,contextMenuLabel} from '../src/lib/ui/context-menu';
import {translate} from '../src/lib/i18n';
import {SHORTCUT_GROUPS,shortcutKeyLabel} from '../src/lib/ui/shortcuts';
import {defaultWorkspaceLayout} from '../src/lib/workspace/layout';

afterEach(()=>vi.unstubAllGlobals());
const english=(value:string)=>translate(value,undefined,'en-US');
describe('shell locale presentation and search',()=>{
  it('searches both canonical and localized labels without rewriting command IDs or custom names',()=>{
    const command={id:'workspace-layout',label:'工作区布局',keywords:'布局 dock'};
    const text=commandSearchText(command,english);
    expect(text).toContain('workspace layout');expect(text).toContain('工作区布局');expect(text).toContain('dock');
    expect(contextMenuLabel({label:'保存'},english)).toBe('Save');
    expect(contextMenuLabel({label:'保存',literalLabel:true},english)).toBe('保存');
    expect(commandSearchText({id:'user',label:'保存',literalLabel:true},english)).not.toContain('save');
    expect(command.label).toBe('工作区布局');expect(command.id).toBe('workspace-layout');
  });

  it('covers every built-in shortcut instruction while preserving actual chords',()=>{
    const before=JSON.stringify(SHORTCUT_GROUPS);
    for(const group of SHORTCUT_GROUPS){
      expect(english(group.title)).not.toMatch(/[\u3400-\u9fff]/);expect(english(group.context)).not.toMatch(/[\u3400-\u9fff]/);
      for(const item of group.shortcuts){expect(english(item.label)).not.toMatch(/[\u3400-\u9fff]/);if(item.note)expect(english(item.note)).not.toMatch(/[\u3400-\u9fff]/);for(const chord of item.keys)for(const key of chord)expect(english(shortcutKeyLabel(key,true))).not.toMatch(/[\u3400-\u9fff]/);}
    }
    expect(JSON.stringify(SHORTCUT_GROUPS)).toBe(before);expect(shortcutKeyLabel('Mod',true)).toBe('⌘');expect(shortcutKeyLabel('Mod',false)).toBe('Ctrl');
  });

  it('renders layout, menu, storage and shortcut surfaces in English, preserving a user layout named 保存',async()=>{
    vi.stubGlobal('innerHeight',1000);
    const directory=decodeURIComponent(new URL('../src/',import.meta.url).pathname);
    const entry="import Layout from './components/layout/LayoutSettings.svelte';import Dock from './components/layout/WorkspaceDock.svelte';import Storage from './components/layout/StorageInfo.svelte';import Keyboard from './components/KeyboardShortcuts.svelte';import Menu from './components/ui/ContextMenu.svelte';import Commands from './components/ui/CommandPalette.svelte';import{render}from'svelte/server';import{locale}from'./lib/i18n';const components={Layout,Dock,Storage,Keyboard,Menu,Commands};export const draw=(name,props,language='en-US')=>{locale.set(language);return render(components[name],{props}).body};";
    const result=await build({stdin:{contents:entry,resolveDir:directory},bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'shell-i18n-ssr',setup(builder){builder.onLoad({filter:/\.svelte$/},async args=>({contents:compile(await readFile(args.path,'utf8'),{filename:args.path,generate:'server'}).js.code,loader:'js',resolveDir:dirname(args.path)}));}}]});
    const {draw}=await import(/* @vite-ignore */ 'data:text/javascript,'+encodeURIComponent(result.outputFiles[0].text));
    const noop=()=>{},layout=defaultWorkspaceLayout(),definitions=[{id:'watchlist',title:'自选',icon:'watchlist'},{id:'objects',title:'对象树',icon:'layers'},{id:'data',title:'数据',icon:'data'}],registry={list:()=>definitions,get:(id:string)=>definitions.find(d=>d.id===id)};
    const named=[{id:'named',name:'保存',layout}],store={namedLayouts:named,canUndo:false,canRedo:false,error:''};
    const layouts=draw('Layout',{layout,store,registry,onClose:noop,onMove:noop});
    expect(layouts).toContain('My layouts');expect(layouts).toContain('value="named">保存');expect(layouts).toContain('value="hidden"');expect(layouts).toContain('value="right"');
    expect(draw('Layout',{layout,store,registry,onClose:noop,onMove:noop},'zh-CN')).toContain('我的布局');expect(named[0].name).toBe('保存');
    const menu=draw('Menu',{x:0,y:0,label:'更多',items:[{id:'builtin',label:'保存'},{id:'custom',label:'保存',literalLabel:true}],onClose:noop});
    expect(menu).toContain('title="Save"');expect(menu).toContain('title="保存"');expect(menu).toContain('data-menu-item="custom"');
    const keyboard=draw('Keyboard',{onClose:noop});expect(keyboard).toContain('Keyboard shortcuts');
    const storage=draw('Storage',{onClose:noop});expect(storage).toContain('market.sqlite');expect(storage).toContain('depth-samples.sqlite');expect(storage).not.toMatch(/Pine|backtest|script-workspace/i);
    const commands=draw('Commands',{commands:[{id:'layout',label:'工作区布局',run:noop}],onClose:noop});expect(commands).toContain('Workspace layout');
    const dock=draw('Dock',{layout,registry,children:noop,onOpenPanel:noop,onCloseZone:noop,onResize:noop,onResizeEnd:noop,onMovePanel:noop,onSettings:noop});
    expect(dock).toContain('workspace-tab-watchlist');expect(dock).toContain('Drag to the left, right or bottom');expect(dock).toContain('aria-selected="true"');
    for(const html of [layouts,keyboard,storage,commands,dock]){
      const visible=html.replace(/<style[\s\S]*?<\/style>/g,'').replace(/<[^>]*>/g,'').replaceAll('保存','');expect(visible).not.toMatch(/[\u3400-\u9fff]/);
    }
  });
});
