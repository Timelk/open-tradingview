import type { PriceRange } from '../core/price-scale';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export interface EnvelopeState {
  heldMin: number;
  heldMax: number;
}

/**
 * Frame-driven viewport physics modeled on Percept / Kiyotaka titan-charts:
 * - Multiplicative exponential zoom queue (zoomEaseRate = 21.5)
 * - Trackpad cross-axis deadband gate
 * - Exponentially smoothed pan velocity + kinetic fling decay (panFriction = 12)
 * - Fling distance projection (v0 / panFriction), returned by endDrag
 * - Gesture Y-axis envelope hold (8% headroom, 1.6x slack) + 0.5px sub-pixel deadband
 */
export class ViewportPhysics {
  private pendingZoomScale = 1;
  private zoomAnchorPx = 0;
  private lastZoomTick = 0;

  private velocityPxPerSec = 0;
  private lastDragX = 0;
  private lastDragTime = 0;
  private flingActive = false;
  private lastFlingTick = 0;

  private envelopes = new Map<string, EnvelopeState>();

  readonly zoomEaseRate = 21.5;
  readonly panFriction = 12;
  readonly minFlingVelocity = 28;
  readonly stopFlingVelocity = 18;
  readonly maxVelocity = 3000;
  readonly envelopeHeadroom = 0.08;
  readonly envelopeMaxSlack = 1.6;
  readonly subPixelDeadbandPx = 0.5;

  get active(): boolean {
    return this.zooming || this.flingActive;
  }

  get zooming(): boolean {
    return Math.abs(this.pendingZoomScale - 1) >= 8e-4;
  }

  get flinging(): boolean {
    return this.flingActive;
  }

  /** Stop all ongoing kinetic fling and queued zoom transitions immediately. */
  cancel(): void {
    this.pendingZoomScale = 1;
    this.lastZoomTick = 0;
    this.velocityPxPerSec = 0;
    this.lastDragTime = 0;
    this.flingActive = false;
    this.lastFlingTick = 0;
  }

  clearEnvelopes(): void {
    this.envelopes.clear();
  }

  /**
   * Filters trackpad cross-axis micro-jitter and classifies whether a wheel event
   * should pan horizontally or zoom around the cursor.
   */
  classifyWheel(deltaX: number | undefined, deltaY: number | undefined, shiftKey: boolean): 'pan' | 'zoom' {
    if (shiftKey) return 'pan';
    const absX = Math.abs(Number(deltaX) || 0);
    const absY = Math.abs(Number(deltaY) || 0);
    if (absX > absY * 1.18 && absX > 1.2) return 'pan';
    return 'zoom';
  }

  /**
   * Coalesces multiplicative zoom factors around cursor anchor X.
   */
  queueZoom(factor: number, anchorPx: number, now: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.flingActive = false;
    this.velocityPxPerSec = 0;
    this.pendingZoomScale = clamp(this.pendingZoomScale * factor, 0.05, 20);
    this.zoomAnchorPx = anchorPx;
    if (!this.lastZoomTick) this.lastZoomTick = now;
  }

  /**
   * Records a pointer drag sample to estimate instantaneous and smoothed pan velocity.
   */
  beginDrag(x: number, now: number): void {
    this.cancel();
    this.lastDragX = x;
    this.lastDragTime = now;
  }

  recordDrag(x: number, now: number): void {
    const dtMs = now - this.lastDragTime;
    const dx = x - this.lastDragX;
    this.lastDragX = x;
    this.lastDragTime = now;
    if (dtMs > 1 && dtMs < 120) {
      const instVelocity = clamp((dx / dtMs) * 1000, -this.maxVelocity, this.maxVelocity);
      this.velocityPxPerSec =
        this.velocityPxPerSec === 0
          ? instVelocity
          : 0.55 * this.velocityPxPerSec + 0.45 * instVelocity;
    } else if (dtMs >= 120) {
      this.velocityPxPerSec = 0;
    }
  }

  /**
   * Starts kinetic fling if release velocity exceeds threshold and pointer wasn't held stationary.
   * Returns projected total fling distance in pixels (dx = v0 / friction) for predictive prefetch.
   */
  endDrag(now: number, enabled: boolean): number {
    const idleMs = now - this.lastDragTime;
    if (!enabled || idleMs > 65 || Math.abs(this.velocityPxPerSec) < this.minFlingVelocity) {
      this.velocityPxPerSec = 0;
      this.flingActive = false;
      return 0;
    }
    this.flingActive = true;
    this.lastFlingTick = now;
    return this.velocityPxPerSec / this.panFriction;
  }

