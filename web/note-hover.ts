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
