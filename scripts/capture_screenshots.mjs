// Build-time only. Reuse the repository's pinned Playwright installation.
import { chromium } from '../workers/persistent-counter/node_modules/playwright/index.mjs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const types = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.txt': 'text/plain',
};
const visualResources = new Set(['document', 'stylesheet', 'script', 'image', 'font']);
export const coverName = name => createHash('sha256').update(name).digest('hex').slice(0, 16) + '.jpg';

// Serve only the generated artifact at its deployed base path. There are no API
// handlers here, even for same-origin GET requests with mutating-looking URLs.
export async function previewServer(output) {
  output = resolve(output);
  const server = createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (!pathname.startsWith('/sandbox/')) { response.writeHead(404).end(); return; }
      const path = resolve(output, '.' + pathname.slice('/sandbox'.length) + (pathname.endsWith('/') ? 'index.html' : ''));
      if (!path.startsWith(output + sep)) { response.writeHead(404).end(); return; }
      const body = await readFile(path);
      response.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

export async function captureSite(output, projects) {
  const covers = resolve(output, 'covers');
  // Never retain a stale image after a failed capture or a deleted project.
  await rm(covers, { recursive: true, force: true });
  await mkdir(covers, { recursive: true });
  const preview = await previewServer(output);
  let browser;
  const report = Object.create(null);
  try {
    browser = await chromium.launch();
    for (const name of projects) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
        locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light',
        reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: false,
      });
      const prefix = `/sandbox/projects/${encodeURIComponent(name)}/`;
      let failure = '', blockedRequests = 0, blockedWebSockets = 0, timer;
      const fail = reason => { failure ||= reason; };
      try {
        // Default deny, installed before any project code runs. Fresh contexts
        // have no cookies, stored seats, permissions, or production credentials.
        await context.route('**/*', route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin === preview.origin && url.pathname.startsWith(prefix) && request.method() === 'GET') {
            if (url.pathname.endsWith('/api-config.json')) {
              return route.fulfill({ json: { apiUrl: '' } });
            }
            return route.continue();
          }
          blockedRequests++;
          if (visualResources.has(request.resourceType())) fail(`Blocked ${request.resourceType()} outside the local project`);
          return route.abort('blockedbyclient');
        });
        await context.routeWebSocket('**/*', socket => {
          blockedWebSockets++;
          // Do not call connectToServer: no handshake reaches any backend.
          socket.close({ code: 1000, reason: 'Offline screenshot preview' });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        page.on('pageerror', () => fail('JavaScript error during preview'));
        page.on('response', response => {
          if (response.status() >= 400 && visualResources.has(response.request().resourceType())) {
            fail(`Required ${response.request().resourceType()} returned HTTP ${response.status()}`);
          }
        });
        page.on('requestfailed', request => {
          if (visualResources.has(request.resourceType())) fail(`Required ${request.resourceType()} failed to load`);
        });
        await page.clock.setFixedTime(new Date('2026-01-01T12:00:00Z'));
        await page.addInitScript(() => {
          let seed = 1;
          Math.random = () => ((seed = Math.imul(seed, 16807) >>> 0) / 4294967296);
        });
        await Promise.race([
          (async () => {
            const response = await page.goto(preview.origin + prefix, { waitUntil: 'load' });
            if (!response?.ok()) fail('Project entry point did not load');
            // No networkidle: offline/reconnecting applications may never idle.
            await page.waitForTimeout(750);
            await page.evaluate(async () => {
              await document.fonts.ready;
              await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
              if ([...document.images].some(image => !image.naturalWidth)) throw new Error('Incomplete image');
            });
            if (page.url() !== preview.origin + prefix) fail('Project redirected during capture');
            if (failure) throw new Error(failure);
            await page.screenshot({ path: resolve(covers, coverName(name)), type: 'jpeg', quality: 80, animations: 'disabled', caret: 'hide', timeout: 8000 });
            if (failure) throw new Error(failure);
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Capture timed out after 12 seconds')), 12000); }),
        ]);
        report[name] = { status: 'ok', blockedRequests, blockedWebSockets };
        console.error(`Captured ${JSON.stringify(name)}`);
      } catch (error) {
        // Stop any in-flight screenshot before removing its partial output.
        await context.close();
        await rm(resolve(covers, coverName(name)), { force: true });
        // Fixed, bounded reasons keep URLs, tokens, and page content out of logs.
        const reason = failure || (error.name === 'TimeoutError' || error.message.includes('timed out') ? 'Capture timed out' : 'Preview or screenshot failed');
        report[name] = { status: 'unavailable', reason, blockedRequests, blockedWebSockets };
        console.error(`Screenshot unavailable for ${JSON.stringify(name)}: ${reason}`);
      } finally {
        clearTimeout(timer);
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await preview.close();
  }
  await writeFile(resolve(output, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  await captureSite(resolve(process.argv[2]), JSON.parse(input));
}
