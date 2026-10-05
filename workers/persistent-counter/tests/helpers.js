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
