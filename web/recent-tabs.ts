/**
 * The sessions most recently picked by hand, newest first. Their tabs are
 * underlined, darker the more recent, so the ones in use stand out from a long
 * strip. Local and remote sessions share the one list.
 */

/** How many recent sessions are marked. Change it here and nowhere else. */
export const RECENT_TABS_MAX = 10;

/** `list` with `name` moved to the front, at most `max` long (the oldest drops off). */
export function touchRecent(list: readonly string[], name: string, max = RECENT_TABS_MAX): string[] {
  return [name, ...list.filter(n => n !== name)].slice(0, Math.max(0, max));
}

/** `list` without the sessions that are gone. */
export function keepRecent(list: readonly string[], alive: (name: string) => boolean): string[] {
  return list.filter(alive);
}

/**
 * How strongly a session's underline is drawn: 1 for the most recent, falling
 * evenly to a faint floor for the last of `max`; 0 for one not in the list.
 */
export function recentStrength(list: readonly string[], name: string, max = RECENT_TABS_MAX): number {
  const at = list.indexOf(name);
  if (at < 0) return 0;
  const floor = 0.3;
  return max <= 1 ? 1 : 1 - (1 - floor) * (at / (max - 1));
}

/** Navigation capacity is independent of the ten highlighted tabs. */
export const RECENT_VISITS_DEFAULT = 8;
export const RECENT_VISITS_LIMIT = 50;
export function visitCapacity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(RECENT_VISITS_LIMIT, Math.round(value))) : RECENT_VISITS_DEFAULT;
}

/** Keep the MRU order stable while cycling; offline entries retain their slots. */
export function nextRecentVisit(list: readonly string[], current: string | null, available: (name: string) => boolean): string | null {
  const at = current === null ? -1 : list.indexOf(current);
  for (let step = 1; step <= list.length; step++) {
    const name = list[(at + step) % list.length];
    if (available(name)) return name;
  }
  return null;
}

/** One-time migration from the original five-session default. */
export function storedVisitCapacity(value: unknown, version: unknown): number {
  return value === 5 && version !== 2 ? RECENT_VISITS_DEFAULT : visitCapacity(value);
}

/** Presentation order never changes the MRU list used for eviction/navigation. */
export function sortRecentEntries<T extends { title: string; name: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN', { numeric: true, sensitivity: 'base' })
    || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
}

/** Explicit removals win over stale server responses and legacy highlights. */
export function restoreRecentVisits(value: unknown, removed: ReadonlySet<string>, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string => typeof name === 'string' && !removed.has(name)))].slice(0, max);
}
