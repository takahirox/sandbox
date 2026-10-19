import { DurableObject } from 'cloudflare:workers';

const token = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
const day = now => new Date(now).toISOString().slice(0, 10);
const keys = (value, expected) => Object.keys(value).sort().join(',') === expected.sort().join(',');

// A bounded signaling lobby, independent of all other sandbox games. No game
// messages, timers for physics, D1 writes, or persistent match history.
export class PongSignaling extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ipRates = new Map();
    ctx.blockConcurrencyWhile(async () => {
      this.data = await ctx.storage.get('lobby') ?? { day: day(this.now()), connections: 0, sessions: {} };
    });
  }
  now() { return Date.now(); }
  sockets() { return this.ctx.getWebSockets().filter(ws => ws.readyState === 1); }
  send(ws, message) { try { ws.send(JSON.stringify(message)); } catch { /* Close event cleans up. */ } }
  rate(ip, kind, capacity, refill) {
    const now = this.now();
    for (const [key, bucket] of this.ipRates) if (now - bucket.at > 60_000) this.ipRates.delete(key);
    const key = `${ip}:${kind}`, old = this.ipRates.get(key) ?? { left: capacity, at: now };
    const left = Math.min(capacity, old.left + Math.max(0, now - old.at) * refill / 1000);
    if (left < 1) return false;
    this.ipRates.set(key, { left: left - 1, at: now });
    return true;
  }
  async save() {
    await this.ctx.storage.put('lobby', this.data);
    const deadlines = [
      ...Object.values(this.data.sessions).map(s => s.expires),
      ...this.sockets().map(ws => ws.deserializeAttachment().expires)
    ];
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    else await this.ctx.storage.deleteAlarm();
  }
  end(id, type = 'expired') {
    delete this.data.sessions[id];
    for (const ws of this.sockets()) {
      if (ws.deserializeAttachment().session === id) {
        this.send(ws, { type }); ws.close(1000, 'Signaling ended');
      }
    }
  }
  sweep() {
    const now = this.now();
    for (const [id, session] of Object.entries(this.data.sessions)) if (session.expires <= now) this.end(id);
    for (const ws of this.sockets()) {
      if (ws.deserializeAttachment().expires <= now) {
        this.send(ws, { type: 'expired' }); ws.close(1008, 'Signaling expired');
      }
    }
  }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.sweep();
      const now = this.now(), ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (this.data.day !== day(now)) { this.data.day = day(now); this.data.connections = 0; }
      // The persistent daily cap bounds accepted work across hibernation/restarts;
      // soft IP limits bound bursts. Edge rejected requests still use Worker quota.
      if (this.data.connections >= 3000 || this.ctx.getWebSockets().length >= 64 || !this.rate(ip, 'connect', 20, 1 / 3)) {
        return Response.json({ error: 'Signaling busy; try later' }, { status: 429 });
      }
      this.data.connections++;
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ ip, session: null, seat: null, expires: now + 10_000, count: 0, ready: false });
      this.send(server, { type: 'hello' });
      await this.save();
      return new Response(null, { status: 101, webSocket: client });
    });
  }
  async webSocketMessage(ws, raw) {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.sweep();
      const a = ws.deserializeAttachment();
      const reject = () => ws.close(1008, 'Invalid or unauthorized signaling');
      if (a.expires <= this.now() || typeof raw !== 'string' || raw.length > 20_000 || ++a.count > 160
          || !this.rate(a.ip, 'signal', 200, 10)) { reject(); return; }
      ws.serializeAttachment(a);
      let m;
      try { m = JSON.parse(raw); } catch { reject(); return; }
      if (!m || typeof m !== 'object' || Array.isArray(m)) { reject(); return; }
      if (!a.session) {
        if (m.type === 'create' && keys(m, ['type']) && Object.keys(this.data.sessions).length < 24) {
          const id = token(16), invite = token(32), expires = this.now() + 300_000;
          this.data.sessions[id] = { invite, expires, joined: false, offer: false, answer: false, generation: 0 };
          Object.assign(a, { session: id, seat: 'host', expires });
          ws.serializeAttachment(a);
          this.send(ws, { type: 'created', session: id, invite, expires });
        } else if (m.type === 'join' && keys(m, ['type', 'session', 'invite'])
            && typeof m.session === 'string' && typeof m.invite === 'string'
            && /^[a-f0-9]{32}$/.test(m.session) && /^[a-f0-9]{64}$/.test(m.invite)) {
          const s = this.data.sessions[m.session];
          const host = this.sockets().find(peer => {
            const p = peer.deserializeAttachment(); return p.session === m.session && p.seat === 'host';
          });
          if (!s || s.joined || s.invite !== m.invite || !host) { reject(); return; }
          s.joined = true; s.invite = null; s.expires = this.now() + 90_000;
          Object.assign(a, { session: m.session, seat: 'guest', expires: s.expires });
          ws.serializeAttachment(a);
          const h = host.deserializeAttachment(); h.expires = s.expires; host.serializeAttachment(h);
          this.send(ws, { type: 'joined' }); this.send(host, { type: 'peer' });
        } else { reject(); return; }
        await this.save(); return;
      }
      const s = this.data.sessions[a.session];
      const peer = this.sockets().find(p => p !== ws && p.deserializeAttachment().session === a.session);
      if (!s || !peer || !s.joined) { reject(); return; }
      // Generations are scoped to these two authenticated seats. A single
      // restart never renews the absolute session expiry or consumes a new invite.
      const signalTypes = ['offer', 'answer', 'candidate', 'ready', 'retry'];
      if (!signalTypes.includes(m.type) || !Number.isInteger(m.generation) || m.generation < 0 || m.generation > 1) { reject(); return; }
      if (m.generation < s.generation) return; // In-flight previous-generation messages.
      if (m.generation !== s.generation) { reject(); return; }
      if (m.type === 'retry' && keys(m, ['type', 'generation']) && s.generation === 0) {
        s.generation = 1; s.offer = false; s.answer = false;
        for (const socket of [ws, peer]) {
          const attachment = socket.deserializeAttachment(); attachment.ready = false;
          socket.serializeAttachment(attachment);
          this.send(socket, { type: 'restart', generation: 1 });
        }
        await this.save();
      } else if ((m.type === 'offer' || m.type === 'answer') && keys(m, ['type', 'sdp', 'generation'])
          && typeof m.sdp === 'string' && /^v=0\r?\n/.test(m.sdp) && m.sdp.includes('m=application ') && m.sdp.length <= 16_000 && !/^a=candidate:.*\btyp relay\b/m.test(m.sdp)) {
        if (m.type === 'offer' ? a.seat !== 'host' || s.offer : a.seat !== 'guest' || !s.offer || s.answer) {
          reject(); return;
        }
        s[m.type] = true; this.send(peer, m); await this.save();
      } else if (m.type === 'candidate' && keys(m, ['type', 'candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment', 'generation'])
          && typeof m.candidate === 'string' && m.candidate.length <= 2048 && !/\btyp relay\b/.test(m.candidate)
          && (m.usernameFragment === null || typeof m.usernameFragment === 'string' && /^[a-zA-Z0-9+/]{1,256}$/.test(m.usernameFragment))
          && (m.sdpMid === null || typeof m.sdpMid === 'string' && m.sdpMid.length <= 64)
          && (m.sdpMLineIndex === null || Number.isInteger(m.sdpMLineIndex) && m.sdpMLineIndex >= 0 && m.sdpMLineIndex <= 16)) {
        this.send(peer, m);
      } else if (m.type === 'ready' && keys(m, ['type', 'generation']) && s.answer && !a.ready) {
        a.ready = true; ws.serializeAttachment(a);
        if (peer.deserializeAttachment().ready) { this.end(a.session, 'released'); await this.save(); }
      } else { reject(); }
    });
  }
  async webSocketClose(ws, code, reason) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const { session } = ws.deserializeAttachment();
      if (session && this.data.sessions[session]) this.end(session, 'peer-left');
      ws.close(1000, 'Signaling ended'); await this.save();
    });
  }
  async webSocketError(ws) { await this.webSocketClose(ws, 1011, 'Signaling disconnected'); }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => { this.sweep(); await this.save(); });
  }
}
