import { hostOfKey, makeKey } from './hosts.js';

/**
 * The pinned sessions across every server, most recently pinned first within
 * each server. Servers keep their own pins, so each server's run stays together
 * and runs stay in the order the servers were given (`hostOrder`: '' is this
 * server). Which server answered first has no say in it.
 *
 * `pinned` is this page's list of pin keys; `host` is the server whose list is
 * `nextForHost` (its own session names, already in order).
 */
export function mergePins(
  pinned: readonly string[], host: string, nextForHost: readonly string[], hostOrder: readonly string[],
): string[] {
  const others = pinned.filter(key => hostOfKey(key) !== host);
  const next = nextForHost.map(name => makeKey(host, name));
  const runs = new Map<string, string[]>();
  for (const key of [...others, ...next]) {
    const h = hostOfKey(key);
    const run = runs.get(h) ?? [];
    run.push(key);
    runs.set(h, run);
  }
  if (!runs.has(host)) runs.set(host, []);
  // Servers not in hostOrder (e.g. one removed since) come last, by their own key.
  const order = [...new Set([...hostOrder, ...runs.keys()])].filter(h => runs.has(h));
  return order.flatMap(h => runs.get(h) ?? []);
}
