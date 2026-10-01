export interface ContextMenuItem {
  id: string;
  label: string;
  /** User-authored names are opaque even when they match a built-in label. */
  literalLabel?: boolean;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  children?: ContextMenuItem[];
  run?: () => void | Promise<void>;
}

export function contextMenuLabel(item:Pick<ContextMenuItem,'label'|'literalLabel'>,translate:(label:string)=>string):string {
  return item.literalLabel?item.label:translate(item.label);
}
/** Search both the canonical and currently displayed command vocabulary. */
export function commandSearchText(item:{id:string;label:string;literalLabel?:boolean;keywords?:string},translate:(label:string)=>string):string {
  return [item.label,contextMenuLabel(item,translate),item.id,item.keywords??'',item.keywords?translate(item.keywords):''].join(' ').toLocaleLowerCase();
}

export interface MenuAnchor { left: number; right: number; top: number; bottom: number }
export interface MenuPosition { left: number; top: number; maxHeight: number; side: 'right' | 'left' }

export function placeContextMenu(anchor: MenuAnchor, width: number, height: number, viewport: { width: number; height: number }, submenu = false): MenuPosition {
  const margin = 8, gap = 3;
  const availableWidth = Math.max(0, viewport.width - margin * 2);
  const usedWidth = Math.min(Math.max(0, width), availableWidth);
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const usedHeight = Math.min(Math.max(0, height), maxHeight);
  const side = submenu && anchor.right + gap + usedWidth > viewport.width - margin ? 'left' : 'right';
  const left = submenu ? side === 'right' ? anchor.right + gap : anchor.left - usedWidth - gap : anchor.left;
  return {
    left: Math.max(margin, Math.min(left, viewport.width - usedWidth - margin)),
    top: Math.max(margin, Math.min(anchor.top, viewport.height - usedHeight - margin)),
    maxHeight,
    side,
  };
}

export function nextContextItem(items: readonly ContextMenuItem[], currentId: string | undefined, key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): string | undefined {
  const available = items.filter(item => !item.disabled);
  if (!available.length) return undefined;
  if (key === 'Home') return available[0].id;
  if (key === 'End') return available[available.length - 1].id;
  const current = available.findIndex(item => item.id === currentId);
  if (current < 0) return available[key === 'ArrowDown' ? 0 : available.length - 1].id;
  return available[(current + (key === 'ArrowDown' ? 1 : -1) + available.length) % available.length].id;
}

export function contextMenuLevels(items: ContextMenuItem[], openPath: readonly string[]): ContextMenuItem[][] {
  const levels = [items];
  let current = items;
  for (const id of openPath) {
    const item = current.find(item => item.id === id);
    if (!item?.children?.length || item.disabled) break;
    current = item.children; levels.push(current);
  }
  return levels;
}
