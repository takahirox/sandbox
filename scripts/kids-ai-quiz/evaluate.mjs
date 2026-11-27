import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { dataset, heldOut, seeded, memoryStorage } from './dataset.mjs';
import { createSession } from '../../projects/kids-ai-quiz/quiz.mjs';
import { generateRound, nearWindow } from '../../projects/kids-ai-quiz/generate.mjs';
import { loadModel, modelURL } from '../../projects/kids-ai-quiz/model.mjs';
import { verifyRound } from '../../projects/kids-ai-quiz/verify.mjs';

const root = resolve(import.meta.dirname, '../..');
const baseline = '1d8075bbea02d3acf4191f2c33684a743cd5f295';
const project = 'projects/kids-ai-quiz';
const visits = 24;
const roundsPerVisit = 12;

async function unpackBaseline(directory) {
  const git = (...args) => execFileSync('git', args, { cwd: root });
  const files = git('ls-tree', '--name-only', baseline + ':' + project).toString().trim().split('\n');
  await mkdir(join(directory, project), { recursive: true });
  await Promise.all(files.map(file =>
    writeFile(join(directory, project, file), git('show', baseline + ':' + project + '/' + file))));
}

function target(item) {
  // Count largest/smallest of the same three groups as one stimulus.
  return item.key.replace(/^compare:[01]:/, 'compare:');
}

function description(item) {
  return {
    key: item.key, question: item.question, picture: item.clue.spoken ?? item.clue.icon,
    choices: item.choices.map(choice => choice.label), answer: item.choices[item.correct].label,
  };
}

function sample(startVisit) {
  const seen = new Set(), first = new Set(), recent = [];
  const topics = {}, examples = {}, unseen = {}, newPositionScenes = new Set();
  const teacherScenes = new Set([...dataset()].filter(row => row[0] === 'positions').map(row => row[1]));
  let recentExact = 0, recentRelated = 0, fallback = 0;
  for (let visit = 0; visit < visits; visit++) {
    const next = startVisit(seeded(68 + visit), visit);
    for (let round = 0; round < roundsPerVisit; round++) {
      const item = next();
      const key = target(item);
      if (!round) first.add(key);
      const exact = recent.some(previous => target(previous) === key);
      recentExact += Number(exact);
      recentRelated += Number(exact || recent.some(previous => previous.group === item.group));
      recent.push(item);
      if (recent.length > nearWindow) recent.shift();
      fallback += Number(item.source === 'fallback');
      const info = topics[item.topic] ??= { rounds: 0, distinct: 0 };
      info.rounds++;
      info.distinct += Number(!seen.has(key));
      if (!seen.has(key)) {
        const audit = examples[item.topic] ??= [];
        if (audit.length < 2) audit.push(description(item));
      }
      if (item.source === 'model' && heldOut(item.key)) unseen[key] ??= description(item);
      if (item.source === 'model' && item.topic === 'positions') {
        const scene = item.clue.spoken.replace('ひだりから、', '').replaceAll('、', ' ');
        if (!teacherScenes.has(scene)) newPositionScenes.add(scene);
      }
      seen.add(key);
    }
  }
  return {
    distinct: seen.size, revisits: visits * roundsPerVisit - seen.size, distinctOpeners: first.size,
    recentExact, recentRelated, fallback, topics, unseen, novelPositionScenes: newPositionScenes.size, examples,
  };
}

async function compareContent(directory) {
  const url = file => pathToFileURL(join(directory, project, file));
  const old = await import(url('quiz.mjs'));
  const oldModel = await import(url('model.mjs'));
  const { sample: sampleToken, memoryBytes } = await oldModel.instantiateModel(await readFile(oldModel.modelURL));
  const before = sample((random, visit) => {
    const modelRandom = seeded(64000 + visit);
    const session = old.createSession(random);
    let first = true;
    return () => {
      if (first) {
        first = false;
        return { ...old.firstQuestion, group: old.firstQuestion.topic };
      }
      const fact = session.next();
      const proposals = Array.from({ length: oldModel.attempts }, () =>
        oldModel.generateTokens(sampleToken, fact.topic, modelRandom));
      const item = proposals.map(tokens => old.validate(fact, tokens)).find(Boolean) ?? old.fallback(fact, random);
      return { ...item, group: item.topic };
    };
  });

  const { buffer } = await readFile(modelURL);
  const model = loadModel(buffer);
  function evaluateModel(reload) {
    const storage = memoryStorage();
    const recent = [];
    let attempted = 0, rejected = 0;
    const results = sample(random => {
      if (!reload) recent.length = 0;
      const fallback = createSession({ random, storage });
      return () => {
        const seed = Math.floor(random() * 2 ** 32);
        const result = generateRound(model, recent, seeded(seed));
        attempted += result.attempts;
        rejected += result.invalid;
        const item = result.item ?? { ...fallback.next(), source: 'fallback' };
        const previous = recent.findIndex(row => row.key === item.key);
        if (previous >= 0) recent.splice(previous, 1);
        recent.push(item);
        if (recent.length > 160) recent.shift();
        return item;
      };
    });
    return { ...results, attempted, rejected };
  }

  const fallbackStorage = memoryStorage();
  const fallback = sample(random => {
    const session = createSession({ random, storage: fallbackStorage });
    return () => ({ ...session.next(), source: 'fallback' });
  });
  const rawRandom = seeded(63), raw = {};
  for (let i = 0; i < 1000; i++) {
    const fields = model.generate(rawRandom);
    const stats = raw[fields[0] || 'malformed'] ??= { total: 0, invalid: 0 };
    stats.total++;
    stats.invalid += Number(!verifyRound(fields, () => 0.5));
  }
  console.log(JSON.stringify({
    baseline, visits, roundsPerVisit, nearWindow, before, reloads: evaluateModel(true),
    fresh: evaluateModel(false), fallback, raw, baselineWasmLinearBytes: memoryBytes,
    newModelNumericBytes: model.numericBytes,
  }, null, 2));
}

