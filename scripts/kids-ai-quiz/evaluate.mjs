import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createSession, nearWindow, puzzles } from '../../projects/kids-ai-quiz/quiz.mjs';

const root = resolve(import.meta.dirname, '../..');
const baseline = '1d8075bbea02d3acf4191f2c33684a743cd5f295';
const project = 'projects/kids-ai-quiz';
const visits = 24;
const roundsPerVisit = 12;

export function seeded(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

export function memoryStorage() {
  let value = null;
  return { getItem: () => value, setItem: (_, next) => { value = next; } };
}

async function unpackBaseline(directory) {
  const git = (...args) => execFileSync('git', args, { cwd: root });
  const files = git('ls-tree', '--name-only', baseline + ':' + project).toString().trim().split('\n');
  await mkdir(join(directory, project), { recursive: true });
  await Promise.all(files.map(file =>
    writeFile(join(directory, project, file), git('show', baseline + ':' + project + '/' + file))));
}

function sample(startVisit) {
  const seen = new Set(), first = new Set(), recent = [];
  const topics = {}, examples = {};
  let firstRepeats = 0, recentExactRepeats = 0, recentGroupRepeats = 0, recentEitherRepeats = 0;
  for (let visit = 0; visit < visits; visit++) {
    const next = startVisit(seeded(68 + visit), visit);
    for (let round = 0; round < roundsPerVisit; round++) {
      const item = next();
      if (!round) {
        firstRepeats += Number(first.has(item.key));
        first.add(item.key);
      }
      const exact = recent.some(previous => previous.key === item.key);
      const group = recent.some(previous => previous.group === item.group);
      recentExactRepeats += Number(exact);
      recentGroupRepeats += Number(group);
      recentEitherRepeats += Number(exact || group);
      recent.push(item);
      if (recent.length > nearWindow) recent.shift();
      const info = topics[item.topic] ??= { rounds: 0, distinct: 0 };
      info.rounds++;
      info.distinct += Number(!seen.has(item.key));
      seen.add(item.key);
      const family = item.family ?? item.key.split(':')[0];
      examples[family] ??= {
        question: item.question,
        clue: item.clue.spoken,
        answer: item.choices[item.correct].label,
      };
    }
  }
  return {
    rounds: visits * roundsPerVisit, distinct: seen.size, revisits: visits * roundsPerVisit - seen.size,
    distinctOpeners: first.size, repeatedOpeners: firstRepeats,
    recentExactRepeats, recentGroupRepeats, recentEitherRepeats, topics, examples,
  };
}

async function compareContent(directory) {
  const url = file => pathToFileURL(join(directory, project, file));
  const old = await import(url('quiz.mjs'));
  const { attempts, generateTokens, instantiateModel, modelURL } = await import(url('model.mjs'));
  const { sample: sampleToken, memoryBytes } = await instantiateModel(await readFile(modelURL));
  const before = sample((random, visit) => {
    const modelRandom = seeded(64000 + visit);
    const session = old.createSession(random);
    let first = true;
    return () => {
      let item;
      if (first) {
        item = old.firstQuestion;
        first = false;
      } else {
        const fact = session.next();
        const proposals = Array.from({ length: attempts }, () => generateTokens(sampleToken, fact.topic, modelRandom));
        item = proposals.map(tokens => old.validate(fact, tokens)).find(Boolean) ?? old.fallback(fact, random);
      }
      // One question family per topic in the old quiz.
      return { ...item, group: item.topic, family: item.topic };
    };
  });
  const storage = memoryStorage();
  const after = sample(random => createSession({ random, storage }).next);
  const fallbackStorage = memoryStorage();
  const fallback = sample(random => createSession({ random, storage: fallbackStorage, solve: () => null }).next);
  console.log(JSON.stringify({
    baseline, visits, roundsPerVisit, nearWindow, possibleBefore: 49, possibleAfter: puzzles.length,
    before, after, fallback,
    persistedIdBytes: Buffer.byteLength(storage.getItem()),
    baselineWasmLinearBytes: memoryBytes,
  }, null, 2));
}

const startupFiles = ['index.html', 'style.css', 'game.mjs', 'quiz.mjs', 'content.mjs'];
async function transfer(directory, first, later) {
  async function bytes(files) {
    const buffers = await Promise.all(files.map(file => readFile(join(directory, project, file))));
    return {
      raw: buffers.reduce((sum, data) => sum + data.length, 0),
      gzip: buffers.reduce((sum, data) => sum + gzipSync(data).length, 0),
    };
  }
  return { startup: await bytes(first), later: await bytes(later) };
}

function summary(values) {
  const ordered = values.toSorted((a, b) => a - b);
  const percentile = p => Number(ordered[Math.ceil(p * ordered.length) - 1].toFixed(3));
  return { median: percentile(0.5), p95: percentile(0.95) };
}

async function compareBrowser(directory) {
  const { chromium } = await import('../../workers/persistent-counter/node_modules/playwright/index.mjs');
  const { previewServer } = await import('../capture_screenshots.mjs');
  const servers = [];
  const contextsPerVersion = 32;
  const browser = await chromium.launch();
  try {
    for (const source of [directory, root]) servers.push(await previewServer(source));
    const measurements = servers.map(() => ({ startup: [], firstAdvance: [], warm: [], mainHeap: [] }));
    for (let visit = 0; visit < contextsPerVersion; visit++) {
      // Reverse the order every other run to spread out browser warm-up effects.
      for (const index of visit % 2 ? [1, 0] : [0, 1]) {
        const context = await browser.newContext({ viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true });
        try {
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
          await page.addInitScript(initialSeed => {
            let seed = initialSeed;
            Math.random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
            const results = window.quizTimes = [];
            let clickedAt;
            document.addEventListener('click', event => {
              if (event.target.id === 'next') clickedAt = performance.now();
            }, true);
            new MutationObserver(() => {
              if (document.querySelectorAll('#answers button:enabled').length !== 3) return;
              if (!results.length) results.push(performance.now());
              else if (clickedAt !== undefined) {
                results.push(performance.now() - clickedAt);
                clickedAt = undefined;
              }
            }).observe(document, { childList: true, subtree: true });
          }, 68 + visit);
          await page.goto(servers[index].origin + '/sandbox/' + project + '/');
          await page.waitForFunction(() => window.quizTimes.length === 1);
          for (let advance = 0; advance < 7; advance++) {
            await page.locator('#next').tap();
            await page.waitForFunction(count => window.quizTimes.length === count, advance + 2);
          }
          const [startup, firstAdvance, ...warm] = await page.evaluate(() => window.quizTimes);
          const data = measurements[index];
          data.startup.push(startup);
          data.firstAdvance.push(firstAdvance);
          data.warm.push(...warm);
          await cdp.send('HeapProfiler.collectGarbage');
          const usage = await cdp.send('Runtime.getHeapUsage');
          data.mainHeap.push(usage.usedSize);
        } finally {
          await context.close();
        }
      }
    }
    console.log(JSON.stringify({
      browser: browser.version(), host: cpus()[0].model, node: process.version, freshContextsPerVersion: contextsPerVersion,
      before: {
        transfer: await transfer(directory, [...startupFiles, 'model.mjs'], ['model-worker.mjs', 'quiz-model-v2.wasm']),
        wasmLinearBytes: 65536,
        ...Object.fromEntries(Object.entries(measurements[0]).map(([name, values]) => [name, summary(values)])),
      },
      after: {
        transfer: await transfer(root, startupFiles, []),
        wasmLinearBytes: 0,
        ...Object.fromEntries(Object.entries(measurements[1]).map(([name, values]) => [name, summary(values)])),
      },
    }, null, 2));
  } finally {
    await browser.close();
    await Promise.all(servers.map(server => server.close()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = await mkdtemp(join(tmpdir(), 'kids-quiz-baseline-'));
  try {
    await unpackBaseline(directory);
    await compareContent(directory);
    if (process.argv.includes('--browser')) await compareBrowser(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
