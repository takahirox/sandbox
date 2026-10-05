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
      : path === '/api/counter/increment' ? 'POST' : null;
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
    if (method === 'POST' && origin !== env.ALLOWED_ORIGIN) {
      return json({ error: 'Origin required' }, 403);
    }

    try {
      // Always read the primary so a reload/device sees the latest committed write,
      // even if read replication is enabled later. A single UPDATE avoids lost writes.
      const db = env.DB.withSession('first-primary');
      const result = await db.prepare(method === 'GET'
        ? 'SELECT value FROM counter WHERE id = 1'
        : 'UPDATE counter SET value = value + 1 WHERE id = 1 RETURNING value'
      ).first();
      if (!result || !Number.isSafeInteger(result.value)) throw new Error('Invalid counter');
      return json({ value: result.value });
    } catch {
      return json({ error: 'Counter unavailable' }, 503);
    }
  }
};
