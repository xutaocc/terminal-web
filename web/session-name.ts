/** Browser-local MMDDHHmm, with a suffix for creations in the same minute. */
export function newSessionName(base: string, used: Iterable<string>, now = new Date()): string {
  const stamp = [now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()]
    .map(n => String(n).padStart(2, '0')).join('');
  const prefix = base.replace(/[\x00-\x1f\x7f]/g, '').trim() || 'web';
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

/** Translate the display label; unknown Han characters and failures use a safe base. */
export async function sessionIdPrefix(
  label: string,
  transliterate?: (text: string) => string,
): Promise<string> {
  try {
    let romanized = label;
    if (/\p{Script=Han}/u.test(label)) {
      if (transliterate) romanized = transliterate(label);
      else {
        const { pinyin } = await import('pinyin-pro');
        romanized = pinyin(label, { toneType: 'none', type: 'array', v: true }).join('');
      }
    }
    if (/\p{Script=Han}/u.test(romanized)) return 'web';
    return romanized.replace(/[^A-Za-z0-9_-]/g, '') || 'web';
  } catch {
    return 'web';
  }
}

/** Internal IDs always include full local time plus entropy for cross-device creation. */
export async function newSessionId(label: string, used: Iterable<string>, now = new Date()): Promise<string> {
  const stamp = String(now.getFullYear()) +
    [now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(n => String(n).padStart(2, '0')).join('') + String(now.getMilliseconds()).padStart(3, '0');
  // getRandomValues also works on the app's plain-HTTP LAN URLs.
  const random = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map(n => n.toString(16).padStart(2, '0')).join('');
  const prefix = await sessionIdPrefix(label);
  const occupied = new Set(used);
  let index = 1;
  let candidate: string;
  do {
    const suffix = `-${stamp}-${random}${index === 1 ? '' : `-${index}`}`;
    // Leave room for the split terminal's __b suffix within the protocol limit.
    candidate = prefix.slice(0, 61 - suffix.length) + suffix;
    index++;
  } while (occupied.has(candidate));
  return candidate;
}
