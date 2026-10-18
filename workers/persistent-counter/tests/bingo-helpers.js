import { readFile } from 'node:fs/promises';
import { createWorker } from './helpers.js';
export { until } from './rps-helpers.js';
import { until } from './rps-helpers.js';

const rules = await readFile(new URL('../src/bingo-rules.js', import.meta.url), 'utf8');
const bingo = (await readFile(new URL('../src/bingo.js', import.meta.url), 'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';", '')
  .replace("import { createCard, drawNumber, hasBingo } from './bingo-rules.js';", rules);
const source = (await readFile(new URL('../src/index.js', import.meta.url), 'utf8'))
  .replace("export { RockPaperScissors } from './rock-paper-scissors.js';", '')
  .replace("export { PongSignaling } from './pong.js';", '')
  .replace("export { Bingo } from './bingo.js';", bingo);

export function createBingoWorker(options = {}) {
  return createWorker({ scriptPath: undefined, script: source + `
    export class TestBingo extends Bingo {
      now() { return this.clock ?? Date.now(); }
      async fetch(request) {
        if (new URL(request.url).pathname !== '/__test') return super.fetch(request);
        const command = await request.json();
        await this.ctx.blockConcurrencyWhile(async () => {
          if (command.now !== undefined) this.clock = command.now;
          if (command.limit) { this.data.used = 5_000; await this.save(); }
        });
        if (command.alarm) await this.alarm();
        return Response.json({ game: this.data.game, phase: this.data.phase, called: this.data.called,
          used: this.data.used, caller: this.data.caller, players: this.data.players,
          alarm: await this.ctx.storage.getAlarm() });
      }
    }
  `, durableObjects: { BINGO: { className: 'TestBingo', useSQLite: true } }, ...options });
}
export async function bingoControl(worker, command = {}) {
  const ns = await worker.getDurableObjectNamespace('BINGO');
  return (await ns.getByName('global-bingo').fetch('https://game.test/__test', {
    method: 'POST', body: JSON.stringify(command)
  })).json();
}
export async function subscribeBingo(worker, credential, ip = '192.0.2.1') {
  const response = await worker.dispatchFetch('https://game.test/api/bingo/ws', {
    headers: { Origin: 'https://takahirox.github.io', Upgrade: 'websocket', 'CF-Connecting-IP': ip }
  });
  if (response.status !== 101) throw new Error(`WebSocket status ${response.status}`);
  const ws = response.webSocket, events = [];
  let seq = 0;
  ws.addEventListener('message', e => { if (e.data !== 'pong') events.push(JSON.parse(e.data)); });
  ws.accept();
  await until(() => events.find(e => e.type === 'ready'));
  const client = { ws, events, send: m => ws.send(JSON.stringify(m)),
    get state() { return events.filter(e => e.type === 'snapshot').at(-1); },
    get credential() { return events.find(e => e.type === 'identity')?.credential; },
    action(type, extra = {}) {
      const m = { type, game: client.state?.game ?? '', seq: ++seq, ...extra };
      ws.send(JSON.stringify(m)); return m;
    } };
  client.send({ type: 'join', ...(credential ? { credential } : {}) });
  await until(() => client.state?.you || events.find(e => e.type === 'error'));
  return client;
}
export async function action(client, type, extra) {
  const start = client.events.length;
  client.action(type, extra);
  await until(() => client.events.slice(start).find(e => ['snapshot', 'error'].includes(e.type)));
  return client.events.slice(start).find(e => ['snapshot', 'error'].includes(e.type));
}
