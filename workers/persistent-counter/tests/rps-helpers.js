import { readFile } from 'node:fs/promises';
import { createWorker } from './helpers.js';

const source = (await readFile(new URL('../src/index.js', import.meta.url), 'utf8'))
  .replace("export { Bingo } from './bingo.js';", '')
  .replace("export { RockPaperScissors } from './rock-paper-scissors.js';",
    (await readFile(new URL('../src/rock-paper-scissors.js', import.meta.url), 'utf8'))
      .replace("import { DurableObject } from 'cloudflare:workers';", ''));

export function createRpsWorker(options = {}) {
  return createWorker({ scriptPath: undefined, script: source + `
    export class TestRps extends RockPaperScissors {
      now() { return this.clock ?? Date.now(); }
      async fetch(request) {
        if (new URL(request.url).pathname !== '/__test') return super.fetch(request);
        const command = await request.json();
        await this.ctx.blockConcurrencyWhile(async () => {
          if (command.now !== undefined) {
            this.clock = command.now;
            await this.ctx.storage.put('clock', command.now);
          } else this.clock = await this.ctx.storage.get('clock');
          if (command.limit) { this.data.used = 5_000; await this.save(); }
        });
        if (command.alarm) await this.alarm();
        return Response.json({ rooms: this.data.rooms.map(r => this.view(r)),
          alarm: await this.ctx.storage.getAlarm(), used: this.data.used });
      }
    }
  `, durableObjects: { RPS: { className: 'TestRps', useSQLite: true } }, ...options });
}
export async function rpsControl(worker, command = {}) {
  const ns = await worker.getDurableObjectNamespace('RPS');
  return (await ns.getByName('five-rooms').fetch('https://game.test/__test', {
    method: 'POST', body: JSON.stringify(command)
  })).json();
}
export async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for WebSocket event');
}
export async function subscribe(worker, ip = '192.0.2.1') {
  const response = await worker.dispatchFetch('https://game.test/api/rps/ws', {
    headers: { Origin: 'https://takahirox.github.io', Upgrade: 'websocket', 'CF-Connecting-IP': ip }
  });
  if (response.status !== 101) throw new Error(`WebSocket status ${response.status}`);
  const ws = response.webSocket, events = [];
  ws.addEventListener('message', e => { if (e.data !== 'pong') events.push(JSON.parse(e.data)); });
  ws.accept();
  const client = { ws, events, send: msg => ws.send(JSON.stringify(msg)),
    get state() { return events.filter(e => e.type === 'snapshot').at(-1); },
    get credential() { return events.find(e => e.type === 'seat')?.credential; } };
  await until(() => client.state);
  return client;
}
export async function join(client, mode = 'play', room = 1, credential) {
  client.send({ type: 'join', room, mode, ...(credential ? { credential } : {}) });
  await until(() => client.state.room?.id === room);
  return client;
}
export async function pair(worker) {
  const a = await join(await subscribe(worker));
  const b = await join(await subscribe(worker));
  await until(() => a.state.room.match.phase === 'playing');
  return [a, b];
}
export function move(client, hand, extra = {}) {
  const m = client.state.room.match;
  client.send({ type: 'move', match: m.id, round: m.round, hand, ...extra });
}
