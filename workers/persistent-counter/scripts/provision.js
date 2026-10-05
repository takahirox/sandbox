import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// The token stays in memory and is never written to either generated config.
export async function provision({ accountId, token, config, fetchApi = fetch }) {
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? '') || !token) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
  }
  async function api(path, method = 'GET', body, allowMissingSubdomain = false) {
    const response = await fetchApi(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000)
    });
    const data = await response.json();
    if (allowMissingSubdomain && response.status !== 401 && response.status !== 403
        && data.errors?.length === 1 && data.errors[0].code === 10007) return null;
    if (!response.ok || !data.success) {
      // Do not echo response bodies: they may contain account details or credentials.
      const codes = (data.errors ?? []).map(error => Number(error.code)).join(',');
      throw new Error(`Cloudflare ${method} ${path.split('?')[0]} failed (HTTP ${response.status}; codes ${codes})`);
    }
    return data.result;
  }

  let subdomain = (await api('workers/subdomain', 'GET', undefined, true))?.subdomain;
  if (!subdomain) {
    const suffix = createHash('sha256').update(accountId).digest('hex').slice(0, 16);
    subdomain = (await api('workers/subdomain', 'PUT', { subdomain: `sandbox-${suffix}` })).subdomain;
  }
  if (!/^[a-z0-9-]+$/.test(subdomain)) throw new Error('Invalid Workers subdomain');

  const binding = config.d1_databases[0];
  let database;
  // Filter by name, but match exactly and page through partial matches.
  for (let page = 1; ; page++) {
    const databases = await api(`d1/database?name=${encodeURIComponent(binding.database_name)}&per_page=100&page=${page}`);
    database = databases.find(entry => entry.name === binding.database_name);
    if (database || databases.length < 100) break;
  }
  if (!database) database = await api('d1/database', 'POST', { name: binding.database_name });
  if (!database.uuid) throw new Error('D1 database ID missing');
  return {
    config: { ...config, d1_databases: [{ ...binding, database_id: database.uuid }] },
    apiUrl: `https://${config.name}.${subdomain}.workers.dev`
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
    const result = await provision({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
      config
    });
    await writeFile(new URL('../wrangler.generated.json', import.meta.url), JSON.stringify(result.config, null, 2) + '\n');
    // Only the public endpoint is added to the Pages artifact; never the D1 binding.
    await writeFile(new URL('../../../projects/persistent-counter/api-config.json', import.meta.url),
      JSON.stringify({ apiUrl: result.apiUrl }) + '\n');
    console.log('D1 binding and public API configuration prepared.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
