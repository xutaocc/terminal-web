/** Bounded, frame-drained wheel motion. Distances are CSS pixels. */
export class TouchScrollMotion {
  private pending = 0;
  private velocity = 0;
  private lastMove = 0;
  private lastFrame = 0;
  private releasedAt: number | null = null;

  start(now: number): void {
    this.cancel();
    this.lastMove = this.lastFrame = now;
  }

  move(pixels: number, now: number): void {
    const elapsed = Math.max(8, now - this.lastMove);
    const speed = Math.min(2, Math.abs(pixels) / elapsed);
    const gain = 1 + Math.min(1, speed * 0.65);
    // A reversal drops old momentum rather than fighting the new gesture.
    if (pixels * this.velocity < 0) this.pending = this.velocity = 0;
    const instantaneous = Math.max(-2, Math.min(2, pixels * gain / elapsed));
    this.velocity = this.velocity * 0.3 + instantaneous * 0.7;
    this.pending = Math.max(-120, Math.min(120, this.pending + pixels * gain));
    this.lastMove = now;
  }

  release(now: number): void {
    this.releasedAt = now;
    this.lastFrame = now;
    if (now - this.lastMove > 100 || Math.abs(this.velocity) < 0.15) this.velocity = 0;
  }

  frame(now: number): number {
    if (this.releasedAt !== null) {
      if (now - this.releasedAt >= 650) this.velocity = 0;
      const dt = Math.max(0, Math.min(40, now - this.lastFrame));
      const decay = Math.exp(-dt / 180);
      this.pending = Math.max(-120, Math.min(120,
        this.pending + this.velocity * 180 * (1 - decay)));
      this.velocity *= decay;
      if (Math.abs(this.velocity) < 0.08) this.velocity = 0;
    }
    this.lastFrame = now;
    const ticks = Math.max(-4, Math.min(4, Math.trunc(this.pending / 20)));
    this.pending -= ticks * 20;
    return ticks;
  }

  get active(): boolean {
    return Math.abs(this.pending) >= 20 ||
      (this.releasedAt !== null && this.velocity !== 0);
  }

  cancel(): void {
    this.pending = this.velocity = 0;
    this.releasedAt = null;
  }
}
