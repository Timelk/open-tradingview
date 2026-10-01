import { appendPivot, type Pivot } from './pivots';

/** A causal, amplitude-based level above the ordinary time-radius pivots.
 * Only a shallow, fully contained correction followed by a confirmed extension
 * is removed. This is not an arbitrary search over combinations of anchors:
 * large opposing swings stay in the sequence, and nothing uses a future pivot.
 * The caller still validates every source candle against the resulting bounds.
 */
export function appendHuziSwing(stack: Pivot[], point: Pivot, maxRetracement: number): boolean {
  if (!appendPivot(stack, point)) return false;
  while (maxRetracement > 0 && stack.length >= 4) {
    const [a, b, c, d] = stack.slice(-4);
    const sign = b.kind === 'high' ? 1 : -1;
    const impulse = sign * (b.value - a.value);
    const correction = sign * (b.value - c.value);
    if (impulse <= 0 || correction <= 0 || correction > impulse * maxRetracement ||
      sign * (c.value - a.value) <= 0 || sign * (d.value - b.value) <= 0) break;
    // Keep the original leg origin and the newly confirmed extension. Both
    // surviving pivots retain their actual source index and confirmation time.
    stack.splice(stack.length - 3, 2);
  }
  // Only the last 9 contacts and a potential flagpole are consumed. A small
  // history margin permits recursive compression without an unbounded stack.
  if (stack.length > 32) stack.splice(0, stack.length - 32);
  return true;
}
