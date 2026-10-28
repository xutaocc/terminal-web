/** Mouse gestures and terminal replies must not exit history browsing. */
export function isKeyboardInput(input: string): boolean {
  return input.replace(
    /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[?>][\d;]*c|\x1b\[\d+;\d+R|\x1b\[\??\d+n|\x1b\[[IO]|\x1b\][\s\S]*?(?:\x07|\x1b\\)/g,
    '',
  ).length > 0;
}

/** Whether a chunk carries mouse-wheel reports (SGR buttons 64/65, either direction). */
export function hasWheelInput(input: string): boolean {
  return /\x1b\[<6[45];\d+;\d+M/.test(input);
}

/** Inputs that cannot enter mux copy-mode with the shipped bindings.
 * Escape alone, Ctrl/prefix keys, paste delimiters and unknown sequences stay slow.
 */
export function cacheableHistoryInput(input: string): boolean {
  return !!input && !/[\x00-\x1f\x7f]/.test(input.replace(/\x1b(?:\[[ABCDHF]|O[ABCDHF])|[\r\n\x7f\x08]/g, ''));
}

/** A bounded fast path for typing and ordinary editing keys.
 * Expiry is measured from the check, not the last key: native mux clients can
 * change modes without passing through this server.
 */
export class HistoryInputCheck {
  private revision = -1;
  private until = 0;

  allows(input: string, revision: number, now: number): boolean {
    return cacheableHistoryInput(input) &&
      revision === this.revision && now < this.until;
  }

  checked(revision: number, now: number): void {
    this.revision = revision;
    this.until = now + 250;
  }

  invalidate(): void { this.until = 0; }
}
