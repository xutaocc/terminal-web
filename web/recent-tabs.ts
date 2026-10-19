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
