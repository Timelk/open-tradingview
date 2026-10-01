import { afterEach,describe,expect,it,vi } from 'vitest';
import { getWorkspaceShortcut,isMacShortcutPlatform,shortcutKeyLabel,WORKSPACE_SHORTCUTS,SHORTCUT_GROUPS,type ShortcutKeyEvent,type WorkspaceShortcutContext } from '../src/lib/ui/shortcuts';

const context:WorkspaceShortcutContext={editable:false,modalOpen:false,drawingBusy:false};
const key=(key:string,extra:Partial<ShortcutKeyEvent>={})=>({key,...extra});
afterEach(()=>vi.unstubAllGlobals());

describe('workspace shortcut routing',()=>{
  it('matches the advertised global actions without swallowing chart controls',()=>{
    const cases:[ShortcutKeyEvent,string][]=[
      [key('/'),'studies'],[key('?',{shiftKey:true}),'help'],[key('w',{altKey:true,code:'KeyW'}),'watchlistAdd'],
      [key(' '),'nextSymbol'],[key(' ',{shiftKey:true}),'previousSymbol'],[key('b'),'symbolSearch'],
    ];
    for(const [event,type] of cases)expect(getWorkspaceShortcut(event,context)?.type).toBe(type);
    expect(new Set(cases.map(([,type])=>type))).toEqual(new Set(WORKSPACE_SHORTCUTS.map(s=>s.id)));
    for(const name of ['Enter','Home','End','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Delete','Backspace','Escape'])expect(getWorkspaceShortcut(key(name),context)).toBeNull();
  });
  it('uses the physical W code for Mac Option+W when the produced character is ∑',()=>{
    expect(getWorkspaceShortcut(key('∑',{altKey:true,code:'KeyW'}),context)).toEqual({type:'watchlistAdd'});
    expect(getWorkspaceShortcut(key('w',{altKey:true}),context)).toEqual({type:'watchlistAdd'});
    expect(getWorkspaceShortcut(key('∑',{altKey:true,code:'KeyW',shiftKey:true}),context)).toBeNull();
  });
  it('preserves printable search text and rejects dead keys, IME text and unrelated punctuation',()=>{
    for(const character of ['b','B','9'])expect(getWorkspaceShortcut(key(character,{shiftKey:character==='B'}),context)).toEqual({type:'symbolSearch',query:character});
    for(const character of ['Process','Dead','中','é','F1','.','_'])expect(getWorkspaceShortcut(key(character),context)).toBeNull();
    expect(getWorkspaceShortcut(key('b',{keyCode:229}),context)).toBeNull();
  });
  it.each(['defaultPrevented','isComposing','repeat'] as const)('respects %s before matching any shortcut',flag=>{
    for(const event of [key('/'),key('b'),key(' '),key('w',{altKey:true})])expect(getWorkspaceShortcut({...event,[flag]:true},context)).toBeNull();
  });
  it.each(['editable','modalOpen','drawingBusy'] as const)('does not change workspace while %s is true',flag=>{
    for(const event of [key('/'),key('?'),key('b'),key(' '),key('w',{altKey:true})])expect(getWorkspaceShortcut(event,{...context,[flag]:true})).toBeNull();
  });
  it('leaves browser, native editing and drawing modifier shortcuts to their owners',()=>{
    for(const event of [key('z',{ctrlKey:true}),key('z',{metaKey:true,shiftKey:true}),key('r',{metaKey:true}),key('w',{ctrlKey:true}),key('w',{ctrlKey:true,altKey:true}),key('t',{altKey:true}),key('h',{altKey:true}),key('v',{altKey:true}),key('/',{metaKey:true})])expect(getWorkspaceShortcut(event,context)).toBeNull();
  });
  it('does not mutate or prevent the event when reporting a matching action',()=>{
    const preventDefault=vi.fn(),event=Object.freeze({...key('/'),preventDefault});
    expect(getWorkspaceShortcut(event,context)).toEqual({type:'studies'});expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe('native focus safety',()=>{
  class Target extends EventTarget {
    constructor(private kind:'button'|'input'|'link'|'plain',private ancestor?:Target){super();}
    closest(selector:string):Target|null {
      if(this.kind==='input'&&selector.includes('input'))return this;
      if(this.kind==='button'&&selector.includes('button'))return this;
      if(this.kind==='link'&&selector.includes('a[href]'))return this;
      return this.ancestor?.closest(selector)??null;
    }
  }
  it('preserves button/link Space and Enter activation even when editable=false',()=>{
    vi.stubGlobal('Element',Target);
    for(const target of [new Target('button'),new Target('link'),new Target('plain',new Target('button'))]){
      expect(getWorkspaceShortcut(key(' ',{target}),context)).toBeNull();expect(getWorkspaceShortcut(key('Enter',{target}),context)).toBeNull();
    }
    expect(getWorkspaceShortcut(key(' ',{target:new Target('plain')}),context)).toEqual({type:'nextSymbol'});
  });
  it('protects actual input descendants even if the caller has a stale editable flag',()=>{
    vi.stubGlobal('Element',Target);const target=new Target('plain',new Target('input'));
    for(const event of [key('/'),key('?'),key('b'),key('w',{altKey:true})])expect(getWorkspaceShortcut({...event,target},context)).toBeNull();
  });
});

describe('shortcut help definitions',()=>{
  it('adapts modifier captions to macOS while keeping other platforms familiar',()=>{
    expect(isMacShortcutPlatform('MacIntel')).toBe(true);expect(isMacShortcutPlatform('iPad')).toBe(true);expect(isMacShortcutPlatform('Win32')).toBe(false);expect(isMacShortcutPlatform('Linux x86_64')).toBe(false);
    expect(['Mod','Alt','Shift'].map(k=>shortcutKeyLabel(k,true))).toEqual(['⌘','⌥','⇧']);
    expect(['Mod','Alt','Shift'].map(k=>shortcutKeyLabel(k,false))).toEqual(['Ctrl','Alt','Shift']);
    expect(shortcutKeyLabel('ArrowLeft',true)).toBe('←');expect(shortcutKeyLabel('Space',true)).toBe('Space');
  });
  it('separates same-key chart/pane contexts and identifies the application-specific help binding',()=>{
    expect(SHORTCUT_GROUPS.find(g=>g.id==='workspace')!.shortcuts).toBe(WORKSPACE_SHORTCUTS);
    expect(SHORTCUT_GROUPS.find(g=>g.id==='chart')!.context).toContain('Home / End');
    expect(SHORTCUT_GROUPS.find(g=>g.id==='panes')!.context).toContain('分隔线');
    expect(WORKSPACE_SHORTCUTS.find(s=>s.id==='help')!.note).toBe('本应用快捷键');
    const ids=SHORTCUT_GROUPS.flatMap(g=>g.shortcuts.map(s=>s.id));expect(new Set(ids).size).toBe(ids.length);
  });
});
