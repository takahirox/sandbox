import { DurableObject } from 'cloudflare:workers';

// D1 is the only source of truth. The object owns ordering and live sockets,
// never a second persisted counter or an in-memory cache of its value.
export class Counter extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    let intentId;
    if (path === '/api/counter/increment') {
      // Plain text keeps this a simple CORS POST. Empty bodies remain compatible
      // with existing API clients; identifiers correlate broadcasts, not retries.
      const body = await request.text();
      if (body) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body)) {
          return Response.json({ error: 'Invalid increment intent' }, { status: 400 });
        }
        intentId = body;
      }
    }
    // D1 awaits do not use Durable Object storage's automatic input gates.
    // Gate the entire read/write + send so snapshots and broadcasts cannot race.
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const db = this.env.DB.withSession('first-primary');
        const result = await db.prepare(path === '/api/counter/increment'
          ? 'UPDATE counter SET value = value + 1 WHERE id = 1 RETURNING value'
          : 'SELECT value FROM counter WHERE id = 1'
        ).first();
        if (!result || !Number.isSafeInteger(result.value) || result.value < 0) {
          throw new Error('Invalid counter');
        }
        const acknowledgement = intentId ? { value: result.value, intentId } : result;
        const message = JSON.stringify(acknowledgement);
        if (path === '/api/counter/ws') {
          const [client, server] = Object.values(new WebSocketPair());
          this.ctx.acceptWebSocket(server);
          server.send(message);
          return new Response(null, { status: 101, webSocket: client });
        }
        if (path === '/api/counter/increment') {
          for (const socket of this.ctx.getWebSockets()) {
            try {
              socket.send(message);
            } catch {
              // A disconnected listener must not turn a committed write into
              // a failed increment or stop delivery to other listeners.
              try { socket.close(1011, 'Reconnect to synchronize'); } catch {}
            }
          }
        }
        return Response.json(acknowledgement);
      } catch {
        return Response.json({ error: 'Counter unavailable' }, { status: 503 });
      }
    });
  }

  // Mutations use the existing POST endpoint, once per user click. WebSockets
  // are a push-only subscription and are managed by the Hibernation API.
  webSocketMessage(socket) {
    socket.close(1008, 'Use POST /api/counter/increment');
  }

  webSocketClose(socket, code, reason) {
    socket.close(code, reason);
  }

  webSocketError(socket) {
    socket.close(1011, 'Reconnect to synchronize');
  }
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
