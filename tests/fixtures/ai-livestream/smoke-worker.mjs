// Test-only Worker. Never copied into the public project.
import {
  RUNTIME, CHAT_RUNTIME,
  isAssetRequest,
} from '../../../projects/ai-livestream/config.mjs';
import { localPipeline } from '../../../projects/ai-livestream/text-model.mjs';
import { createInference } from '../../../projects/ai-livestream/inference.mjs';
const fetchAsset = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options) => {
  const request = new Request(input, options);
  if (!isAssetRequest(new URL(request.url), request.method))
    throw new Error('Unexpected non-asset request');
  return fetchAsset(request);
};
let infer, transcript;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const [{ pipeline, env }, { CreateMLCEngine }] = await Promise.all([import(RUNTIME), import(CHAT_RUNTIME)]);
      const productionPipeline = localPipeline(pipeline, CreateMLCEngine, { seed: 42 });
      const observePipeline = async (...args) => {
        const model = await productionPipeline(...args);
        if (args[0] !== 'automatic-speech-recognition') {
          return model;
        }
        return async (...inputs) => {
          const output = await model(...inputs);
          transcript = output.text;
          return output;
        };
      };
      infer = await createInference(observePipeline, env, (stage, event) => {
        if (event.status === 'initiate')
          self.postMessage({ type: 'progress', file: event.file, stage });
      });
      self.postMessage({ type: 'ready' });
    } else {
      const output = await infer(data.audio, data.language, data.now);
      self.postMessage({ type: 'result', transcript, ...output });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error) });
  }
};
