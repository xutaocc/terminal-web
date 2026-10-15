/** Hover opens an editor; only an explicit close resets it. */
export class NoteHover {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private opened = false;
  constructor(private readonly open: () => boolean) {}
  enter(): void {
    clearTimeout(this.timer);
    if (!this.opened) this.timer = setTimeout(() => { this.opened = this.open(); }, 450);
  }
  leave(): void {
    clearTimeout(this.timer);
  }
  reset(): void {
    clearTimeout(this.timer);
    this.opened = false;
  }
}

/** A preview may dismiss after a grace period; an editor stays until explicit close. */
export class NoteDismiss {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pinned = false;
  constructor(private readonly close: () => void) {}
  enter(): void { clearTimeout(this.timer); this.timer = undefined; }
  leave(): void {
    if (this.pinned || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.pinned) this.close();
    }, 700);
  }
  edit(): void { this.pinned = true; this.enter(); }
  dispose(): void { this.enter(); }
}
