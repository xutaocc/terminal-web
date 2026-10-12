/** Browser-local MMDDHHmm, with a suffix for creations in the same minute. */
export function newSessionName(base: string, used: Iterable<string>, now = new Date()): string {
  const stamp = [now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()]
    .map(n => String(n).padStart(2, '0')).join('');
  const prefix = base.replace(/[^A-Za-z0-9_-]/g, '') || 'web';
  const occupied = new Set(used);
  let index = 1;
  let candidate: string;
  do {
    const suffix = `-${stamp}${index === 1 ? '' : `-${index}`}`;
    candidate = prefix.slice(0, 64 - suffix.length) + suffix;
    index++;
  } while (occupied.has(candidate));
  return candidate;
}
