import { topics } from './content.mjs';
import { attempts, generateTokens, loadModel, modelURL } from './model.mjs';

let model;
let busy = false;
self.onmessage = async ({ data: { id, topic } }) => {
  if (busy || !Number.isInteger(topic) || topic < 0 || topic >= topics.length) return;
  busy = true;
  try {
    model ??= await loadModel(await fetch(modelURL, { mode: 'same-origin', credentials: 'omit' }));
    const candidates = Array.from({ length: attempts }, () => generateTokens(model.sample, topic));
    self.postMessage({ id, candidates });
  } catch {
    self.postMessage({ id });
  } finally {
    busy = false;
  }
};
