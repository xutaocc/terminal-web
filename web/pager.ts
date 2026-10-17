/**
 * Floating page buttons for phones: ⌃ / ⌄ stacked at the right, a little in
 * from the edge, about a third of the way down the terminal — where a right
 * thumb rests. A tap pages once; holding pages on until released; dragging
 * moves the pair up or down (remembered). After paging up, ⤓ appears to go
 * back to the live output.
 *
 * Paging is a whole screen per round trip, which is what makes it smoother
 * than a swipe: a swipe streams many small wheel events to tmux and waits on
 * each, and near the top of the page it can be taken for pull-to-refresh.
 */
export interface PagerHooks {
  page(direction: 'up' | 'down'): void;
  bottom(): void;
  /** The part of the screen the terminal is visible in, in client pixels. */
  visibleRange(): { top: number; bottom: number };
}

const HOLD_MS = 400;
const REPEAT_MS = 250;
const DRAG_PX = 8;
const DEFAULT_AT = 0.35;
const STORE_KEY = 'tw.pager.at';

export class FloatingPager {
  readonly el = document.createElement('div');
  private readonly bottomBtn: HTMLButtonElement;
  private at = DEFAULT_AT;
  private shown = false;
  private pagedUp = false;

  constructor(private readonly hooks: PagerHooks) {
    this.el.id = 'pager';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', '翻页');
    try {
      const saved = Number(localStorage.getItem(STORE_KEY));
      if (saved > 0 && saved < 1) this.at = saved;
    } catch { /* default position */ }

    const up = this.button('pager-up', '向上翻页（按住连续翻，拖动可调整位置）',
      '<path d="m6 15 6-6 6 6"/>');
    const down = this.button('pager-down', '向下翻页（按住连续翻，拖动可调整位置）',
      '<path d="m6 9 6 6 6-6"/>');
    this.bottomBtn = this.button('pager-bottom', '回到底部（最新输出）',
      '<path d="M12 5v11m-5-5 5 5 5-5"/><path d="M6 20h12"/>');
    this.bottomBtn.hidden = true;
    this.bindPaging(up, 'up');
    this.bindPaging(down, 'down');
    this.bottomBtn.addEventListener('pointerdown', e => e.preventDefault());
    this.bottomBtn.addEventListener('click', () => {
      this.buzz();
      this.setPagedUp(false);
      this.hooks.bottom();
    });
    const pair = document.createElement('div');
    pair.className = 'pager-pair';
    pair.append(up, down);
    this.el.append(pair, this.bottomBtn);
    this.el.hidden = true;
  }

  /** Show or hide, and re-place against where the terminal is now. */
  update(show: boolean): void {
    this.shown = show;
    this.place();
  }

  /** Whether the open session has been paged back from its live end. */
  setPagedUp(on: boolean): void {
    if (this.pagedUp === on) return;
    this.pagedUp = on;
    this.bottomBtn.hidden = !on;
    this.place();
  }

  place(): void {
    const { top, bottom } = this.hooks.visibleRange();
    const height = this.el.hidden ? 96 + (this.pagedUp ? 46 : 0) : this.el.offsetHeight;
    const room = bottom - top - height - 16;
    // No room beside a raised keyboard: step aside rather than cover the prompt.
    this.el.hidden = !this.shown || room < 8;
    if (this.el.hidden) return;
    const y = top + 8 + Math.max(0, Math.min(1, this.at)) * room;
    this.el.style.top = `${Math.round(y)}px`;
  }

  private button(cls: string, label: string, path: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pager-btn ${cls}`;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
      `stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
    return b;
  }

  private buzz(): void {
    try { navigator.vibrate?.(8); } catch { /* not supported */ }
  }

  /**
   * Tap: one page. Hold: a page now, then one every REPEAT_MS. Move the finger
   * first: drag the pair instead. preventDefault on pointerdown keeps the soft
   * keyboard and the terminal's focus exactly as they were.
   */
  private bindPaging(button: HTMLButtonElement, direction: 'up' | 'down'): void {
    let pointer: number | null = null;
    let startY = 0;
    let startAt = 0;
    let dragging = false;
    let repeating = false;
    let hold: number | undefined;
    let repeat: number | undefined;
    const fire = (): void => {
      this.buzz();
      if (direction === 'up') this.setPagedUp(true);
      this.hooks.page(direction);
    };
    const stop = (): void => {
      clearTimeout(hold);
      clearInterval(repeat);
      hold = repeat = undefined;
      button.classList.remove('pressed');
      this.el.classList.remove('dragging');
    };
    button.addEventListener('pointerdown', e => {
      if (!e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      pointer = e.pointerId;
      button.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startAt = this.at;
      dragging = repeating = false;
      button.classList.add('pressed');
      hold = window.setTimeout(() => {
        repeating = true;
        fire();
        repeat = window.setInterval(fire, REPEAT_MS);
      }, HOLD_MS);
    });
    button.addEventListener('pointermove', e => {
      if (e.pointerId !== pointer || repeating) return;
      const dy = e.clientY - startY;
      if (!dragging && Math.abs(dy) < DRAG_PX) return;
      if (!dragging) {
        dragging = true;
        clearTimeout(hold);
        this.el.classList.add('dragging');
      }
      const { top, bottom } = this.hooks.visibleRange();
      const room = Math.max(1, bottom - top - this.el.offsetHeight - 16);
      this.at = Math.max(0, Math.min(1, startAt + dy / room));
      this.place();
    });
    const end = (e: PointerEvent, cancelled: boolean): void => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      const tapped = !dragging && !repeating && !cancelled;
      if (dragging) {
        try { localStorage.setItem(STORE_KEY, String(this.at)); } catch { /* this session only */ }
      }
      stop();
      if (tapped) fire();
    };
    button.addEventListener('pointerup', e => end(e, false));
    button.addEventListener('pointercancel', e => end(e, true));
    button.addEventListener('lostpointercapture', e => end(e, true));
    // The tap was handled on pointerup; a synthesized click must not page again.
    button.addEventListener('click', e => e.preventDefault());
    button.addEventListener('contextmenu', e => e.preventDefault());
  }
}
