<script lang="ts">
  import {t,locale,translateError} from '../../lib/i18n';
  import { onMount, tick, untrack } from 'svelte';
  import { contextMenuLabel, contextMenuLevels, nextContextItem, placeContextMenu, type ContextMenuItem, type MenuPosition } from '../../lib/ui/context-menu';
  import { surface, setSurfaceInteractive } from '../../lib/ui/motion';
  import ToolIcon from '../drawing/ToolIcon.svelte';

  let { x, y, label, literalLabel=false, items, onClose }: { x: number; y: number; label: string; literalLabel?:boolean; items: ContextMenuItem[]; onClose: (restoreFocus?: boolean) => void } = $props();
  const menuTitle=$derived(literalLabel?label:$t(label));
  let openPath = $state<string[]>([]), activeIds = $state<(string | undefined)[]>([]);
  let positions = $state<MenuPosition[]>([]), error = $state(''), pending = $state(false);
  let closed = false, mounted = false, focusAfterOpen = 0, session = 0;
  const panels = new Map<number, HTMLDivElement>();
  const levels = $derived(contextMenuLevels(items, openPath));
  $effect(() => {
    x; y;
    untrack(() => {
      session++; closed = false; pending = false; openPath = []; activeIds = [nextContextItem(items, undefined, 'Home')]; error = ''; focusAfterOpen = 0;
      for (const panel of panels.values()) setSurfaceInteractive(panel, true);
      void tick().then(() => { reposition(); focusItem(0, activeIds[0]); });
    });
  });
  $effect(() => {
    const latest = items;
    untrack(() => {
      const validLevels = contextMenuLevels(latest, openPath);
      if (openPath.length >= validLevels.length) openPath = openPath.slice(0, validLevels.length - 1);
      const nextActive = validLevels.map((entries, level) => entries.some(item => item.id === activeIds[level] && !item.disabled) ? activeIds[level] : nextContextItem(entries, undefined, 'Home'));
      if (nextActive.length !== activeIds.length || nextActive.some((id, level) => id !== activeIds[level])) activeIds = nextActive;
    });
  });

  onMount(() => {
    mounted = true;
    const outside = (event: PointerEvent) => {
      if (closed || [...panels.values()].some(panel => panel.contains(event.target as Node))) return;
      // Dismissing a menu must not begin an underlying drawing or pan gesture.
      event.preventDefault(); event.stopImmediatePropagation();
      consumeDismissClick(event.pointerId);
      close(false);
    };
    const dismiss = () => close(false);
    const scrolled = (event: Event) => { if (![...panels.values()].some(panel => panel.contains(event.target as Node))) close(false); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scrolled, true);
    return () => { mounted = false; document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', scrolled, true); };
  });

  function consumeDismissClick(pointerId: number) {
    let finished = false;
    const cleanup = () => { window.removeEventListener('pointerup', end, true); window.removeEventListener('pointercancel', cancel, true); window.removeEventListener('click', click, true); clearTimeout(timeout); };
    const end = (event: PointerEvent) => { if (event.pointerId !== pointerId) return; finished = true; setTimeout(cleanup, 0); };
    const cancel = (event: PointerEvent) => { if (event.pointerId === pointerId) cleanup(); };
    const click = (event: MouseEvent) => { if (!finished) return; event.preventDefault(); event.stopImmediatePropagation(); cleanup(); };
    const timeout = setTimeout(cleanup, 2000);
    window.addEventListener('pointerup', end, true); window.addEventListener('pointercancel', cancel, true); window.addEventListener('click', click, true);
  }
  function close(restoreFocus: boolean) {
    if (closed) return;
    closed = true;
    for (const panel of panels.values()) setSurfaceInteractive(panel, false);
    onClose(restoreFocus);
  }
  function button(level: number, id: string | undefined): HTMLButtonElement | undefined {
    return Array.from(panels.get(level)?.querySelectorAll<HTMLButtonElement>('[data-menu-item]') ?? []).find(node => node.dataset.menuItem === id);
  }
  function focusItem(level: number, id: string | undefined) { const target = button(level, id); if (target && !target.disabled) target.focus({ preventScroll: true }); else panels.get(level)?.focus({ preventScroll: true }); }
  function position(level: number) {
    if (closed) return;
    const panel = panels.get(level); if (!panel?.isConnected || panel.inert) return;
    const parent = level ? button(level - 1, openPath[level - 1]) : undefined;
    if (level && !parent) return;
    const anchor = parent?.getBoundingClientRect() ?? { left: x, right: x, top: y, bottom: y };
    const next = placeContextMenu(anchor, panel.offsetWidth, panel.offsetHeight, { width: innerWidth, height: innerHeight }, level > 0);
    const previous = positions[level];
    if (!previous || previous.left !== next.left || previous.top !== next.top || previous.maxHeight !== next.maxHeight || previous.side !== next.side) positions[level] = next;
  }
  function reposition() { for (const level of panels.keys()) position(level); }
  function panelAction(node: HTMLDivElement, level: number) {
    panels.set(level, node);
    node.showPopover(); position(level);
    const observer = new ResizeObserver(() => { position(level); if (panels.has(level + 1)) position(level + 1); }); observer.observe(node);
    void tick().then(() => { if (focusAfterOpen === level && panels.get(level) === node) { focusAfterOpen = -1; activeIds[level] ??= nextContextItem(levels[level] ?? [], undefined, 'Home'); focusItem(level, activeIds[level]); } });
    return { destroy() { observer.disconnect(); if (panels.get(level) === node) panels.delete(level); } };
  }
  async function openChildren(level: number, item: ContextMenuItem, keyboard = false) {
    if (item.disabled || pending || !item.children?.length) return;
    activeIds[level] = item.id; openPath = [...openPath.slice(0, level), item.id];
    activeIds[level + 1] = nextContextItem(item.children, undefined, 'Home');
    if (keyboard) focusAfterOpen = level + 1;
    await tick(); position(level + 1);
    if (keyboard) focusItem(level + 1, activeIds[level + 1]);
  }
  function hover(level: number, item: ContextMenuItem, event: PointerEvent) {
    if (event.pointerType === 'touch' || pending || item.disabled) return;
    activeIds[level] = item.id;
    if (item.children?.length) void openChildren(level, item);
    else openPath = openPath.slice(0, level);
  }
  async function activate(level: number, item: ContextMenuItem) {
    if (item.disabled || pending) return;
    if (item.children?.length) { await openChildren(level, item, true); return; }
    if (!item.run) return;
    const runSession = session;
    pending = true; error = '';
    try { await item.run(); if (mounted && !closed && runSession === session) close(true); }
    catch (reason) { if (mounted && !closed && runSession === session) { pending = false; error = reason instanceof Error ? reason.message : '操作未完成，请重试。'; await tick(); reposition(); await tick(); focusItem(level, item.id); } }
    finally { if (runSession === session) pending = false; }
  }
  function keys(event: KeyboardEvent, level: number) {
    if (event.isComposing) return;
    const key = event.key;
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'Escape', 'Tab'].includes(key)) return;
    event.preventDefault(); event.stopPropagation();
    if (key === 'Escape' || key === 'Tab') { close(true); return; }
    if (key === 'ArrowLeft' && level) { openPath = openPath.slice(0, level - 1); focusItem(level - 1, activeIds[level - 1]); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
      activeIds[level] = nextContextItem(levels[level] ?? [], activeIds[level], key as 'ArrowDown' | 'ArrowUp' | 'Home' | 'End');
      focusItem(level, activeIds[level]); button(level, activeIds[level])?.scrollIntoView({ block: 'nearest' }); return;
    }
    const item = levels[level]?.find(item => item.id === activeIds[level]); if (!item || pending || event.repeat) return;
    if (key === 'ArrowRight') void openChildren(level, item, true);
    if (key === 'Enter' || key === ' ') void activate(level, item);
  }
