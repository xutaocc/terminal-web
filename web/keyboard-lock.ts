/** Gate only the terminal textarea; dialogs and desktop keyboards keep normal focus. */
export class TerminalKeyboardLock {
  private locked = false;
  private allowed = false;
  private readonly events = new AbortController();
  private readonly originalReadOnly: boolean;
  private readonly originalInputMode: string;

  constructor(
    private readonly textarea: HTMLTextAreaElement,
    private readonly touchDevice: boolean,
    private readonly focusTerminal: () => void,
    interactionTarget: EventTarget | undefined = textarea.ownerDocument,
  ) {
    this.originalReadOnly = textarea.readOnly;
    this.originalInputMode = textarea.inputMode;
    textarea.addEventListener('focus', () => {
      if (this.enabled && !this.allowed) textarea.blur();
    });
    textarea.addEventListener('blur', () => {
      this.allowed = false;
      this.apply();
    });
    // Mobile browsers can dismiss the IME without blurring the textarea.
    // Revoke the explicit-open permission before xterm handles another tap.
    interactionTarget?.addEventListener('pointerdown', event => {
      if (this.enabled && this.allowed && event.target !== textarea) {
        this.allowed = false;
        this.apply();
        textarea.blur();
      }
    }, { capture: true, signal: this.events.signal });
  }

  dispose(): void {
    this.events.abort();
  }

  private get enabled(): boolean {
    return this.touchDevice && this.locked;
  }

  setLocked(locked: boolean): void {
    if (locked === this.locked) return;
    this.locked = locked;
    this.allowed = false;
    this.apply();
    if (this.enabled) this.textarea.blur();
  }

  private apply(): void {
    const blocked = this.enabled && !this.allowed;
    this.textarea.readOnly = blocked || this.originalReadOnly;
    this.textarea.inputMode = blocked ? 'none' : this.originalInputMode;
  }

  focus(): void {
    if (!this.enabled) this.focusTerminal();
  }

  /** Must run synchronously inside the keyboard button's native click. */
  open(): void {
    // Refocusing also handles a keyboard dismissed by the OS while focus remained.
    if (this.enabled) this.textarea.blur();
    this.allowed = true;
    this.apply();
    this.focusTerminal();
  }
}
