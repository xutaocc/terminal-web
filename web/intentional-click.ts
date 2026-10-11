/** Native click keeps file-picker/fullscreen user activation; swipes never act. */
export function bindIntentionalClick(
  element: HTMLElement,
  action: (event: MouseEvent) => void,
  scroller?: HTMLElement,
): void {
  let gesture: {
    id: number; x: number; y: number; left: number; top: number;
    valid: boolean; released: boolean;
  } | null = null;
  let blocked = false;
  const movedScroll = (): boolean => Boolean(gesture && scroller &&
    (scroller.scrollLeft !== gesture.left || scroller.scrollTop !== gesture.top));
  element.addEventListener('pointerdown', event => {
    blocked = true;
    gesture = event.isPrimary && event.button === 0 ? {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      left: scroller?.scrollLeft ?? 0, top: scroller?.scrollTop ?? 0,
      valid: true, released: false,
    } : null;
  });
  element.addEventListener('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10 || movedScroll()) {
      gesture.valid = false; // returning to the starting point is still a swipe
    }
  });
  element.addEventListener('pointercancel', () => {
    gesture = null;
    blocked = true;
  });
  element.addEventListener('pointerup', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    gesture.released = true;
    gesture.valid &&= Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 10 &&
      !movedScroll();
    blocked = !gesture.valid;
  });
  scroller?.addEventListener('scroll', () => {
    if (gesture) { gesture.valid = false; blocked = true; }
  }, { passive: true });
  // Enter/Space and accessibility activation remain real clicks too.
  element.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { gesture = null; blocked = false; }
  });
  element.addEventListener('click', event => {
    const allowed = !blocked && (!gesture || (gesture.valid && gesture.released && !movedScroll()));
    gesture = null;
    if (!allowed) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    action(event);
  });
}
