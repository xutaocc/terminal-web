/** Navigation follows the complete sidebar order, including folded/read sessions. */
export type QuickSessionKind = 'unread' | 'working';
export interface QuickSessionEntry { name: string; kind: QuickSessionKind | null }

export class QuickSessionNavigator {
  private readonly cursors = new Map<QuickSessionKind, { name: string; order: string[] }>();

  next(kind: QuickSessionKind, entries: readonly QuickSessionEntry[]): string | null {
    const eligible = new Set(entries.filter(e => e.kind === kind).map(e => e.name));
    if (!eligible.size) return null;
    const order = entries.map(e => e.name);
    const cursor = this.cursors.get(kind);
    let next: string | undefined;
    if (cursor) {
      // Keep the anchor even after it becomes read. If it was closed, continue
      // with the next surviving candidate from the previous traversal.
      const scan = order.includes(cursor.name) ? order : cursor.order;
      const at = scan.indexOf(cursor.name);
      for (let step = 1; step <= scan.length; step++) {
        const name = scan[(at + step) % scan.length];
        if (eligible.has(name)) { next = name; break; }
      }
    }
    next ??= order.find(name => eligible.has(name));
    if (!next) return null;
    this.cursors.set(kind, { name: next, order });
    return next;
  }
}
