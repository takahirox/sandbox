import { DurableObject } from 'cloudflare:workers';

const DAILY_LIMIT = 20_000;
const FLUSH_MS = 5_000;
const FLUSH_COUNT = 100;
const CLIENT_RATE = { rate: 15, capacity: 30 };
const IP_RATE = { rate: 150, capacity: 300 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utcDay = now => new Date(now).toISOString().slice(0, 10);
const resetAt = day => Date.parse(`${day}T00:00:00Z`) + 86_400_000;

export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Soft, two-second burst controls. Idle hibernation outlasts their full
    // refill window. Avoid spending two extra persistent writes per click;
    // a runtime restart may grant a fresh burst, never a fresh daily budget.
    this.buckets = new Map();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS authoritative_counter (
        id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL,
        day TEXT NOT NULL, used INTEGER NOT NULL, checkpoint INTEGER NOT NULL,
        flush_at INTEGER, flush_failures INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  now() { return Date.now(); }

  state() {
    return this.sql.exec('SELECT * FROM authoritative_counter WHERE id = 1').toArray()[0];
  }

  async initialize() {
    if (this.state()) return;
    // Import the existing D1 count only once. A stale/missing D1 checkpoint
    // must never replace already acknowledged Durable Object state.
    const row = await this.env.DB.withSession('first-primary')
      .prepare('SELECT value FROM counter WHERE id = 1').first();
    if (!row || !Number.isSafeInteger(row.value) || row.value < 0) throw new Error('Invalid counter');
    // Legacy D1 has no click timestamps. Conservatively charge its imported
    // total to the rollout day, avoiding a second daily allowance on migration.
    // The next UTC day starts at zero; later restarts always use stored usage.
    this.sql.exec(`INSERT INTO authoritative_counter (id, value, day, used, checkpoint)
      VALUES (1, ?, ?, ?, ?)`, row.value, utcDay(this.now()), Math.min(row.value, DAILY_LIMIT), row.value);
    await this.ctx.storage.sync();
  }

  currentState() {
    const state = this.state();
    const day = utcDay(this.now());
    if (state.day !== day) {
      state.day = day;
      state.used = 0;
      this.sql.exec('UPDATE authoritative_counter SET day = ?, used = 0 WHERE id = 1', day);
    }
    return state;
  }

  snapshot(state = this.currentState()) {
    return {
      value: state.value,
      budget: { day: state.day, used: state.used, limit: DAILY_LIMIT, resetAt: resetAt(state.day) },
      checkpoint: state.checkpoint,
      checkpointPending: state.value !== state.checkpoint,
      checkpointFailures: state.flush_failures
    };
  }

  bucket(key, policy, now) {
    const row = this.buckets.get(key);
    const tokens = row ? Math.min(policy.capacity,
      row.tokens + Math.max(0, now - row.updated_at) * policy.rate / 1000) : policy.capacity;
    return { key, tokens, retryAfterMs: Math.max(0, Math.ceil((1 - tokens) * 1000 / policy.rate)) };
  }

  async schedule(state) {
    const midnight = state.used >= DAILY_LIMIT ? resetAt(state.day) : null;
    const next = state.flush_at === null ? midnight
      : midnight === null ? state.flush_at : Math.min(state.flush_at, midnight);
    const existing = await this.ctx.storage.getAlarm();
    if (next !== null && existing !== next) await this.ctx.storage.setAlarm(next);
    else if (next === null && existing !== null) await this.ctx.storage.deleteAlarm();
  }

  async acceptIntent(identity, intentId) {
    let result;
    let consumed;
    // The count, daily usage, and alarm are one durable transaction.
    // Gate the entire decision + send so parallel sockets/HTTP cannot overflow
    // the budget or reorder acknowledgements while awaiting persistence.
    await this.ctx.storage.transaction(async () => {
      const state = this.currentState();
      const now = this.now();
      let reason;
      let retryAfterMs = 0;
      if (state.used >= DAILY_LIMIT) {
        reason = 'daily_limit';
        retryAfterMs = Math.max(0, resetAt(state.day) - now);
      } else if (state.value >= Number.MAX_SAFE_INTEGER) {
        reason = 'counter_full';
      }
      const client = this.bucket(`client:${identity.clientId}`, CLIENT_RATE, now);
      const ip = this.bucket(`ip:${identity.ip}`, IP_RATE, now);
      if (!reason && (client.tokens < 1 || ip.tokens < 1)) {
        reason = client.tokens < 1 ? 'client_rate_limit' : 'ip_rate_limit';
        retryAfterMs = Math.max(client.retryAfterMs, ip.retryAfterMs);
      }
      if (!reason) {
        consumed = [client, ip].map(bucket => ({ ...bucket, tokens: bucket.tokens - 1, updated_at: now }));
        state.value++;
        state.used++;
        state.flush_at ??= now + FLUSH_MS;
        // During a D1 outage, keep the retry backoff even under heavy traffic.
        if (!state.flush_failures && state.value - state.checkpoint >= FLUSH_COUNT) {
          state.flush_at = Math.min(state.flush_at, now);
        }
        this.sql.exec(`UPDATE authoritative_counter SET value = ?, used = ?, flush_at = ? WHERE id = 1`,
          state.value, state.used, state.flush_at);
      }
      await this.schedule(state);
      result = { type: 'incrementResult', outcome: reason ? 'rejected' : 'accepted',
        ...(intentId ? { intentId } : {}), ...this.snapshot(state),
        ...(reason ? { reason, retryAfterMs } : {}) };
    });
    await this.ctx.storage.sync();
    if (consumed) {
      for (const bucket of consumed) this.buckets.set(bucket.key, bucket);
      this.broadcast(result);
    }
    return result;
  }

  send(socket, message) {
    try { socket.send(JSON.stringify(message)); }
    catch { try { socket.close(1011, 'Reconnect to synchronize'); } catch {} }
  }

  broadcast(message) {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, message);
  }

  async identity(request) {
    const provided = new URL(request.url).searchParams.get('clientId');
    if (provided !== null && !UUID.test(provided)) throw new Error('Invalid client identity');
    // CF supplies this header at the public edge. Ignore user-supplied forwarded
    // headers and message bodies. Retain only a hash, never the raw address.
    const address = request.headers.get('CF-Connecting-IP') || 'unknown';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
    const ip = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    return { clientId: provided?.toLowerCase() || `legacy:${ip}`, ip };
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    let identity;
    let intentId;
    if (path !== '/api/counter') {
      try { identity = await this.identity(request); }
      catch { return Response.json({ error: 'Invalid client identity' }, { status: 400 }); }
    }
    if (path === '/api/counter/increment') {
      const body = await request.text();
      if (body && !UUID.test(body)) {
        return Response.json({ error: 'Invalid increment intent' }, { status: 400 });
      }
      intentId = body || undefined;
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.initialize();
        if (path === '/api/counter/increment') {
          const result = await this.acceptIntent(identity, intentId);
          return Response.json(result, { status: result.outcome === 'accepted' ? 200 : 429,
            headers: result.retryAfterMs ? { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)) } : {} });
        }
        const previousDay = this.state().day;
        const state = this.currentState();
        await this.schedule(state);
        await this.ctx.storage.sync();
        const snapshot = { type: 'snapshot', ...this.snapshot(state) };
        // A read/subscription can precede the midnight alarm and cancel it.
        // Push the persisted rollover so existing daily-limited pages unlock.
        if (state.day !== previousDay) this.broadcast(snapshot);
        if (path === '/api/counter/ws') {
          const [client, server] = Object.values(new WebSocketPair());
          this.ctx.acceptWebSocket(server);
          server.serializeAttachment(identity);
          this.send(server, snapshot);
          return new Response(null, { status: 101, webSocket: client });
        }
        return Response.json(snapshot);
      } catch {
        return Response.json({ error: 'Counter unavailable' }, { status: 503 });
      }
    });
  }

  async webSocketMessage(socket, message) {
    let intent;
    try {
      if (typeof message !== 'string' || message.length > 256) throw new Error('Invalid intent');
      intent = JSON.parse(message);
      if (intent.type !== 'increment' || !UUID.test(intent.intentId)) throw new Error('Invalid intent');
    } catch {
      socket.close(1008, 'Invalid increment intent');
      return;
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.initialize();
        // Attachments survive hibernation; the message cannot change identity.
        const result = await this.acceptIntent(socket.deserializeAttachment(), intent.intentId);
        if (result.outcome === 'rejected') this.send(socket, result);
      } catch {
        // Persistence may have committed before an unexpected failure. Reconcile
        // from a fresh snapshot and never encourage a mutation retry.
        socket.close(1011, 'Could not confirm push; reconnect to synchronize');
      }
    });
  }

  async alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.initialize();
      let state = this.currentState();
      const now = this.now();
      if (state.value !== state.checkpoint && state.flush_at <= now) {
        try {
          // Absolute, monotonic checkpoints make retries safe after a crash
          // between D1 success and recording its completion in object storage.
          const row = await this.env.DB.withSession('first-primary')
            .prepare('UPDATE counter SET value = MAX(value, ?) WHERE id = 1 RETURNING value')
            .bind(state.value).first();
          if (!row) throw new Error('Missing checkpoint');
          this.sql.exec(`UPDATE authoritative_counter SET checkpoint = ?, flush_at = NULL,
            flush_failures = 0 WHERE id = 1`, state.value);
        } catch {
          const failures = state.flush_failures + 1;
          const delay = Math.min(3_600_000, 30_000 * 2 ** Math.min(failures - 1, 7));
          this.sql.exec('UPDATE authoritative_counter SET flush_failures = ?, flush_at = ? WHERE id = 1',
            failures, now + delay);
        }
        // Fully refilled entries can be forgotten. Only accepted intents add
        // entries, so the daily budget also bounds this map during a D1 outage.
        for (const [key, bucket] of this.buckets) {
          if (bucket.updated_at <= now - 2_000) this.buckets.delete(key);
        }
      }
      state = this.currentState();
      await this.schedule(state);
      await this.ctx.storage.sync();
      // Also pushes the midnight reset to pages disabled by the daily limit.
      this.broadcast({ type: 'snapshot', ...this.snapshot(state) });
    });
  }

  webSocketClose(socket, code, reason) { socket.close(code, reason); }
  webSocketError(socket) { socket.close(1011, 'Reconnect to synchronize'); }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' });
    const json = (data, status = 200) => Response.json(data, { status, headers });

    // Reject foreign origins before any write, including simple POST requests.
    if (origin && origin !== env.ALLOWED_ORIGIN) {
      return json({ error: 'Origin not allowed' }, 403);
    }
    if (origin === env.ALLOWED_ORIGIN) {
      headers.set('Access-Control-Allow-Origin', origin);
    }

    const path = new URL(request.url).pathname;
    const method = path === '/api/counter' ? 'GET'
      : path === '/api/counter/increment' ? 'POST'
      : path === '/api/counter/ws' ? 'GET' : null;
    if (!method) return json({ error: 'Not found' }, 404);

    if (request.method === 'OPTIONS') {
      if (origin !== env.ALLOWED_ORIGIN
          || request.headers.get('Access-Control-Request-Method') !== method
          || request.headers.get('Access-Control-Request-Headers')) {
        return json({ error: 'Preflight not allowed' }, 403);
      }
      headers.set('Access-Control-Allow-Methods', method);
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== method) {
      headers.set('Allow', `${method}, OPTIONS`);
      return json({ error: 'Method not allowed' }, 405);
    }
    if ((method === 'POST' || path === '/api/counter/ws') && origin !== env.ALLOWED_ORIGIN) {
      return json({ error: 'Origin required' }, 403);
    }
    if (path === '/api/counter/ws' && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket upgrade required' }, 426);
    }

    try {
      const response = await env.COUNTER.getByName('shared-counter').fetch(request);
      if (response.status === 101) return response;
      const outgoing = new Response(response.body, response);
      for (const [key, value] of headers) outgoing.headers.set(key, value);
      return outgoing;
    } catch {
      return json({ error: 'Counter unavailable' }, 503);
    }
  }
};
