/** Internal Agent names encode the immutable UUID; never persist the decorated label. */
export function agentSessionId(raw: string): string | null {
  const match = /^agent_([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/.exec(raw);
  return match ? match.slice(1).join('-') : null;
}
export function agentDisplayLabel(raw: string, label: string): string {
  const id = agentSessionId(raw);
  return id ? `${label} · #${id.slice(0, 8)}` : label;
}
