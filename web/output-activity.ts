/**
 * Output detection shared by PC and mobile indicators.
 * The first screen is a baseline, never new output. Attach/entry redraws are
 * ignored for 1.5 seconds; unchanged visible text never renews activity.
 * Explicit command submission ends this grace period to catch quick replies.
 * This is a text-change heuristic, not a CLI task-completion signal.
 */
export class OutputActivityTracker {
  private previous: string | undefined;
  private settleUntil: number;
  constructor(attachedAt: number, private readonly settleMs = 1500) {
    this.settleUntil = attachedAt + settleMs;
  }
  enter(now: number): void { this.settleUntil = now + this.settleMs; }
  input(): void { this.settleUntil = 0; }

  observe(text: string, now: number): boolean {
    const changed = this.previous !== undefined && text !== this.previous;
    this.previous = text;
    return changed && now >= this.settleUntil;
  }
}

/**
 * One icon, in priority order: spinning > bright unread dot > dim read dot.
 * New sessions start read. Entry clears unread immediately; browsing a menu or
 * selecting a drawer row without entering the terminal does not clear it.
 * Only successfully sent Enter/newline input arms activity; typing, mouse
 * reports and bracketed paste alone do not. Subsequent effective output marks
 * unread even while the terminal is being viewed, and starts/renews the spinner.
 * After 60 seconds without effective output, Session stops spinning, preserving
 * unread AND the submission flag. The WebSocket continues listening in real
 * time (no two-minute polling). Delayed output, even minutes later, immediately
 * restarts the spinner and the 60-second timer without another submission.
 * Reading and reconnecting do not disarm this listener. A new page/session
 * starts unarmed; an unopened session has no socket and cannot be monitored.
 * Because task completion is unknown, later text redraws after submission can
 * also count as activity; unchanged screens and entry replay remain filtered.
 * Entry during spinning clears unread without cancelling ongoing activity;
 * further output makes it unread again. Connection color is independent and
 * must never override this icon. State is local to this browser page.
 */
export class SessionReadState {
  unread = false;
  private submitted = false;
  input(data: string): boolean {
    const submitted = !data.includes('\x1b[200~') && /[\r\n]/.test(data);
    if (submitted) this.submitted = true;
    return submitted;
  }
  output(): boolean {
    if (!this.submitted) return false;
    this.unread = true;
    return true;
  }
  enter(): void { this.unread = false; }
  indicator(working: boolean): 'working' | 'unread' | 'read' {
    return working ? 'working' : this.unread ? 'unread' : 'read';
  }
}