</script>

{#each levels as entries, level (level)}
  <div class="context-menu" use:panelAction={level} popover="manual" role="menu" aria-label={level ? `${menuTitle} · ${contextMenuLabel(levels[level - 1]?.find(item => item.id === openPath[level - 1])??{label:'更多'},$t)}` : menuTitle} aria-busy={pending} tabindex="-1" style:left={`${positions[level]?.left ?? x}px`} style:top={`${positions[level]?.top ?? y}px`} style:max-height={`${positions[level]?.maxHeight ?? Math.max(0,innerHeight-16)}px`} transition:surface|global={{enter:100,exit:70,y:3}} onintrostart={(event) => setSurfaceInteractive(event.currentTarget, true)} onoutrostart={(event) => setSurfaceInteractive(event.currentTarget, false)} onkeydown={(event) => keys(event, level)} onpointerdown={(event) => event.stopPropagation()} onclick={(event) => event.stopPropagation()} oncontextmenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    {#each entries as item (item.id)}
      {#if item.separatorBefore}<div class="menu-separator" role="separator"></div>{/if}
      <button role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked} aria-haspopup={item.children?.length ? 'menu' : undefined} aria-expanded={item.children?.length ? openPath[level] === item.id : undefined} disabled={item.disabled || pending} data-menu-item={item.id} class:active={activeIds[level] === item.id} class:danger={item.danger} tabindex={activeIds[level] === item.id ? 0 : -1} title={contextMenuLabel(item,$t)} onfocus={() => activeIds[level] = item.id} onpointerenter={(event) => hover(level, item, event)} onclick={() => void activate(level, item)}>
        <span class="menu-icon">{#if item.checked !== undefined}{item.checked ? '✓' : ''}{:else if item.icon}<ToolIcon name={item.icon} size={16}/>{/if}</span><span class="menu-label">{contextMenuLabel(item,$t)}</span>{#if item.children?.length}<span class="submenu-arrow"><ToolIcon name="chevron" size={12}/></span>{:else if item.shortcut}<kbd>{item.shortcut}</kbd>{/if}
      </button>
    {/each}
    {#if level === 0 && error}<p class="menu-error" role="alert">{translateError(error,$locale)}</p>{/if}
    {#if level === 0 && pending}<p class="menu-pending" role="status">{$t("正在执行…")}</p>{/if}
  </div>
{/each}

<style>
  .context-menu{position:fixed;inset:auto;margin:0;width:min(248px,calc(100vw - 16px));min-width:0;max-width:calc(100vw - 16px);padding:5px;border:1px solid var(--line-strong);background:var(--surface-raised);color:var(--text);box-shadow:var(--shadow-md);overflow:auto;z-index:100;overscroll-behavior:contain}.context-menu::backdrop{background:transparent;pointer-events:none}.context-menu button{display:flex;align-items:center;gap:9px;min-width:0;width:100%;height:33px;padding:5px 8px;border:0;font:12px var(--font);text-align:left;color:inherit;background:transparent}.context-menu button.active,.context-menu button:hover{background:var(--bg-active);color:var(--text-strong)}.context-menu button:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}.context-menu button:disabled{opacity:.36;cursor:default}.context-menu button:disabled:hover{background:transparent;color:inherit}.context-menu button.danger{color:var(--down)}.menu-icon{width:17px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font:12px var(--mono)}.menu-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.context-menu kbd{font:11px var(--mono);color:var(--text-dim);white-space:nowrap;margin-left:8px}.submenu-arrow{display:flex;flex-shrink:0;color:var(--text-dim)}.menu-separator{height:1px;background:var(--bg-active);margin:5px 5px}.menu-error,.menu-pending{font-size:11px;line-height:1.5;padding:8px;margin:5px 2px 0;border-top:1px solid var(--line-strong);overflow-wrap:anywhere}.menu-error{color:var(--warn)}.menu-pending{color:var(--text-dim)}@media(pointer:coarse){.context-menu button{height:42px;font-size:12px}}@media(prefers-reduced-motion:reduce){.context-menu button{transition:none}}
</style>
