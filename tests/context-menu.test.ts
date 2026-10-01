import { describe, expect, it } from 'vitest';
import { contextMenuLevels, nextContextItem, placeContextMenu, type ContextMenuItem } from '../src/lib/ui/context-menu';

describe('context menu viewport placement', () => {
  it('keeps a root menu inside the lower-right screen edge', () => {
    expect(placeContextMenu({ left: 421, right: 421, top: 842, bottom: 842 }, 248, 400, { width: 430, height: 850 }))
      .toEqual({ left: 174, top: 442, maxHeight: 834, side: 'right' });
  });
  it('opens a submenu to the left when the right side has no room', () => {
    expect(placeContextMenu({ left: 350, right: 420, top: 700, bottom: 733 }, 248, 300, { width: 430, height: 850 }, true))
      .toEqual({ left: 99, top: 542, maxHeight: 834, side: 'left' });
  });
  it('caps a tall submenu on a narrow viewport without negative coordinates', () => {
    const result = placeContextMenu({ left: 8, right: 240, top: 18, bottom: 51 }, 248, 600, { width: 250, height: 220 }, true);
    expect(result).toEqual({ left: 8, top: 8, maxHeight: 204, side: 'left' });
  });
});

describe('context menu keyboard navigation', () => {
  const items: ContextMenuItem[] = [{ id: 'disabled', label: '不可用', disabled: true }, { id: 'settings', label: '设置' }, { id: 'delete', label: '删除' }];
  it('skips disabled rows and wraps in both directions', () => {
    expect(nextContextItem(items, undefined, 'ArrowDown')).toBe('settings');
    expect(nextContextItem(items, 'settings', 'ArrowUp')).toBe('delete');
    expect(nextContextItem(items, 'delete', 'ArrowDown')).toBe('settings');
    expect(nextContextItem(items, 'delete', 'Home')).toBe('settings');
    expect(nextContextItem(items, 'settings', 'End')).toBe('delete');
    expect(nextContextItem([items[0]], undefined, 'ArrowDown')).toBeUndefined();
  });
  it('stops stale or disabled submenu paths instead of rendering unrelated children', () => {
    const root = [{ id: 'order', label: '顺序', children: items }];
    expect(contextMenuLevels(root, ['order', 'removed'])).toEqual([root, items]);
    expect(contextMenuLevels([{ ...root[0], disabled: true }], ['order'])).toHaveLength(1);
  });
});
