/** Event identity and ordering, independent of a viewer’s read cursor. */
export interface SequencedStatus {
  instance?: string; version?: number; eventSeq?: number; unread: boolean;
}
export function newerStatus(previous: SequencedStatus | undefined, incoming: SequencedStatus): boolean {
  return previous?.instance !== incoming.instance || previous?.version === undefined || incoming.version === undefined || incoming.version >= previous.version;
}
