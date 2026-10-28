import { WebSocket } from 'ws';

interface Snapshot { text: string; truncated: boolean; limit: number }
interface Room { clients: Set<WebSocket>; timer?: NodeJS.Timeout; last?: Snapshot; active: boolean; capturing: boolean; dirty: boolean; due: number; lastCapture: number }

/** Browser viewers never attach a PTY or join the input arbiter. capture-pane
 * reads history without copy-mode, mouse input, resizing or Shell side effects. */
export class AgentViewerHub {
  private rooms = new Map<string, Room>();
  constructor(private capture: (name: string) => Promise<Snapshot>, private intervalMs = 2000, private outputIntervalMs = 200) {}

  attach(ws: WebSocket, name: string): void {
    let room = this.rooms.get(name);
    if (!room) { room = { clients: new Set(), active: true, capturing: false, dirty: false, due: 0, lastCapture: -Infinity }; this.rooms.set(name, room); }
    room.clients.add(ws);
    const send = (data: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
    send({ type: 'control', agentReadOnly: true, explicit: true, readOnly: true, revision: 1,
      mine: false, owner: null, requested: false, canTakeover: false, requests: [],
      historyUrl: '/api/agent-history?session=' + encodeURIComponent(name) });
    if (room.last) send({ type: 'agent-snapshot', ...room.last });
    // No binary input and no control, scroll, restart or resize messages are accepted.
    ws.on('message', (data, binary) => {
      if (binary || data.toString().length > 1024) return;
      try { if (JSON.parse(data.toString()).type === 'ping') send({ type: 'pong' }); } catch { /* ignore */ }
    });
    ws.on('pong', () => { (ws as WebSocket & {isAlive: boolean}).isAlive = true; });
    ws.once('close', () => {
      room!.clients.delete(ws);
      if (!room!.clients.size) {
        room!.active = false; clearTimeout(room!.timer); this.rooms.delete(name);
      }
    });
    if (room.clients.size === 1) void this.poll(name, room);
  }

  /** Coalesce output bursts; never run overlapping captures for one session. */
  notifyOutput(name: string): void {
    const room = this.rooms.get(name);
    if (!room?.active) return;
    room.dirty = true;
    if (!room.capturing) this.schedule(name, room, Math.max(0, this.outputIntervalMs - (Date.now() - room.lastCapture)));
  }

  private schedule(name: string, room: Room, delay: number): void {
    const due = Date.now() + delay;
    if (room.timer !== undefined && room.due <= due) return;
    clearTimeout(room.timer);
    room.due = due;
    room.timer = setTimeout(() => { room.timer = undefined; void this.poll(name, room); }, delay);
    room.timer.unref();
  }

  private async poll(name: string, room: Room): Promise<void> {
    if (!room.active || room.capturing) return;
    room.capturing = true;
    room.dirty = false;
    let failed = false;
    try {
      const snapshot = await this.capture(name);
      if (!room.active) return;
      if (!room.last || snapshot.text !== room.last.text || snapshot.truncated !== room.last.truncated) {
        room.last = snapshot;
        this.broadcast(room, { type: 'agent-snapshot', ...snapshot });
      }
    } catch {
      failed = true;
      if (room.active) this.broadcast(room, { type: 'agent-snapshot-error', message: '暂时无法读取终端；保留当前画面，正在重试' });
    }
    room.capturing = false;
    room.lastCapture = Date.now();
    if (room.active) this.schedule(name, room, room.dirty && !failed ? this.outputIntervalMs : this.intervalMs);
  }
  private broadcast(room: Room, value: unknown): void {
    const message = JSON.stringify(value);
    for (const ws of room.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, 'viewer too slow'); continue; }
      ws.send(message);
    }
  }
}
