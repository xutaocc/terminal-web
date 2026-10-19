/**
 * Zooming the terminal's font, not the page. On a computer: ⌘ / Ctrl with = or
 * + to grow it and − to shrink it — the keys every browser and terminal zooms
 * with — and ⌘ / Ctrl with the wheel (a trackpad pinch arrives as that too).
 * ⌘ / Ctrl 0 is left to the browser, so a page zoomed by accident can still be
 * reset. On a phone: a two-finger pinch over the terminal.
 *
 * Pure decisions only; terminal.ts owns the font and the event listeners.
 */

/** +1 / −1 for a zoom chord, null for anything else. */
export function zoomKey(e: {
  key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean;
}, mac: boolean): 1 | -1 | null {
  // ⌘ on a Mac (Ctrl there is the terminal's), Ctrl elsewhere; Shift is allowed,
  // since + is Shift-= on most layouts.
  if (e.altKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey)) return null;
  if (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') return 1;
  if (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract') return -1;
  return null;
}

/** How much a ⌘ / Ctrl wheel has to turn before the size moves a step. */
const WHEEL_STEP = 60;

/**
 * Turns wheel deltas into size steps. A mouse notch is ~100 px and gives one
 * step; a trackpad pinch sends many small deltas and gives a step every so
 * often, so neither races through the sizes.
 */
export class WheelZoom {
  private pending = 0;
  private lastAt = 0;

  /** Steps to apply for this event (wheel down / pinch in is smaller). */
  feed(deltaY: number, deltaMode: number, now: number): number {
    if (now - this.lastAt > 400) this.pending = 0; // a new gesture starts fresh
    this.lastAt = now;
    const px = deltaY * (deltaMode === 1 ? 33 : deltaMode === 2 ? 400 : 1);
    this.pending += px;
    const steps = Math.trunc(this.pending / WHEEL_STEP);
    this.pending -= steps * WHEEL_STEP;
    return -steps;
  }
}

/** How far apart two fingers have to move, as a ratio, for one step. */
const PINCH_STEP = 0.15;

/**
 * Turns a two-finger pinch into size steps: one per 15% change in the distance
 * between the fingers, counted from where the last step was taken.
 */
export class PinchZoom {
  private base = 0;

  start(distance: number): void {
    this.base = distance;
  }

  get active(): boolean {
    return this.base > 0;
  }

  /** Steps for the fingers now `distance` apart (apart: bigger). */
  move(distance: number): number {
    if (this.base <= 0 || distance <= 0) return 0;
    const steps = Math.trunc(Math.log(distance / this.base) / Math.log(1 + PINCH_STEP));
    if (steps) this.base *= Math.pow(1 + PINCH_STEP, steps);
    return steps;
  }

  end(): void {
    this.base = 0;
  }
}
