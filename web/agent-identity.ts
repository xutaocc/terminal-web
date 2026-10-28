/** Internal Agent names encode the immutable UUID; never persist the decorated label. */
export function agentSessionId(raw: string): string | null {
  const match = /^agent_([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/.exec(raw);
  return match ? match.slice(1).join('-') : null;
}
export function agentDisplayLabel(raw: string, label: string): string {
  const id = agentSessionId(raw);
  return id ? `${label.replace(/^(?:🌐\uFE0F?\s*)+/, '')} · #${id.slice(0, 8)}` : label;
}

/** A derived type badge, never part of the stored or editable session name. */
export function renderAgentLabel(element: HTMLElement, raw: string, label: string): void {
  element.replaceChildren();
  if (agentSessionId(raw)) {
    const badge = document.createElement('span');
    badge.className = 'session-agent-icon';
    badge.textContent = '🌐';
    badge.title = '远程 Agent 会话';
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', badge.title);
    element.append(badge, document.createTextNode(' '));
  }
  element.append(document.createTextNode(agentDisplayLabel(raw, label)));
}
