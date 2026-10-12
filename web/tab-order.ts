export function moveTab<T>(tabs: readonly T[], source: T, target: T, after: boolean): T[] {
  if (source === target || !tabs.includes(source) || !tabs.includes(target)) return [...tabs];
  const ordered = tabs.filter(tab => tab !== source);
  ordered.splice(ordered.indexOf(target) + (after ? 1 : 0), 0, source);
  return ordered;
}

/** Server membership/names stay authoritative; cached order belongs to this browser. */
export function restoreTabOrder<T extends { name: string }>(tabs: readonly T[], names: readonly string[]): T[] {
  const positions = new Map(names.map((name, index) => [name, index]));
  return [...tabs].sort((a, b) => (positions.get(a.name) ?? Infinity) - (positions.get(b.name) ?? Infinity));
}
