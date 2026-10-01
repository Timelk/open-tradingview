export type WorkspaceShortcutAction={type:'studies'|'symbolSearch'|'watchlistAdd'|'nextSymbol'|'previousSymbol'|'help';query?:string};
export interface WorkspaceShortcutContext { editable:boolean;modalOpen:boolean;drawingBusy:boolean }
export interface ShortcutKeyEvent {
  key:string;code?:string;keyCode?:number;target?:EventTarget|null;
  ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean;shiftKey?:boolean;
  defaultPrevented?:boolean;isComposing?:boolean;repeat?:boolean;
}
export interface ShortcutDefinition { id:string;label:string;keys:readonly (readonly string[])[];note?:string }
export interface ShortcutGroup { id:string;title:string;context:string;shortcuts:readonly ShortcutDefinition[] }

export const WORKSPACE_SHORTCUTS:readonly ShortcutDefinition[]=[
  {id:'studies',label:'打开指标与策略库',keys:[['/']]},
  {id:'symbolSearch',label:'输入品种名称进行搜索',keys:[['字母 / 数字']]},
  {id:'watchlistAdd',label:'将当前品种加入自选',keys:[['Alt','W']]},
  {id:'nextSymbol',label:'切换到下一个自选品种',keys:[['Space']]},
  {id:'previousSymbol',label:'切换到上一个自选品种',keys:[['Shift','Space']]},
  {id:'help',label:'查看快捷键帮助',keys:[['?']],note:'本应用快捷键'},
];
export const SHORTCUT_GROUPS:readonly ShortcutGroup[]=[
  {id:'workspace',title:'工作区',context:'输入框、弹窗或绘图操作进行中不触发；Space 保留普通按钮与表单的默认操作，自选列表品种按钮使用下方独立规则。',shortcuts:WORKSPACE_SHORTCUTS},
  {id:'watchlist',title:'自选列表',context:'焦点在自选列表品种按钮时使用；上下键和 Home / End 只移动焦点，按 Enter 才打开该品种。',shortcuts:[
    {id:'watchlistNext',label:'打开下一个自选品种',keys:[['Space']]},
    {id:'watchlistPrevious',label:'打开上一个自选品种',keys:[['Shift','Space']]},
    {id:'watchlistFocus',label:'将焦点移到上一个 / 下一个品种',keys:[['ArrowUp'],['ArrowDown']]},
    {id:'watchlistFirst',label:'将焦点移到第一个品种',keys:[['Home']]},
    {id:'watchlistLast',label:'将焦点移到最后一个品种',keys:[['End']]},
    {id:'watchlistOpen',label:'打开当前聚焦的品种',keys:[['Enter']]},
    {id:'watchlistUndo',label:'撤销列表修改',keys:[['Mod','Z']],note:'与图表对象的撤销历史独立'},
  ]},
  {id:'chart',title:'图表',context:'先点击图表。若焦点在窗格分隔线上，Home / End 会调整高度。',shortcuts:[
    {id:'history',label:'查看全部已加载历史',keys:[['Home']]},
    {id:'latest',label:'返回最新行情',keys:[['End']]},
    {id:'zoomIn',label:'放大图表',keys:[['+'],['=']]},
    {id:'zoomOut',label:'缩小图表',keys:[['−']]},
    {id:'pan',label:'左右平移图表',keys:[['ArrowLeft'],['ArrowRight']]},
  ]},
  {id:'drawings',title:'绘图与对象',context:'焦点在图表时使用；撤销与重做覆盖绘图、指标和图层修改。',shortcuts:[
    {id:'trendLine',label:'选择趋势线工具',keys:[['Alt','T']]},
    {id:'horizontalLine',label:'选择水平线工具',keys:[['Alt','H']]},
    {id:'verticalLine',label:'选择垂直线工具',keys:[['Alt','V']]},
    {id:'magnetHold',label:'按住临时切换 OHLC 磁吸',keys:[['Mod']],note:'关闭时临时强吸；开启时临时关闭。松开恢复，Mac 也支持 Ctrl'},
    {id:'contextMenu',label:'打开当前位置操作菜单',keys:[['Shift','F10']],note:'也可使用键盘菜单键'},
    {id:'undo',label:'撤销修改',keys:[['Mod','Z']]},
    {id:'redo',label:'重做修改',keys:[['Mod','Shift','Z'],['Mod','Y']]},
    {id:'delete',label:'删除选中的未锁定对象',keys:[['Delete'],['Backspace']]},
    {id:'cancel',label:'取消绘制、编辑或清除选中',keys:[['Escape']]},
  ]},
  {id:'dock',title:'工作区标签',context:'焦点在对应区域时使用。布局撤销在布局设置与命令面板中提供，不占用绘图撤销。',shortcuts:[{id:'commands',label:'搜索功能与快捷操作',keys:[['Mod','Shift','P']]},{id:'dockTabs',label:'切换同区面板',keys:[['ArrowLeft'],['ArrowRight'],['Home'],['End']]}]},
  {id:'panes',title:'窗格分隔线',context:'点击或用 Tab 聚焦图表之间的分隔线后使用。',shortcuts:[
    {id:'paneResize',label:'调整相邻窗格高度',keys:[['ArrowUp'],['ArrowDown']]},
    {id:'paneResizeFaster',label:'加大高度调整步长',keys:[['Shift','ArrowUp'],['Shift','ArrowDown']]},
    {id:'paneSmall',label:'将上方窗格调整到最小高度',keys:[['Home']]},
    {id:'paneLarge',label:'将上方窗格调整到最大高度',keys:[['End']]},
    {id:'paneReset',label:'恢复默认窗格高度',keys:[['Enter']]},
  ]},
];

