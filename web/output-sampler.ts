/** Bound screen inspection work without delaying terminal writes. */
export class OutputSampler {
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private sample: () => void, private intervalMs = 100) {}
  schedule(): void {
    if (this.closed || this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.sample(); }, this.intervalMs);
  }
  dispose(): void { this.closed = true; clearTimeout(this.timer); this.timer = undefined; }
}
