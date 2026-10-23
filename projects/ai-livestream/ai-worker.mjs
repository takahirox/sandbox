import { RUNTIME, CHAT_RUNTIME, isAssetRequest } from './config.mjs';
import { localPipeline } from './text-model.mjs';
import { createInference } from './inference.mjs';

// This realm only fetches public runtime/model assets. Never put user content in a URL.
const fetchAsset = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options) => {
  const request = new Request(input, options);
  const url = new URL(request.url);
  if (!isAssetRequest(url, request.method))
    return Promise.reject(new Error('Only static model assets may be fetched'));
  return fetchAsset(request);
};
let infer;
let busy = false;
let superseded = false;
let debug = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'superseded') { superseded = true; return; }
  if (busy) return;
  busy = true;
  try {
    if (data.type === 'init' && !infer) {
      debug = data.debug === true;
      const [{ pipeline, env }, { CreateMLCEngine }] = await Promise.all([
        import(RUNTIME), import(CHAT_RUNTIME),
      ]);
      infer = await createInference(localPipeline(pipeline, CreateMLCEngine), env, (stage, event) => {
        if (['initiate', 'progress', 'done'].includes(event.status))
          self.postMessage({
            type: 'progress',
            stage,
            progress: event.progress,
          });
      }, { onEngagement: interest => self.postMessage({ type: 'engagement', interest }),
        isSuperseded: () => superseded,
        onDiagnostic: (event, value) => {
          if (debug) self.postMessage({ type: 'diagnostic', event, value });
        },
      });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'audio' && infer) {
      superseded = false;
      const result = await infer(data.audio, data.language);
      self.postMessage({ type: 'result', ...result });
    }
  } catch (error) {
    // Do not expose transcript-bearing runtime exceptions to the UI or console.
    self.postMessage({ type: 'error', code: infer ? 'inference' : 'load' });
  } finally {
    busy = false;
  }
};
