import { mount, unmount } from 'svelte';
import ContextMenu from '../src/components/ui/ContextMenu.svelte';

export function installContextMenuFixture() {
  const target = document.createElement('div'); target.id = 'context-menu-fixture'; document.body.append(target);
  const outside = document.createElement('button'); outside.textContent = 'Fixture outside'; outside.id = 'context-menu-fixture-outside'; outside.style.cssText = 'position:fixed;left:10px;top:10px;z-index:10000;width:130px;height:36px'; target.append(outside);
  const stats = { outsideClicks: 0, closes: [] as boolean[], runs: [] as string[] };
  outside.addEventListener('click', () => stats.outsideClicks++);
  let instance: ReturnType<typeof mount> | undefined;
  function open(x = 390, y = 450) {
    if (instance) void unmount(instance);
    instance = mount(ContextMenu, { target, props: { x, y, label: 'Fixture menu', items: [
      { id: 'disabled', label: '不可用', disabled: true },
      { id: 'order', label: '视图顺序', children: [{ id: 'front', label: '置于顶层', run: () => { stats.runs.push('front'); } }, { id: 'back', label: '置于底层', run: () => { stats.runs.push('back'); } }] },
      { id: 'failure', label: '失败重试', run: async () => { throw new Error('Fixture 操作失败'); } },
      { id: 'success', label: '完成操作', separatorBefore: true, run: () => { stats.runs.push('success'); } }
    ], onClose: (restore = false) => { stats.closes.push(restore); if(instance)void unmount(instance,{outro:true}); instance=undefined; } } });
  }
  return { stats, open, cleanup() { if(instance)void unmount(instance); target.remove(); } };
}
