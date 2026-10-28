import './terminal-control.css';
export interface ControlState {
  agentReadOnly?: boolean; explicit?: boolean; historyUrl?: string;
  type: 'control'; readOnly?: boolean; revision: number; mine: boolean; size?: {cols: number; rows: number};
  owner: {label: string; connected: boolean} | null;
  requested: boolean; canTakeover: boolean; requests: {id: string; label: string}[];
}
// A tab's reconnect credential, never exposed in owner/request labels. Different
// live transports still cannot own concurrently, including a duplicated tab.
export const terminalClientId = (() => {
  const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2,'0')).join('');
  try { let id=sessionStorage.getItem('tw.control.client'); if (!id || !/^[a-f0-9]{48}$/.test(id)) { id=fresh();sessionStorage.setItem('tw.control.client',id); } return id; }
  catch { return fresh(); }
})();
export class ControlBar {
  readonly el = document.createElement('div');
  state: ControlState | null = null;
  constructor(private historyPath: (path: string) => string = path => path) {
    this.el.className = 'terminal-control'; this.el.setAttribute('aria-label','终端操作权'); this.disconnected();
  }
  unsupported(): void { this.el.hidden=false; this.el.textContent='请升级此主机服务'; }
  disconnected(): void { this.state=null; this.el.hidden=true; }
  update(state: ControlState): void {
    if (this.state && state.revision < this.state.revision) return;
    this.state=state;
    if (typeof state.readOnly !== 'boolean') { this.unsupported(); return; }
    this.el.hidden=true;
    this.el.textContent='';
    if (state.explicit) {
      this.el.hidden = false;
      const label = document.createElement('span'); label.className = 'control-label';
      label.textContent = '远程 Agent 会话 · 只读';
      this.el.append(label);
      if (state.historyUrl?.startsWith('/api/agent-history?')) {
        const history = document.createElement('a'); history.textContent = '操作记录'; history.href = this.historyPath(state.historyUrl);
        history.target = '_blank'; history.rel = 'noopener'; this.el.append(history);
      }
    }
  }
}
