import { DurableObject } from 'cloudflare:workers';

const GRACE = 60_000;
const LIMIT = 5_000;
const hands = ['rock', 'paper', 'scissors'];
const dayOf = now => new Date(now).toISOString().slice(0, 10);
const freshMatch = () => ({ id: crypto.randomUUID(), phase: 'waiting', round: 1,
  score: [0, 0], moves: [null, null], results: [], winner: null, rematch: [false, false] });
const freshRooms = () => Array.from({ length: 5 }, (_, i) => ({ id: i + 1,
  seats: [null, null], match: freshMatch() }));

export function roundWinner(a, b) {
  return a === b ? null : (hands.indexOf(a) - hands.indexOf(b) + 3) % 3 === 1 ? 0 : 1;
}

export class RockPaperScissors extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.buckets = new Map();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.data = await ctx.storage.get('game') ?? { rooms: freshRooms(), day: dayOf(this.now()), used: 0 };
      // Hibernation retains sockets and attachments. After a runtime restart,
      // missing sockets become disconnected; never extend an existing deadline.
      const ids = new Set(ctx.getWebSockets().map(ws => ws.deserializeAttachment()?.id));
      let changed = false;
      for (const room of this.data.rooms) for (const seat of room.seats) {
        if (seat?.socket && !ids.has(seat.socket)) {
          seat.socket = null;
          seat.deadline ??= this.now() + GRACE;
          changed = true;
        }
      }
      if (changed) await this.save();
    });
  }

  now() { return Date.now(); }
  sockets() { return this.ctx.getWebSockets().filter(ws => !ws.deserializeAttachment()?.closed); }
  send(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch { /* Close/error callback releases its seat. */ }
  }
  error(ws, reason) { this.send(ws, { type: 'error', reason }); }

  take(key, capacity, rate) {
    const now = this.now();
    // Bounded by recent traffic rather than all visitors since object creation.
    if (!this.prunedAt || now - this.prunedAt > 60_000) {
      for (const [id, b] of this.buckets) if (now - b.time > 60_000) this.buckets.delete(id);
      this.prunedAt = now;
    }
    const b = this.buckets.get(key);
    const tokens = b ? Math.min(capacity, b.tokens + Math.max(0, now - b.time) * rate / 1000) : capacity;
    if (tokens < 1) return false;
    this.buckets.set(key, { tokens: tokens - 1, time: now });
    return true;
  }

  async save() {
    // State and its earliest cleanup/reset alarm commit together, before push.
    await this.ctx.storage.transaction(async storage => {
      await storage.put('game', this.data);
      const deadlines = this.data.rooms.flatMap(r => r.seats.filter(s => s?.deadline).map(s => s.deadline));
      if (this.data.used >= LIMIT) deadlines.push(Date.parse(this.data.day) + 86_400_000);
      const alarm = deadlines.length ? Math.min(...deadlines) : null;
      if (alarm !== null) await storage.setAlarm(alarm);
      else await storage.deleteAlarm();
    });
    await this.ctx.storage.sync();
  }

  async expire() {
    let changed = false;
    if (this.data.day !== dayOf(this.now())) {
      this.data.day = dayOf(this.now()); this.data.used = 0; changed = true;
    }
    for (const room of this.data.rooms) {
      let released = false;
      room.seats = room.seats.map(seat => {
        if (seat?.deadline !== null && seat?.deadline <= this.now()) {
          released = true; return null;
        }
        return seat;
      });
      if (released) { room.match = freshMatch(); changed = true; }
    }
    if (changed) { await this.save(); this.broadcast(); }
  }

  view(room, spectators) {
    const m = room.match;
    // Deliberate public projection: never serialize seats/credentials or moves.
    return { id: room.id, status: room.seats.every(Boolean) ? 'In progress'
      : room.seats.some(Boolean) ? 'Waiting for opponent' : 'Empty',
    players: room.seats.map(s => s ? { connected: !!s.socket, reconnectUntil: s.deadline } : null),
    match: { id: m.id, phase: m.phase, round: m.round, score: m.score,
      submitted: m.moves.map(Boolean), results: m.results, winner: m.winner, rematch: m.rematch },
    spectators: spectators ?? this.sockets().filter(ws => {
      const a = ws.deserializeAttachment();
      return a.room === room.id && !room.seats.some(s => s?.socket === a.id);
    }).length };
  }

  snapshot(ws, views) {
    const a = ws.deserializeAttachment();
    const room = this.data.rooms.find(r => r.id === a.room);
    const seat = room?.seats.findIndex(s => s?.socket === a.id) ?? -1;
    return { type: 'snapshot', rooms: this.data.rooms.map(r => ({ id: r.id,
      status: r.seats.every(Boolean) ? 'In progress' : r.seats.some(Boolean) ? 'Waiting for opponent' : 'Empty',
      players: r.seats.filter(Boolean).length })), room: room ? views?.[room.id - 1] ?? this.view(room) : null,
    you: seat >= 0 ? { role: 'player', seat } : { role: room ? 'spectator' : 'lobby' },
    playAvailable: this.data.used < LIMIT };
  }
  broadcast() {
    // Count spectators once per push, so fan-out is linear in connections.
    const sockets = this.sockets(), counts = [0, 0, 0, 0, 0];
    for (const ws of sockets) {
      const a = ws.deserializeAttachment(), room = this.data.rooms[a.room - 1];
      if (room && !room.seats.some(s => s?.socket === a.id)) counts[a.room - 1]++;
    }
    const views = this.data.rooms.map((room, i) => this.view(room, counts[i]));
    for (const ws of sockets) this.send(ws, this.snapshot(ws, views));
  }

  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      if (request.headers.get('Origin') !== this.env.ALLOWED_ORIGIN) return new Response('Origin required', { status: 403 });
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Upgrade required', { status: 426 });
      await this.expire();
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('CF-Connecting-IP') ?? 'local'));
      const ip = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      if (this.sockets().filter(ws => ws.deserializeAttachment().ip === ip).length >= 32
          || !this.take(`connect:${ip}`, 20, 2)) return new Response('Too many connections', { status: 429 });
      const [client, server] = Object.values(new WebSocketPair());
      server.serializeAttachment({ id: crypto.randomUUID(), ip, room: null, tokens: 12, time: this.now() });
      this.ctx.acceptWebSocket(server);
      this.send(server, this.snapshot(server));
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  async detach(ws, release) {
    const a = ws.deserializeAttachment();
    const room = this.data.rooms.find(r => r.id === a.room);
    const index = room?.seats.findIndex(s => s?.socket === a.id) ?? -1;
    if (index >= 0) {
      if (release) { room.seats[index] = null; room.match = freshMatch(); }
      else { room.seats[index].socket = null; room.seats[index].deadline = this.now() + GRACE; }
      await this.save();
    }
    a.room = null;
    ws.serializeAttachment(a);
  }

  async webSocketMessage(ws, raw) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.expire();
        const a = ws.deserializeAttachment();
        if (a.closed) return;
        if (typeof raw !== 'string' || raw.length > 512) return this.closeInvalid(ws);
        let msg;
        try { msg = JSON.parse(raw); } catch { return this.closeInvalid(ws); }
        if (!msg || Array.isArray(msg) || typeof msg !== 'object') return this.closeInvalid(ws);
        const schemas = { join: ['type', 'room', 'mode', 'credential'], leave: ['type'],
          move: ['type', 'match', 'round', 'hand'], rematch: ['type', 'match'] };
        if (typeof msg.type !== 'string' || !Object.hasOwn(schemas, msg.type)
            || Object.keys(msg).some(k => !schemas[msg.type].includes(k))) return this.closeInvalid(ws);
        const now = this.now();
        a.tokens = Math.min(12, a.tokens + Math.max(0, now - a.time) * 4 / 1000); a.time = now;
        if (a.tokens < 1 || !this.take(`message:${a.ip}`, 60, 20)) {
          ws.serializeAttachment(a); return this.error(ws, 'Too fast. Please wait a moment.');
        }
        a.tokens--; ws.serializeAttachment(a);
        if (msg.type === 'join') {
          if (!Number.isInteger(msg.room) || msg.room < 1 || msg.room > 5
              || !['play', 'spectate'].includes(msg.mode)
              || (msg.credential !== undefined && !/^[a-f0-9]{64}$/.test(msg.credential))) return this.closeInvalid(ws);
          // A spectator must leave before electing to claim a free seat.
          if (a.room !== null) return this.error(ws, 'Leave this room before joining another.');
          const room = this.data.rooms[msg.room - 1];
          let index = msg.mode === 'play' && msg.credential
            ? room.seats.findIndex(s => s?.credential === msg.credential) : -1;
          if (msg.credential && msg.mode === 'play' && index < 0) {
            return this.error(ws, 'Seat expired. Join again to play or watch.');
          }
          if (index >= 0) {
            // Reload can arrive before the old socket's close event. Take over;
            // old close/messages cannot affect the seat after its socket changes.
            const old = this.sockets().find(s => s.deserializeAttachment().id === room.seats[index].socket);
            if (old) {
              const attachment = old.deserializeAttachment(); attachment.closed = true;
              old.serializeAttachment(attachment); old.close(4001, 'Seat opened in another tab');
            }
          } else if (msg.mode === 'play' && this.data.used < LIMIT) {
            index = room.seats.findIndex(s => s === null);
            if (index >= 0) {
              const bytes = crypto.getRandomValues(new Uint8Array(32));
              room.seats[index] = { credential: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''),
                socket: null, deadline: null };
              this.data.used++;
            }
          }
          a.room = room.id; ws.serializeAttachment(a);
          if (index >= 0) {
            room.seats[index].socket = a.id; room.seats[index].deadline = null;
            if (room.seats.every(Boolean) && room.match.phase === 'waiting') room.match.phase = 'playing';
            await this.save();
            this.send(ws, { type: 'seat', room: room.id, credential: room.seats[index].credential });
          }
          this.broadcast(); return;
        }
        if (msg.type === 'leave') {
          await this.detach(ws, true);
          this.send(ws, { type: 'left' }); this.broadcast(); return;
        }
        const room = this.data.rooms.find(r => r.id === a.room);
        const index = room?.seats.findIndex(s => s?.socket === a.id) ?? -1;
        if (index < 0) return this.error(ws, 'Only players can do that.');
        const m = room.match;
        if (msg.match !== m.id) return this.error(ws, 'That match has ended.');
        if (!room.seats.every(s => s?.socket)) return this.error(ws, 'Waiting for the other player to reconnect.');
        if (this.data.used >= LIMIT) return this.error(ws, 'Daily play limit reached. Play resumes tomorrow (UTC).');
        if (msg.type === 'move') {
          if (!hands.includes(msg.hand) || !Number.isSafeInteger(msg.round)) return this.closeInvalid(ws);
          if (m.phase !== 'playing' || msg.round !== m.round || m.moves[index]) return this.error(ws, 'Choice already locked or round ended.');
          m.moves[index] = msg.hand;
          if (m.moves.every(Boolean)) {
            const winner = roundWinner(...m.moves);
            if (winner !== null) m.score[winner]++;
            m.results.push({ round: m.round, hands: [...m.moves], winner });
            m.results = m.results.slice(-10);
            m.moves = [null, null];
            if (m.score.some(s => s === 3)) { m.phase = 'complete'; m.winner = winner; }
            else m.round++;
          }
        } else {
          if (m.phase !== 'complete' || m.rematch[index]) return this.error(ws, 'Rematch is unavailable or already requested.');
          m.rematch[index] = true;
          if (m.rematch.every(Boolean)) { room.match = freshMatch(); room.match.phase = 'playing'; }
        }
        this.data.used++;
        await this.save(); this.broadcast();
      } catch {
        ws.close(1011, 'Reconnect to synchronize');
        // blockConcurrencyWhile resets the object if this error escapes, so
        // uncommitted in-memory mutations can never become authoritative.
        throw new Error('Game persistence failed');
      }
    });
  }

  closeInvalid(ws) { ws.close(1008, 'Invalid message'); }
  async webSocketClose(ws, code, reason) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const a = ws.deserializeAttachment();
      if (!a.closed) { await this.detach(ws, false); a.closed = true; a.room = null; ws.serializeAttachment(a); }
      ws.close(code, reason); this.broadcast();
    });
  }
  async webSocketError(ws) { return this.webSocketClose(ws, 1011, 'Reconnect to synchronize'); }
  async alarm() {
    return this.ctx.blockConcurrencyWhile(async () => { await this.expire(); await this.save(); });
  }
}
