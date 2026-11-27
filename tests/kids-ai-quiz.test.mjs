import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { facts, starter, topics } from '../projects/kids-ai-quiz/content.mjs';
import { attempts, createGenerator, generateTokens, loadModel, maxModelBytes, modelURL } from '../projects/kids-ai-quiz/model.mjs';
import { createSession, fallback, firstQuestion, hasStructure, validate } from '../projects/kids-ai-quiz/quiz.mjs';
import { seeded } from '../scripts/kids-ai-quiz/dataset.mjs';

test('accepts only approved wording, one distinct correct choice, and two related decoys', () => {
  assert.equal(firstQuestion.choices[firstQuestion.correct], starter);
  for (const tokens of [
    null, {}, [], [0, 0, 1], [0, 0, 1, 0, 1], ['なまえを おしえて', 0, 1, 0],
    [0, 0, 1, 3], [0, 0, -1, 0], [0, 0, 1.1, 0], [0, 0, NaN, 0],
    [3, 0, 1, 0], // Longer wording with kanji.
    [0, 7, 1, 0], // The answer appears twice.
    [0, 0, 0, 1], // Repeated distractors.
    [0, 0, 5, 0], // An unrelated choice from another topic.
  ]) assert.equal(validate(starter, tokens), null, JSON.stringify(tokens));

  for (const fact of facts) {
    for (let form = 0; form < 3; form++) {
      const item = validate(fact, [form, 1, 3, form]);
      assert.ok(item);
      assert.equal(item.choices[item.correct], fact);
      assert.equal(item.choices.filter(choice => choice === fact).length, 1);
      assert.equal(new Set(item.choices.map(choice => choice.label)).size, 3);
      assert.match(item.question, /^[ぁ-ゖー0-9 「」、。！？]+$/u);
      assert.ok([...item.question].length <= 45);
      if (item.topic === 'counting') assert.equal(Number(item.choices[item.correct].label), item.clue.count);
      if (item.topic === 'colors' || item.topic === 'shapes') {
        assert.equal(item.choices.filter(choice => choice.icon === item.clue.icon).length, 1);
        assert.equal(item.choices[item.correct].icon, item.clue.icon);
      }
    }
  }
});

test('vetted fallback yields varied choice sets and session rotation spaces topics and repeated facts', () => {
  for (const seed of [0, 1, 64, 65536]) {
    const random = seeded(seed);
    const session = createSession(random);
    const history = [starter];
    for (let i = 1; i < facts.length * 10; i++) {
      const fact = session.next();
      assert.notEqual(history.at(-1).topic, fact.topic);
      assert.ok(!history.slice(-12).includes(fact));
      history.push(fact);
      const item = fallback(fact, random);
      assert.equal(item.choices[item.correct], fact);
    }
    for (let i = 0; i < history.length; i += facts.length) {
      assert.equal(new Set(history.slice(i, i + facts.length)).size, facts.length);
    }
    const variants = Array.from({ length: 64 }, () => {
      const item = fallback(starter, random);
      return [item.question, ...item.choices.map(choice => choice.id)].join('/');
    });
    assert.ok(new Set(variants).size > 30);
  }
});

test('loads the real one-page WASM model and rejects failed, corrupt, oversized and unsupported versions', async () => {
  const bytes = await readFile(modelURL);
  await assert.rejects(loadModel(new Response(null, { status: 404 })), /unavailable/);
  await assert.rejects(loadModel(new Response(new Uint8Array(maxModelBytes + 1))), /too large/);
  await assert.rejects(loadModel(new Response(new Uint8Array([0, 1]))), WebAssembly.CompileError);
  await assert.rejects(loadModel(new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))), /Unsupported model/);
  const model = await loadModel(new Response(bytes));
  assert.equal(model.memoryBytes, 65536);
  const random = seeded(14);
  for (let topic = 0; topic < topics.length; topic++) {
    const samples = Array.from({ length: 40 }, () => generateTokens(model.sample, topic, random));
    assert.ok(samples.every(hasStructure));
    const fact = topics[topic].facts[0];
    assert.ok(samples.filter(tokens => validate(fact, tokens)).length >= 30);
    assert.ok(new Set(samples.map(tokens => tokens.join(','))).size > 20);
  }
});

test('worker client handles unsupported, loading failure, busy, stop, retry, stale replies and timeout', async () => {
  const workers = [];
  const client = createGenerator({ supported: true, timeout: 40, spawn() {
    const worker = {
      postMessage(request) { this.request = request; },
      reply(candidates, id = this.request.id) { this.onmessage({ data: { id, candidates } }); },
      terminate() { this.terminated = true; },
    };
    workers.push(worker);
    return worker;
  } });
  assert.deepEqual(await createGenerator({ supported: false }).generate(0), { kind: 'unsupported' });
  assert.deepEqual(await createGenerator({ supported: true, spawn() { throw new Error(); } }).generate(0), { kind: 'error' });

  const failed = client.generate(0);
  assert.deepEqual(await client.generate(0), { kind: 'busy' });
  workers[0].reply(undefined);
  assert.deepEqual(await failed, { kind: 'error' });
  assert.ok(workers[0].terminated);

  const stopped = client.generate(2);
  client.stop();
  assert.deepEqual(await stopped, { kind: 'stopped' });
  const recovered = client.generate(3);
  const candidates = Array.from({ length: attempts }, () => [0, 1, 2, 0]);
  workers[1].reply(candidates);
  workers[1].onerror();
  workers[2].reply(candidates, workers[2].request.id - 1);
  workers[2].reply(candidates);
  assert.deepEqual(await recovered, { kind: 'ok', candidates });
  assert.equal(workers.length, 3);

  assert.deepEqual(await client.generate(4), { kind: 'timeout' });
  assert.equal(workers.length, 3, 'The loaded worker is reused');
  assert.ok(workers[2].terminated);
  const retried = client.generate(5);
  workers[3].reply(candidates);
  assert.deepEqual(await retried, { kind: 'ok', candidates });
  client.stop();
});
