import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

export const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));

export function createWorker(options = {}) {
  return new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL('../src/index.js', import.meta.url)),
    compatibilityDate: config.compatibility_date,
    d1Databases: { DB: 'counter-test' },
    durableObjects: { COUNTER: { className: 'Counter', useSQLite: true } },
    bindings: config.vars,
    ...options
  });
}

export async function migrate(worker) {
  const db = await worker.getD1Database('DB');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(file, directory), 'utf8');
    for (const statement of sql.split(';').filter(part => part.trim())) {
      await db.prepare(statement).run();
    }
  }
}

// Test-only controls exercise the production class in workerd with deterministic
// time and persisted boundary state. None of these routes ship in the Worker.
const counterSource = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
export function createControlledWorker(options = {}) {
  return createWorker({
    scriptPath: undefined,
    script: counterSource + `
      export class TestCounter extends Counter {
        constructor(ctx, env) {
          super(ctx, env);
          this.sql.exec('CREATE TABLE IF NOT EXISTS test_clock (id INTEGER PRIMARY KEY, now INTEGER)');
          this.persistedRowsWritten = 0;
          const sql = this.sql;
          this.sql = { exec: (query, ...args) => {
            const cursor = sql.exec(query, ...args);
            if (query.includes('authoritative_counter')) this.persistedRowsWritten += cursor.rowsWritten;
            return cursor;
          } };
        }
        now() {
          return this.sql.exec('SELECT now FROM test_clock WHERE id = 1').toArray()[0]?.now ?? Date.now();
        }
        async fetch(request) {
          if (new URL(request.url).pathname !== '/__test') return super.fetch(request);
          const command = await request.json();
          await this.ctx.blockConcurrencyWhile(async () => {
            if (command.now !== undefined) this.sql.exec('INSERT OR REPLACE INTO test_clock VALUES (1, ?)', command.now);
            await this.initialize();
            if (command.seed) {
              const s = command.seed;
              this.sql.exec('UPDATE authoritative_counter SET value = ?, day = ?, used = ?, checkpoint = ?, flush_at = ?, flush_failures = 0 WHERE id = 1',
                s.value, s.day, s.used, s.checkpoint ?? s.value, s.flushAt ?? null);
            }
            await this.ctx.storage.sync();
          });
          if (command.alarm) await this.alarm();
          return Response.json({ ...this.snapshot(), state: this.state(),
            alarmAt: await this.ctx.storage.getAlarm(),
            rateBuckets: this.buckets.size, persistedRowsWritten: this.persistedRowsWritten });
        }
      }
    `,
    durableObjects: { COUNTER: { className: 'TestCounter', useSQLite: true } },
    ...options
  });
}

export async function control(worker, command = {}) {
  const namespace = await worker.getDurableObjectNamespace('COUNTER');
  const response = await namespace.getByName('shared-counter').fetch('https://counter.test/__test', {
    method: 'POST', body: JSON.stringify(command)
  });
  return response.json();
}
