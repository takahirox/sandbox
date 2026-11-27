import { generateRound } from './generate.mjs';
import { loadModel, modelByteLimit, modelURL } from './model.mjs';

let loading;
async function load() {
  const response = await fetch(modelURL, { mode: 'same-origin', credentials: 'omit', redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Quiz weights unavailable');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(modelByteLimit);
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length) throw new Error('Quiz weights exceeded size limit');
      bytes.set(value, offset);
      offset += value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return loadModel(bytes.buffer.slice(0, offset));
}

self.onmessage = async ({ data: { seed, recent } }) => {
  try {
    loading ??= load().then(model => {
      self.postMessage({ ready: true });
      return model;
    });
    const model = await loading;
    const started = performance.now();
    const result = generateRound(model, recent, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    });
    self.postMessage({ ...result, ms: performance.now() - started, numericBytes: model.numericBytes });
  } catch {
    self.postMessage({ failed: true });
  }
};
