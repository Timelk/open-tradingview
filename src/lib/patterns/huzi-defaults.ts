/** Defaults shared by the indicator inputs (registry.ts), the detector and the saved-layer migration (selection.ts).
 * Kept apart so none of them has to import the others. */

/** The reference guide's structures span 50–330 bars (median ~150). 20 only drops micro-wiggles (a 13-bar
 * "double top" is noise on any timeframe) and keeps the count comparable; raise it to 40–60 to see just the big
 * structures, or set 0 for every scale. */
export const MIN_STRUCTURE_BARS=20;
/** A breakout after four touches ("no E point") is only kept for structures at least this long: the author's
 * examples span 82–265 bars, while most four-touch breakouts are 20–40-bar fragments. The option itself stays off by
 * default: the author labels it in ~1% of the cases, and switched on it fills a third of a 1d chart's structures with
 * four-touch versions that overlap the full five-touch ones. */
export const EARLY_MIN_BARS=80;
/** A flag's pole must be at least this many times the flag's own height (wicks included). */
export const FLAG_POLE_RATIO=1.5;
