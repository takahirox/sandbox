import { DurableObject } from 'cloudflare:workers';
import { createCard, drawNumber, hasBingo } from './bingo-rules.js';

const BINGO_GRACE = 30_000;
const BINGO_BUDGET = 5_000;
const BINGO_CAPACITY = 128;
const bingoDay = now => new Date(now).toISOString().slice(0, 10);
const bingoCredential = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');

export class Bingo extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.buckets = new Map();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.data = await ctx.storage.get('bingo') ?? { game: crypto.randomUUID(), phase: 'waiting',
        called: [], players: [], caller: null, day: bingoDay(this.now()), used: 0 };
      // Hibernation preserves socket attachments; an actual runtime loss may not.
      const ids = new Set(this.sockets().map(ws => ws.deserializeAttachment().id));
      let changed = false;
      for (const p of this.data.players) if (p.socket && !ids.has(p.socket)) {
        p.socket = null; changed = true;
        if (this.data.caller?.player === p.id) this.data.caller.deadline ??= this.now() + BINGO_GRACE;
      }
      if (this.data.players.length && !this.data.players.some(p => p.socket) && !this.data.emptyDeadline) {
        this.data.emptyDeadline = this.now() + BINGO_GRACE; changed = true;
      }
      if (changed) await this.save();
    });
  }
  now() { return Date.now(); }
  sockets() { return this.ctx.getWebSockets().filter(ws => !ws.deserializeAttachment()?.closed); }
  send(ws, message) { try { ws.send(JSON.stringify(message)); } catch { /* Close/error releases caller. */ } }
  error(ws, reason) { this.send(ws, { type: 'error', reason }); }
  player(ws) { return this.data.players.find(p => p.socket === ws.deserializeAttachment().id); }
  take(key, capacity, rate) {
    const now = this.now();
    for (const [id, b] of this.buckets) if (now - b.time > 60_000) this.buckets.delete(id);
    const old = this.buckets.get(key);
    const tokens = old ? Math.min(capacity, old.tokens + Math.max(0, now - old.time) * rate / 1000) : capacity;
    if (tokens < 1) return false;
    this.buckets.set(key, { tokens: tokens - 1, time: now }); return true;
  }
  async save() {
    await this.ctx.storage.transaction(async storage => {
      await storage.put('bingo', this.data);
      const deadlines = [];
      if (this.data.caller?.deadline) deadlines.push(this.data.caller.deadline);
      if (this.data.used >= BINGO_BUDGET) deadlines.push(Date.parse(this.data.day) + 86_400_000);
      if (deadlines.length) await storage.setAlarm(Math.min(...deadlines));
      else await storage.deleteAlarm();
    });
    await this.ctx.storage.sync();
  }
  async expire() {
    let changed = false;
    if (this.data.day !== bingoDay(this.now())) {
      this.data.day = bingoDay(this.now()); this.data.used = 0; changed = true;
    }
    if (this.data.caller?.deadline && this.data.caller.deadline <= this.now()) {
      this.data.caller = null; changed = true;
    }
    if (changed) { await this.save(); this.broadcast(); }
  }
  snapshot(ws) {
    const p = this.player(ws), d = this.data;
    // Only this socket's own card/marks, plus a deliberate public game projection.
    return { type: 'snapshot', game: d.game, phase: d.phase, called: d.called,
      caller: d.caller ? { reconnectUntil: d.caller.deadline } : null,
      wins: d.players.filter(p => p.bingo).map(p => ({ player: p.id, draw: p.bingo })),
      participants: d.players.length, connected: d.players.filter(p => p.socket).length,
      playAvailable: d.used < BINGO_BUDGET,
      you: p ? { id: p.id, card: p.card, marks: p.marks, bingo: !!p.bingo,
        caller: d.caller?.player === p.id } : null };
  }
  broadcast() { for (const ws of this.sockets()) this.send(ws, this.snapshot(ws)); }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      if (request.headers.get('Origin') !== this.env.ALLOWED_ORIGIN) return new Response('Origin required', { status: 403 });
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Upgrade required', { status: 426 });
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('CF-Connecting-IP') ?? 'local'));
      const ip = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
      if (this.sockets().length >= BINGO_CAPACITY
          || this.sockets().filter(ws => ws.deserializeAttachment().ip === ip).length >= 32
          || !this.take(`connect:${ip}`, 10, 1)) return new Response('Connection limit reached', { status: 429 });
      await this.expire();
      const [client, server] = Object.values(new WebSocketPair());
      server.serializeAttachment({ id: crypto.randomUUID(), ip, seq: 0, tokens: 12, time: this.now(), joined: false });
      this.ctx.acceptWebSocket(server);
      this.send(server, { type: 'ready' });
      return new Response(null, { status: 101, webSocket: client });
    });
  }
  async disconnect(ws, code = 1000, reason = '') {
    const a = ws.deserializeAttachment();
    if (a.closed) return;
    const p = this.player(ws);
    a.closed = true; ws.serializeAttachment(a);
    if (p) {
      p.socket = null;
      if (this.data.caller?.player === p.id) this.data.caller.deadline ??= this.now() + BINGO_GRACE;
      if (!this.data.players.some(p => p.socket)) this.data.emptyDeadline = this.now() + BINGO_GRACE;
      await this.save(); this.broadcast();
    }
    try { ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason); } catch { /* Already closed. */ }
  }
  async webSocketMessage(ws, raw) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const a = ws.deserializeAttachment();
        if (a.closed) return;
        const invalid = () => this.disconnect(ws, 1008, 'Invalid message');
        if (typeof raw !== 'string' || raw.length > 512) return invalid();
        let m;
        try { m = JSON.parse(raw); } catch { return invalid(); }
        const schemas = { join: ['type', 'credential'], claim: ['type', 'game', 'seq'],
          release: ['type', 'game', 'seq'], start: ['type', 'game', 'seq'],
          draw: ['type', 'game', 'seq', 'expected'], reset: ['type', 'game', 'seq', 'confirm'],
          mark: ['type', 'game', 'seq', 'index'] };
        if (!m || Array.isArray(m) || typeof m !== 'object' || !Object.hasOwn(schemas, m.type)
            || Object.keys(m).some(k => !schemas[m.type].includes(k))) return invalid();
        const now = this.now();
        a.tokens = Math.min(12, a.tokens + Math.max(0, now - a.time) * 4 / 1000); a.time = now;
        if (a.tokens < 1 || !this.take(`message:${a.ip}`, 60, 20)) return this.disconnect(ws, 1008, 'Message limit reached');
        a.tokens--; ws.serializeAttachment(a);
        await this.expire();
        if (m.type === 'join') {
          if (a.joined || (m.credential !== undefined && (typeof m.credential !== 'string'
              || !/^[a-f0-9]{64}$/.test(m.credential)))) return invalid();
          let p = this.data.players.find(p => p.credential === m.credential);
          if (!p) {
            const full = this.data.players.length >= BINGO_CAPACITY;
            // Only a fresh game frees cards. Protect connected players and the
            // rejoin grace, even when nobody claimed the caller role.
            const abandoned = !this.data.players.some(p => p.socket) && !this.data.caller
              && this.data.emptyDeadline && this.data.emptyDeadline <= now;
            if (full && !abandoned) return this.error(ws, 'This game has 128 cards. Try again after a caller resets it, or 30 seconds after everyone leaves.');
            if (this.data.used >= BINGO_BUDGET) return this.error(ws, 'Daily play limit reached. Try tomorrow (UTC).');
            if (full) this.resetGame();
            p = { id: crypto.randomUUID(), credential: bingoCredential(), card: this.newCard(), marks: [12], bingo: null, socket: null };
            this.data.players.push(p); this.data.used++;
          }
          const old = this.sockets().find(s => s.deserializeAttachment().id === p.socket);
          p.socket = a.id;
          this.data.emptyDeadline = null;
          if (this.data.caller?.player === p.id) this.data.caller.deadline = null;
          a.joined = true; ws.serializeAttachment(a);
          await this.save();
          if (old) {
            const attachment = old.deserializeAttachment(); attachment.closed = true; old.serializeAttachment(attachment);
            old.close(4001, 'Card opened in another tab');
          }
          this.send(ws, { type: 'identity', credential: p.credential });
          this.broadcast(); return;
        }
        if (typeof m.game !== 'string' || !Number.isSafeInteger(m.seq) || m.seq < 1
            || (m.type === 'draw' && (!Number.isInteger(m.expected) || m.expected < 0 || m.expected > 75))
            || (m.type === 'mark' && (!Number.isInteger(m.index) || m.index < 0 || m.index > 24))
            || (m.type === 'reset' && m.confirm !== true)) return invalid();
        const p = this.player(ws);
        if (!p) return this.error(ws, 'Join before playing.');
        if (m.seq !== a.seq + 1) return this.error(ws, 'Duplicate or out-of-order action.');
        a.seq = m.seq; ws.serializeAttachment(a);
        if (m.game !== this.data.game) return this.error(ws, 'That game has ended.');
        const caller = this.data.caller;
        if (m.type === 'release') {
          if (caller?.player !== p.id) return this.error(ws, 'Only the caller can do that.');
          this.data.caller = null; await this.save(); this.broadcast(); return;
        }
        if (this.data.used >= BINGO_BUDGET) return this.error(ws, 'Daily play limit reached. Play resumes tomorrow (UTC).');
        let publicChange = true;
        if (m.type === 'claim') {
          if (caller) return this.error(ws, 'A caller already holds the role.');
          // The role is bound to the server-issued private participant credential.
          this.data.caller = { player: p.id, deadline: null };
        } else if (m.type === 'mark') {
          if (p.marks.includes(m.index)) return this.error(ws, 'Square already marked.');
          if (!this.data.called.includes(p.card[m.index])) return this.error(ws, 'That number has not been called.');
          p.marks.push(m.index);
          publicChange = !p.bingo && hasBingo(p.marks);
          if (publicChange) p.bingo = this.data.called.length;
        } else {
          if (caller?.player !== p.id) return this.error(ws, 'Only the caller can do that.');
          if (m.type === 'start') {
            if (this.data.phase !== 'waiting') return this.error(ws, 'Game already started.');
            this.data.phase = 'playing';
          } else if (m.type === 'draw') {
            if (this.data.phase !== 'playing' || m.expected !== this.data.called.length) return this.error(ws, 'Draw unavailable or already applied.');
            this.data.called.push(drawNumber(this.data.called));
            if (this.data.called.length === 75) this.data.phase = 'complete';
          } else if (m.type === 'reset') {
            this.resetGame();
          }
        }
        this.data.used++;
        await this.save();
        if (publicChange || this.data.used === BINGO_BUDGET) this.broadcast(); else this.send(ws, this.snapshot(ws));
      } catch {
        // Close and force a durable reload rather than continuing with uncommitted memory.
        ws.close(1011, 'Reconnect to synchronize'); throw new Error('Bingo action failed');
      }
    });
  }
  resetGame() {
    this.data.game = crypto.randomUUID(); this.data.phase = 'waiting'; this.data.called = [];
    this.data.emptyDeadline = null;
    this.data.players = this.data.players.filter(p => p.socket);
    for (const player of this.data.players) {
      player.card = this.newCard(player.card); player.marks = [12]; player.bingo = null;
    }
  }
  newCard(previous) {
    let card;
    do { card = createCard(); } while (JSON.stringify(card) === JSON.stringify(previous)
      || this.data.players.some(p => JSON.stringify(p.card) === JSON.stringify(card)));
    return card;
  }
  async alarm() { return this.ctx.blockConcurrencyWhile(() => this.expire()); }
  async webSocketClose(ws, code, reason) {
    return this.ctx.blockConcurrencyWhile(() => this.disconnect(ws, code, reason));
  }
  async webSocketError(ws) { return this.ctx.blockConcurrencyWhile(() => this.disconnect(ws, 1011, 'Reconnect')); }
}
