import type { TransitionConfig } from 'svelte/transition';
import {motionReduced} from './motion-preferences';

export interface SurfaceMotion {
  enter?: number;
  exit?: number;
  x?: number;
  y?: number;
}

export function prefersReducedMotion(): boolean {
  return motionReduced();
}

/** A reversible surface transition: no layout animation and no delayed interaction. */
export function surface(node: Element, options: SurfaceMotion = {}) {
  const style = getComputedStyle(node);
  const transform = style.transform === 'none' ? '' : style.transform;
  const opacity = Number(style.opacity) || 1;
  return ({ direction }: { direction: 'in' | 'out' } = { direction: 'in' }): TransitionConfig => ({
    duration: prefersReducedMotion() ? 0 : direction === 'in' ? options.enter ?? 120 : options.exit ?? 90,
    easing: t => 1 - (1 - t) ** 3,
    css: (t, u) => `opacity:${t * opacity};transform:${transform} translate(${u * (options.x ?? 0)}px,${u * (options.y ?? 4)}px)`,
  });
}

/** Outgoing DOM may remain for an outro, but must immediately release input. */
export function setSurfaceInteractive(node: HTMLElement, interactive: boolean): void {
  node.inert = !interactive;
  node.style.pointerEvents = interactive ? '' : 'none';
}