export function isMacShortcutPlatform(platform?:string):boolean {
  const source=platform??(typeof navigator==='undefined'?'':navigator.platform||navigator.userAgent);
  return /Mac|iPhone|iPad|iPod/i.test(source);
}
export function shortcutKeyLabel(key:string,mac=isMacShortcutPlatform()):string {
  if(key==='Mod')return mac?'⌘':'Ctrl';
  if(key==='Alt')return mac?'⌥':'Alt';
  if(key==='Shift')return mac?'⇧':'Shift';
  return ({ArrowLeft:'←',ArrowRight:'→',ArrowUp:'↑',ArrowDown:'↓',Escape:'Esc',Backspace:mac?'⌫':'Backspace'} as Record<string,string>)[key]??key;
}
function closestTarget(event:ShortcutKeyEvent,selector:string):Element|null {
  return typeof Element!=='undefined'&&event.target instanceof Element?event.target.closest(selector):null;
}
/** A read-only matcher. The owner prevents default only after it handles an
 * action; chart/drawing shortcuts and native control activation stay local. */
export function getWorkspaceShortcut(event:ShortcutKeyEvent,context:WorkspaceShortcutContext):WorkspaceShortcutAction|null {
  if(event.defaultPrevented||event.isComposing||event.keyCode===229||event.repeat||context.editable||context.modalOpen||context.drawingBusy)return null;
  if(closestTarget(event,'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]'))return null;
  if(event.ctrlKey||event.metaKey)return null;
  if(event.altKey)return !event.shiftKey&&(event.code==='KeyW'||event.key.toLowerCase()==='w')?{type:'watchlistAdd'}:null;
  if(event.key==='/')return {type:'studies'};
  if(event.key==='?')return {type:'help'};
  if(event.key===' '||event.key==='Spacebar'){
    if(closestTarget(event,'button,a[href],input,textarea,select,summary,[role="button"],[role="link"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"]'))return null;
    return {type:event.shiftKey?'previousSymbol':'nextSymbol'};
  }
  return /^[a-z0-9]$/i.test(event.key)?{type:'symbolSearch',query:event.key}:null;
}