  /**
   * Advances queued zoom and kinetic pan fling for the current animation frame.
   */
  step(
    now: number,
    callbacks: {
      onZoom: (anchorPx: number, factor: number) => void;
      onPan: (deltaPx: number) => void;
    },
  ): boolean {
    let moved = false;

    if (this.zooming) {
      const dt = clamp(this.lastZoomTick ? now - this.lastZoomTick : 16.67, 1, 64);
      this.lastZoomTick = now;
      const alpha = 1 - Math.exp((-this.zoomEaseRate * dt) / 1000);
      const stepFactor = 1 + (this.pendingZoomScale - 1) * alpha;
      if (Math.abs(stepFactor - 1) > 1e-5) {
        callbacks.onZoom(this.zoomAnchorPx, stepFactor);
        this.pendingZoomScale /= stepFactor;
        moved = true;
      }
      if (Math.abs(this.pendingZoomScale - 1) < 8e-4) {
        if (Math.abs(this.pendingZoomScale - 1) > 1e-5) {
          callbacks.onZoom(this.zoomAnchorPx, this.pendingZoomScale);
          moved = true;
        }
        this.pendingZoomScale = 1;
        this.lastZoomTick = 0;
      }
    }

    if (this.flingActive) {
      const dt = clamp(this.lastFlingTick ? now - this.lastFlingTick : 16.67, 1, 64);
      this.lastFlingTick = now;
      const decay = Math.exp((-this.panFriction * dt) / 1000);
      const nextVelocity = this.velocityPxPerSec * decay;
      const avgVelocity = 0.5 * (this.velocityPxPerSec + nextVelocity);
      const dx = (avgVelocity * dt) / 1000;
      this.velocityPxPerSec = nextVelocity;
      if (Math.abs(dx) >= 0.05) {
        callbacks.onPan(dx);
        moved = true;
      }
      if (Math.abs(this.velocityPxPerSec) < this.stopFlingVelocity) {
        this.velocityPxPerSec = 0;
        this.flingActive = false;
        this.lastFlingTick = 0;
      }
    }

    return moved;
  }

  /**
   * Stabilizes auto-scaled Y range during horizontal pan/fling gestures using
   * an 8% headroom envelope hold and a 0.5px sub-pixel deadband.
   */
  stabilizeAutoRange(
    paneId: string,
    rawRange: PriceRange,
    currentRange: PriceRange,
    paneHeight: number,
    inHorizontalGesture: boolean,
  ): PriceRange {
    const rawSpan = rawRange.max - rawRange.min;
    const curSpan = currentRange.max - currentRange.min;
    if (!Number.isFinite(rawSpan) || rawSpan <= 0 || !Number.isFinite(curSpan) || curSpan <= 0 || paneHeight <= 0) {
      this.envelopes.delete(paneId);
      return rawRange;
    }

    // 1. Sub-pixel deadband: ignore micro-changes that move top & bottom by < 0.5px
    const pxPerUnit = paneHeight / curSpan;
    const deltaMinPx = Math.abs(rawRange.min - currentRange.min) * pxPerUnit;
    const deltaMaxPx = Math.abs(rawRange.max - currentRange.max) * pxPerUnit;
    if (deltaMinPx < this.subPixelDeadbandPx && deltaMaxPx < this.subPixelDeadbandPx) {
      return currentRange;
    }

    // 2. Gesture envelope hold during an active horizontal pan or fling. Auto
    // ranges carry ~8% padding per side; hold while the unpadded data still
    // fits the held range (nothing is clipped) and the held range is not much
    // looser than needed. Otherwise re-seat with extra headroom so the next
    // few bars entering the viewport do not immediately move the axis again.
    if (inHorizontalGesture) {
      let env = this.envelopes.get(paneId);
      if (!env) {
        env = {heldMin: currentRange.min, heldMax: currentRange.max};
        this.envelopes.set(paneId, env);
      }
      const inset = rawSpan * this.envelopeHeadroom / (1 + 2 * this.envelopeHeadroom);
      const fitsInside = rawRange.min + inset >= env.heldMin && rawRange.max - inset <= env.heldMax;
      const notTooLoose = env.heldMax - env.heldMin <= rawSpan * this.envelopeMaxSlack;
      if (fitsInside && notTooLoose) return {min: env.heldMin, max: env.heldMax};
      const pad = rawSpan * this.envelopeHeadroom;
      const next = {min: rawRange.min - pad, max: rawRange.max + pad};
      this.envelopes.set(paneId, {heldMin: next.min, heldMax: next.max});
      return next;
    }

    this.envelopes.delete(paneId);
    return rawRange;
  }
}
