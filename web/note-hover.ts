/** Delayed hover entry/exit lets the mouse cross from a tab into its editor. */
export class NoteHover {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private opened = false;
  constructor(
    private readonly open: () => boolean,
    private readonly close: () => boolean,
  ) {}
  enter(): void {
    clearTimeout(this.timer);
    if (!this.opened) this.timer = setTimeout(() => { this.opened = this.open(); }, 450);
  }
  leave(): void {
    clearTimeout(this.timer);
    if (this.opened) this.timer = setTimeout(() => {
      if (this.close()) this.reset();
    }, 300);
  }
  reset(): void {
    clearTimeout(this.timer);
    this.opened = false;
  }
}
