/** Local month, day, hour and minute as MMDDHHmm. */
export function timeStamp(now = new Date()): string {
  return [now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()]
    .map(n => String(n).padStart(2, '0')).join('');
}

/**
 * An 8-digit MMDDHHmm that is a real date and time (month 01–12, day 01–31,
 * hour 00–23, minute 00–59) standing alone between separators — so a project
 * number like "V3" or a year like "2026" is never taken for one. An optional
 * "-N" right after it is the same-minute counter this file adds.
 */
const STAMP = /(^|[-_ ])(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:[01]\d|2[0-3])[0-5]\d(?:-\d{1,2})?(?=$|[-_ ])/g;

/**
 * The real name inside a label: every timestamp taken out — at the front (the
 * new style), at the end (the old style), or several in a row from labels
 * that were copied more than once — then stray separators tidied up.
 */
export function stripTimestamps(label: string): string {
  let name = label.replace(/[\x00-\x1f\x7f]/g, '');
  for (let before = ''; before !== name;) {
    before = name;
    name = name.replace(STAMP, '$1');
  }
  return name.replace(/([-_ ])[-_ ]+/g, '$1').replace(/^[-_ ]+|[-_ ]+$/g, '').trim();
}

/**
 * A new tab's suggested label: the time first, then the real name of the tab
 * it was made from, with that tab's own timestamps dropped — "10162244-name",
 * never "10162244-name-10151422". A base with no name left gives the time
 * alone. A second tab in the same minute counts on from the time
 * ("10162244-2-name"), so the name itself is never touched.
 */
export function newSessionName(base: string, used: Iterable<string>, now = new Date()): string {
  const stamp = timeStamp(now);
  const name = stripTimestamps(base);
  const occupied = new Set(used);
  let index = 1;
  let candidate: string;
  do {
    const head = index === 1 ? stamp : `${stamp}-${index}`;
    candidate = name ? `${head}-${name}`.slice(0, 64) : head;
    index++;
  } while (occupied.has(candidate));
  return candidate;
}

/** Where the real name starts in a suggested label, to select it for retyping. */
export function nameStart(label: string): number {
  const match = /^\d{8}(?:-\d{1,2})?-/.exec(label);
  return match ? match[0].length : 0;
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
  // The ID carries its own full timestamp; the one in the label adds nothing.
  const prefix = await sessionIdPrefix(stripTimestamps(label) || label);
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
