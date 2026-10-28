import './agent-viewer.css';

export interface AgentSnapshot { text: string; truncated: boolean; limit: number }

/** A browser-local text snapshot: scrolling and selection never touch psmux. */
export class AgentViewer {
  readonly el = document.createElement('div');
  readonly viewport = document.createElement('div');
  private pre = document.createElement('pre');
  private status = document.createElement('span');
  private liveButton = document.createElement('button');
  private latest: AgentSnapshot | null = null;
  private shown: AgentSnapshot | null = null;
  private following = true;
  constructor() {
    this.el.className = 'agent-viewer';
    const bar = document.createElement('div'); bar.className = 'agent-viewer-tools';
    this.liveButton.textContent = '回到实时'; this.liveButton.type = 'button';
    this.liveButton.onclick = () => this.goLive();
    this.status.textContent = '正在读取终端…'; this.status.setAttribute('aria-live', 'polite');
    bar.append(this.status, this.liveButton);
    this.viewport.className = 'agent-viewer-viewport'; this.viewport.tabIndex = 0;
    this.viewport.setAttribute('aria-label', '远程 Agent 终端只读快照');
    this.viewport.append(this.pre); this.el.append(bar, this.viewport);
    // Freeze BEFORE native scrolling changes the viewport. New output must never
    // replace the text underneath a reader's scroll position or selection.
    this.viewport.addEventListener('wheel', e => { if (e.deltaY < 0) this.freeze(); }, {passive: true});
    this.viewport.addEventListener('touchstart', () => this.freeze(), {passive: true});
    this.viewport.addEventListener('pointerdown', () => this.freeze());
    this.viewport.addEventListener('scroll', () => {
      if (this.viewport.scrollTop < this.viewport.scrollHeight - this.viewport.clientHeight - 8) this.freeze();
    }, {passive: true});
    this.viewport.addEventListener('keydown', e => {
      const action = e.key === 'PageUp' ? 'up' : e.key === 'PageDown' ? 'down' : e.ctrlKey && e.key === 'Home' ? 'top' : e.ctrlKey && e.key === 'End' ? 'bottom' : null;
      if (action) { e.preventDefault(); this.scroll(action); }
      else if (e.key === 'ArrowUp' || e.key === 'Home') this.freeze();
    });
  }
  update(snapshot: AgentSnapshot): void {
    this.latest = snapshot;
    if (this.following || !this.shown) this.render();
    this.updateStatus();
  }
  error(message: string): void { this.status.textContent = message; }
  private freeze(): void { this.following = false; this.updateStatus(); }
  private render(): void {
    if (!this.latest) return;
    this.shown = this.latest; this.pre.textContent = this.shown.text;
    this.viewport.scrollTop = this.viewport.scrollHeight;
  }
  private updateStatus(): void {
    const pending = this.latest?.text !== this.shown?.text;
    const suffix = this.latest?.truncated ? ` · 显示最近 ${this.latest.limit} 行以内` : '';
    this.status.textContent = (this.following ? '实时查看' : pending ? '浏览历史 · 有新输出' : '浏览历史') + suffix;
    this.liveButton.hidden = this.following;
  }
  goLive(): void { this.following = true; this.render(); this.updateStatus(); }
  scroll(action: 'up' | 'down' | 'top' | 'bottom'): void {
    if (action === 'bottom') { this.goLive(); return; }
    this.freeze();
    if (action === 'top') this.viewport.scrollTop = 0;
    else this.viewport.scrollTop += (action === 'up' ? -1 : 1) * this.viewport.clientHeight * .8;
  }
  wheel(ticks: number): void { this.freeze(); this.viewport.scrollTop -= ticks * 48; }
}
