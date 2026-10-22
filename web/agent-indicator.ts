/** One session's status as the server reports it (see src/agent-status.ts). */
export interface AgentStatus {
  instance?: string;
  version?: number;
  eventSeq?: number;
  state: 'idle' | 'working' | 'waiting' | 'done';
  unread: boolean;
}

/** What a dot shows, most urgent first. */
export type Indicator = 'waiting' | 'working' | 'unread' | 'done' | 'idle';

export const INDICATOR_LABEL: Record<Indicator, string> = {
  waiting: '等待你确认',
  working: '执行中',
  unread: '已完成（未读）',
  done: '已完成',
  idle: '空闲',
};

/**
 * Fold several sessions into one dot — a split tab's two halves, or every
 * session on a sidebar card: whatever wants you most wins. A question beats a
 * running turn (it is blocked on you); a running turn beats an unread result.
 */
export function combineStatus(statuses: readonly (AgentStatus | undefined)[]): Indicator {
  const present = statuses.filter((s): s is AgentStatus => !!s);
  if (present.some(s => s.state === 'waiting')) return 'waiting';
  if (present.some(s => s.state === 'working')) return 'working';
  if (present.some(s => s.unread)) return 'unread';
  if (present.some(s => s.state === 'done')) return 'done';
  return 'idle';
}

/** Whether a dot in this state is asking for you (counted in the page title, tinted in the strip). */
export function wantsAttention(indicator: Indicator): boolean {
  return indicator === 'waiting' || indicator === 'unread';
}
