/**
 * When a drag in the terminal selects nothing the browser can copy, and when
 * to say so. With tmux's mouse mode on (and full-screen programs that take the
 * mouse), a plain drag goes to tmux, not to xterm.js: tmux paints its own
 * highlight, xterm.js has no selection, and nothing reaches the clipboard. The
 * modifier that forces a local selection is Option on a Mac, Shift elsewhere.
 */
export function forceSelectKey(mac: boolean): string {
  return mac ? '⌥ Option' : 'Shift';
}

/** A drag that should earn the hint: real movement, no modifier, nothing selected by us. */
export function shouldHintDrag(opts: {
  dx: number; dy: number; modifier: boolean; selected: boolean; mouseTracking: boolean;
}): boolean {
  const moved = Math.hypot(opts.dx, opts.dy) >= 12;
  return moved && !opts.modifier && !opts.selected && opts.mouseTracking;
}

const HINT_KEY = 'tw.selectHintCount';
const HINT_LIMIT = 3;

/** The hint is shown a few times per device, then left alone. */
export function takeHintTurn(storage: Pick<Storage, 'getItem' | 'setItem'> | null): boolean {
  try {
    const shown = Number(storage?.getItem(HINT_KEY) ?? 0) || 0;
    if (shown >= HINT_LIMIT) return false;
    storage?.setItem(HINT_KEY, String(shown + 1));
    return true;
  } catch {
    return true;
  }
}

/**
 * Text from an OSC 52 clipboard write ("c;<base64>", "p;<base64>", ";<base64>").
 * tmux sends one when something is copied inside it, so its own selections can
 * land in the browser clipboard too. Null for a query ("?") or anything malformed.
 */
export function decodeOsc52(data: string): string | null {
  const semi = data.indexOf(';');
  if (semi < 0) return null;
  const payload = data.slice(semi + 1);
  if (!payload || payload === '?') return null;
  if (payload.length > 1_400_000 || !/^[A-Za-z0-9+/=\s]+$/.test(payload)) return null;
  try {
    const bytes = Uint8Array.from(atob(payload.replace(/\s+/g, '')), c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
