/** Right-click and stationary touch/pen holds, without consuming strip swipes. */
export function bindTabContext(
  element: HTMLElement,
  open: (x: number, y: number) => void,
  scroller?: HTMLElement,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { id: number; x: number; y: number; left: number; top: number } | null = null;
  let held = false;
  let scrollEvents: AbortController | undefined;
  const cancel = (): void => {
    clearTimeout(timer);
    timer = undefined;
    start = null;
    scrollEvents?.abort();
  };
  element.addEventListener('pointerdown', e => {
    cancel();
    held = false;
    if (!e.isPrimary || e.button !== 0 || e.pointerType === 'mouse' ||
        (e.target as Element).closest?.('.tab-close')) return;
    start = { id: e.pointerId, x: e.clientX, y: e.clientY,
      left: scroller?.scrollLeft ?? 0, top: scroller?.scrollTop ?? 0 };
    scrollEvents = new AbortController();
    scroller?.addEventListener('scroll', cancel, { passive: true, signal: scrollEvents.signal });
    timer = setTimeout(() => {
      const point = start;
      if (!point || !element.isConnected || (scroller &&
          (scroller.scrollLeft !== point.left || scroller.scrollTop !== point.top))) return;
      held = true;
      open(point.x, point.y);
      cancel();
    }, 550);
  });
  element.addEventListener('pointermove', e => {
    if (start && (e.pointerId !== start.id ||
        Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10)) cancel();
  });
  element.addEventListener('pointercancel', cancel);
  element.addEventListener('pointerleave', cancel);
  element.addEventListener('pointerup', e => {
    cancel();
    if (held) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, { capture: true });
  element.addEventListener('touchend', e => {
    if (held && e.cancelable) e.preventDefault();
  }, { capture: true, passive: false });
  element.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    cancel();
    if (!held) open(e.clientX, e.clientY);
    held = true;
  });
}
