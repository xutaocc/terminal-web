import { randomUUID } from 'node:crypto';

export type ControlAction = 'acquire' | 'release' | 'request' | 'cancel' | 'grant' | 'deny' | 'takeover' | 'heartbeat' | 'interact';
export interface ControlClient {
  id: string; resume: string; principal: string; label: string; admin: boolean;
  readOnly?(): boolean; valid(): boolean; send(value: unknown): void;
}
interface Owner { client: ControlClient; connected: boolean; seen: number }
interface Room { explicit?: boolean; clients: Map<string, ControlClient>; owner?: Owner; requests: Set<string>; revision: number; policy?: string; epoch: number; fenceOwner?: Owner; size?: { cols: number; rows: number } }
/** One arbiter on the machine that owns the real tmux session, across all entry points. */
export class TerminalControl {
  private rooms = new Map<string, Room>();
  private closing = new Set<string>();
  /** Fence input and acquisitions throughout asynchronous terminal removal. */
  beginClose(key: string, force = false): (() => void) | null {
    if (this.closing.has(key)) return null;
    const room = this.rooms.get(key);
    if (room) { this.expire(room); if (room.owner && !force) return null; }
    this.closing.add(key);
    if (room) { room.owner = undefined; this.publish(room); }
    return () => { this.closing.delete(key); };
  }
  isClosing(key: string): boolean { return this.closing.has(key); }
  private explicit = new Set<string>();
  setExplicit(key: string): void { this.explicit.add(key); }
  constructor(private readonly now = Date.now, readonly graceMs = 15000) {}
  join(key: string, input: Omit<ControlClient, 'id'>, size?: {cols: number; rows: number}, autoAcquire = false): ControlClient {
    const client = { ...input, id: randomUUID() };
    let room = this.rooms.get(key);
    if (!room) this.rooms.set(key, room = { clients: new Map(), requests: new Set(), revision: 0, epoch: 0 });
    room.explicit = this.explicit.has(key);
    room.size ??= size;
    this.expire(room);
    room.clients.set(client.id, client);
    const owner = room.owner;
    if (!this.closing.has(key) && owner && !owner.connected && owner.client.resume === client.resume && owner.client.principal === client.principal && client.valid() && !client.readOnly?.()) {
      room.owner = { client, connected: true, seen: this.now() };
    }
    // Choose the default atomically with joining; never steal an existing lease.
    if (!this.closing.has(key) && !room.owner && autoAcquire && client.valid() && !client.readOnly?.()) {
      room.owner = { client, connected: true, seen: this.now() };
    }
    this.publish(room); return client;
  }
  owns(key: string, client: ControlClient): boolean {
    if (this.closing.has(key)) return false;
    const room = this.rooms.get(key); if (!room) return false;
    if (this.expire(room)) this.publish(room);
    return room.owner?.connected === true && room.owner.client === client && client.valid() && !client.readOnly?.();
  }
  /** A generation fences input that was accepted before release, even if the same client reacquires. */
  fence(key: string, client: ControlClient): number | undefined {
    return this.owns(key, client) ? this.rooms.get(key)!.epoch : undefined;
  }
  accepts(key: string, client: ControlClient, fence: number | undefined): boolean {
    return fence !== undefined && this.owns(key, client) && this.rooms.get(key)!.epoch === fence;
  }
  action(key: string, client: ControlClient, action: ControlAction, target?: string): void {
    if (this.closing.has(key)) return;
    const room = this.rooms.get(key); if (!room || room.clients.get(client.id) !== client || !client.valid()) return;
    if (this.expire(room)) this.publish(room);
    if (client.readOnly?.()) { this.send(room, client); return; }
    const mine = room.owner?.client === client && room.owner.connected;
    if (action === 'heartbeat') { if (mine) room.owner!.seen = this.now(); return; }
    if (action === 'interact' && mine) { room.owner!.seen = this.now(); return; }
    if ((action === 'interact' && !this.explicit.has(key)) || (action === 'acquire' && !room.owner) || (action === 'takeover' && client.admin)) {
      room.owner = { client, connected: true, seen: this.now() }; room.requests.delete(client.id);
    } else if (action === 'release' && mine) room.owner = undefined;
    else if (action === 'request' && room.owner && !mine) room.requests.add(client.id);
    else if (action === 'cancel') room.requests.delete(client.id);
    else if (action === 'deny' && mine && target) room.requests.delete(target);
    else if (action === 'grant' && mine && target && room.requests.has(target)) {
      const next = room.clients.get(target);
      if (next?.valid()) { room.owner = { client: next, connected: true, seen: this.now() }; room.requests.delete(target); }
    } else { this.send(room, client); return; }
    this.publish(room);
  }
  leave(key: string, client: ControlClient, release = false): void {
    const room = this.rooms.get(key); if (!room) return;
    room.clients.delete(client.id); room.requests.delete(client.id);
    if (room.owner?.client === client) {
      if (release || !client.valid()) room.owner = undefined;
      else { room.owner.connected = false; room.owner.seen = this.now(); }
    }
    this.publish(room); this.prune(key, room);
  }
  resize(key: string, client: ControlClient, size: {cols: number; rows: number}): void {
    if (!this.owns(key, client)) return;
    const room = this.rooms.get(key)!;
    if (room.size?.cols === size.cols && room.size?.rows === size.rows) return;
    room.size = size; this.publish(room);
  }
  revoke(principal: string): void {
    for (const room of this.rooms.values()) {
      if (room.owner?.client.principal === principal) { room.owner = undefined; this.publish(room); }
    }
  }
  sweep(): void {
    for (const [key, room] of this.rooms) {
      const policy = [...room.clients.values()].map(c => `${c.id}:${!!c.readOnly?.()}`).join(',');
      const changed = policy !== room.policy; room.policy = policy;
      if (this.expire(room) || changed) this.publish(room);
      this.prune(key, room);
    }
  }
  private expire(room: Room): boolean {
    if (room.owner && (!room.owner.client.valid() || room.owner.client.readOnly?.() || this.now() - room.owner.seen >= this.graceMs)) { room.owner = undefined; return true; }
    return false;
  }
  private prune(key: string, room: Room) { if (!room.clients.size && !room.owner) this.rooms.delete(key); }
  private publish(room: Room) {
    if (room.fenceOwner !== room.owner || !room.owner?.connected) { room.epoch++; room.fenceOwner = room.owner; }
    room.revision++;
    for (const client of room.clients.values()) this.send(room, client);
  }
  private send(room: Room, client: ControlClient) {
    const owner = room.owner;
    client.send({ type: 'control', explicit: !!room.explicit, readOnly: !!client.readOnly?.(), size: room.size, revision: room.revision, mine: !!owner?.connected && owner.client === client,
      owner: owner ? { label: owner.client.label, connected: owner.connected } : null,
      requested: room.requests.has(client.id), canTakeover: client.admin,
      requests: owner?.client === client ? [...room.requests].flatMap(id => { const c = room.clients.get(id); return c?.valid() ? [{ id, label: c.label }] : []; }) : [] });
  }
}
