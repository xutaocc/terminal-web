/** Gate only the terminal textarea; dialogs and desktop keyboards keep normal focus. */
export class TerminalKeyboardLock {
  private locked = false;
  private allowed = false;
  private readonly originalReadOnly: boolean;
  private readonly originalInputMode: string;

  constructor(
    private readonly textarea: HTMLTextAreaElement,
    private readonly touchDevice: boolean,
    private readonly focusTerminal: () => void,
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