const common = ['index.html', 'style.css', 'game.mjs', 'quiz.mjs', 'content.mjs'];
async function transfer(directory, files) {
  const buffers = await Promise.all(files.map(file => readFile(join(directory, project, file))));
  return {
    raw: buffers.reduce((sum, data) => sum + data.length, 0),
    gzip: buffers.reduce((sum, data) => sum + gzipSync(data).length, 0),
  };
}

function summary(values) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = p => Number(sorted[Math.ceil(p * sorted.length) - 1].toFixed(3));
  return { median: percentile(0.5), p95: percentile(0.95) };
}

async function compareBrowser(directory) {
  const { chromium } = await import('../../workers/persistent-counter/node_modules/playwright/index.mjs');
  const { previewServer } = await import('../capture_screenshots.mjs');
  const servers = [];
  const contextsPerVersion = 24;
  const browser = await chromium.launch();
  try {
    for (const source of [directory, root]) servers.push(await previewServer(source));
    const measurements = servers.map(() => ({
      startup: [], firstAdvance: [], warmAdvance: [], firstWorker: [], warmWorker: [],
      workerDecode: [], mainHeap: [], fallbacks: 0,
    }));
    for (let visit = 0; visit < contextsPerVersion; visit++) {
      for (const index of visit % 2 ? [1, 0] : [0, 1]) {
        const context = await browser.newContext({ viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true });
        try {
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
          await page.addInitScript(initialSeed => {
            let seed = initialSeed, clicked;
            Math.random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
            const times = window.quizTimes = [], workers = window.quizWorkers = [];
            const RealWorker = Worker;
            window.Worker = class extends RealWorker {
              constructor(...args) {
                super(...args);
                let started;
                this.addEventListener('message', ({ data }) => workers.push([performance.now() - started, data.ms]));
                this.clock = () => { started = performance.now(); };
              }
              postMessage(...args) { this.clock(); super.postMessage(...args); }
            };
            document.addEventListener('click', event => {
              if (event.target.id === 'next') clicked = performance.now();
            }, true);
            new MutationObserver(() => {
              if (document.querySelectorAll('#answers button:enabled').length !== 3) return;
              if (!times.length || clicked !== undefined) {
                times.push({
                  time: performance.now() - (clicked ?? 0),
                  fallback: document.querySelector('main').dataset.source === 'fallback',
                });
                clicked = undefined;
              }
            }).observe(document, { childList: true, subtree: true });
          }, 68 + visit);
          await page.goto(servers[index].origin + '/sandbox/' + project + '/');
          await page.waitForFunction(() => window.quizTimes.length === 1);
          for (let advance = 0; advance < 7; advance++) {
            await page.locator('#next').tap();
            await page.waitForFunction(count => window.quizTimes.length === count, advance + 2);
          }
          const { times, workers } = await page.evaluate(() => ({ times: window.quizTimes, workers: window.quizWorkers }));
          const data = measurements[index];
          const [startup, firstAdvance, ...warm] = times.map(row => row.time);
          data.startup.push(startup);
          data.firstAdvance.push(firstAdvance);
          data.warmAdvance.push(...warm);
          data.fallbacks += times.filter(row => row.fallback).length;
          if (workers.length) data.firstWorker.push(workers[0][0]);
          data.warmWorker.push(...workers.slice(1).map(row => row[0]));
          data.workerDecode.push(...workers.map(row => row[1]).filter(value => value !== undefined));
          await cdp.send('HeapProfiler.collectGarbage');
          data.mainHeap.push((await cdp.send('Runtime.getHeapUsage')).usedSize);
        } finally {
          await context.close();
        }
      }
    }
    const timing = data => Object.fromEntries(Object.entries(data).map(([name, values]) =>
      [name, Array.isArray(values) ? summary(values) : values]));
    console.log(JSON.stringify({
      browser: browser.version(), host: cpus()[0].model, node: process.version, contextsPerVersion,
      before: {
        startupTransfer: await transfer(directory, [...common, 'model.mjs']),
        laterTransfer: await transfer(directory, ['model-worker.mjs', 'quiz-model-v2.wasm']),
        ...timing(measurements[0]),
      },
      after: {
        startupTransfer: await transfer(root, [
          ...common, 'session.mjs', 'model-worker.mjs', 'model.mjs', 'generate.mjs', 'verify.mjs', 'quiz-gru-v1.bin',
        ]),
        laterTransfer: { raw: 0, gzip: 0 },
        ...timing(measurements[1]),
      },
    }, null, 2));
  } finally {
    await browser.close();
    await Promise.all(servers.map(server => server.close()));
  }
}

const directory = await mkdtemp(join(tmpdir(), 'kids-quiz-baseline-'));
try {
  await unpackBaseline(directory);
  await compareContent(directory);
  if (process.argv.includes('--browser')) await compareBrowser(directory);
} finally {
  await rm(directory, { recursive: true, force: true });
}
