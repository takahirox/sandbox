import { readFile } from 'node:fs/promises';
import { createWorker } from './helpers.js';
import { until } from './rps-helpers.js';
export { until } from './rps-helpers.js';

const pong = (await readFile(new URL('../src/pong.js', import.meta.url), 'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';", '');
const source = (await readFile(new URL('../src/index.js', import.meta.url), 'utf8'))
  .replace("export { Bingo } from './bingo.js';", '')
  .replace("export { RockPaperScissors } from './rock-paper-scissors.js';", '')
  .replace("export { PongSignaling } from './pong.js';", pong);
export function createPongWorker(options = {}) {
  return createWorker({ scriptPath: undefined, script: source + `
    export class TestPong extends PongSignaling {
      now() { return this.clock ?? Date.now(); }
      async fetch(request) {
        if (new URL(request.url).pathname !== '/__test') return super.fetch(request);
        const command = await request.json();
        await this.ctx.blockConcurrencyWhile(async () => {
          if (command.now !== undefined) this.clock = command.now;
          if (command.connections !== undefined) { this.data.connections = command.connections; await this.save(); }
        });
        if (command.alarm) await this.alarm();
        return Response.json({ sessions: Object.keys(this.data.sessions).length,
          sockets: this.sockets().length, connections: this.data.connections,
          alarm: await this.ctx.storage.getAlarm() });
      }
    }
  `, durableObjects: { PONG: { className: 'TestPong', useSQLite: true } }, ...options });
}
export async function pongControl(worker, command = {}) {
  const ns = await worker.getDurableObjectNamespace('PONG');
  return (await ns.getByName('pong-lobby').fetch('https://pong.test/__test', { method: 'POST', body: JSON.stringify(command) })).json();
}
export async function connectPong(worker, ip = '192.0.2.1') {
  const response = await worker.dispatchFetch('https://pong.test/api/pong/ws', {
    headers: { Origin: 'https://takahirox.github.io', Upgrade: 'websocket', 'CF-Connecting-IP': ip }
  });
  assertUpgrade(response);
  const ws = response.webSocket, events = [];
  ws.addEventListener('message', e => events.push(JSON.parse(e.data)));
  const client = { ws, events, send: m => ws.send(JSON.stringify(m)) };
  ws.accept(); await until(() => events.some(e => e.type === 'hello')); return client;
}
function assertUpgrade(response) { if (response.status !== 101) throw new Error(`WebSocket status ${response.status}`); }
export async function createMatch(worker) {
  const host = await connectPong(worker); host.send({ type: 'create' });
  const invite = await until(() => host.events.find(e => e.type === 'created'));
  return { host, invite };
}
export async function joinMatch(worker, invite) {
  const guest = await connectPong(worker);
  guest.send({ type: 'join', session: invite.session, invite: invite.invite });
  await until(() => guest.events.some(e => e.type === 'joined')); return guest;
}
