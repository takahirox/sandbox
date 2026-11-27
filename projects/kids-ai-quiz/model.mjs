import { limits } from './quiz.mjs';

export const attempts = 3;
export const deadline = 1500;
export const modelURL = new URL('./quiz-model-v1.wasm', import.meta.url);
export const maxModelBytes = 4096;

export async function loadModel(response) {
  if (!response.ok || !response.body) throw new Error('Model unavailable');
  const reader = response.body.getReader();
  const buffer = new Uint8Array(maxModelBytes);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > buffer.length) throw new Error('Model too large');
      buffer.set(value, size);
      size += value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return instantiateModel(buffer.subarray(0, size));
}

export async function instantiateModel(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, { math: { exp: Math.exp } });
  const { sample, memory, version } = instance.exports;
  if (version?.() !== 1 || typeof sample !== 'function' || memory?.buffer.byteLength !== 65536) {
    throw new Error('Unsupported model');
  }
  return { sample, memoryBytes: memory.buffer.byteLength };
}

export function generateTokens(sample, topic, random = Math.random) {
  return limits.reduce((tokens, size, stage) => {
    tokens.push(sample(stage, topic, tokens[1] ?? 0, size, random()));
    return tokens;
  }, []);
}

export function createGenerator({
  spawn = () => new Worker(new URL('./model-worker.mjs', import.meta.url), { type: 'module' }),
  supported = typeof Worker === 'function' && typeof WebAssembly === 'object',
  timeout = deadline,
} = {}) {
  let worker;
  let pending;
  let sequence = 0;

  function stop(kind = 'stopped') {
    worker?.terminate();
    worker = null;
    pending?.finish({ kind });
  }

  return {
    stop,
    generate(topic) {
      if (!supported) return Promise.resolve({ kind: 'unsupported' });
      if (pending) return Promise.resolve({ kind: 'busy' });
      return new Promise(resolve => {
        const id = ++sequence;
        const expires = performance.now() + timeout;
        const timer = setTimeout(() => stop('timeout'), timeout);
        pending = {
          finish(result) {
            clearTimeout(timer);
            pending = null;
            resolve(result);
          },
        };

        try {
          const activeWorker = worker ??= spawn();
          activeWorker.onmessage = ({ data }) => {
            if (worker !== activeWorker || data?.id !== id || !pending) return;
            if (performance.now() >= expires) {
              stop('timeout');
              return;
            }
            if (!Array.isArray(data.candidates) || data.candidates.length !== attempts) {
              stop('error');
              return;
            }
            pending.finish({ kind: 'ok', candidates: data.candidates });
          };
          activeWorker.onerror = activeWorker.onmessageerror = () => {
            if (worker === activeWorker && pending) stop('error');
          };
          activeWorker.postMessage({ id, topic });
        } catch {
          stop('error');
        }
      });
    },
  };
}
