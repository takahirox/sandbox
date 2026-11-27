// Opt-in only. Report contents only for explicitly supplied synthetic fixtures.
import { isAssetRequest, RUNTIME } from '../../../projects/ai-livestream/config.mjs';
import { selectPipeline } from '../../../projects/ai-livestream/text-model.mjs';
import { createInference } from '../../../projects/ai-livestream/inference.mjs';

const fetchAsset = fetch.bind(globalThis);
globalThis.fetch = (input, options) => {
  const request = new Request(input, options);
  if (!isAssetRequest(new URL(request.url), request.method))
    throw new Error('Only static model assets may be fetched');
  return fetchAsset(request);
};

let infer, fixtureText, observations;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const started = performance.now();
      const { pipeline, env } = await import(RUNTIME);
      const local = await selectPipeline(pipeline, data.model, { seed: 42 });
      const assets = {};
      infer = await createInference(async (task, id, options) => {
        const model = await local(task, id, {
          ...options,
          progress_callback: event => {
            if (event.total) assets[event.file] = event.total;
          },
        });
        const wrapped = async (...args) => {
          if (task === 'automatic-speech-recognition' && typeof fixtureText === 'string') {
            observations.transcript = fixtureText;
            return { text: fixtureText };
          }
          const result = await model(...args);
          if (task === 'automatic-speech-recognition') observations.transcript = result.text;
          else observations.raw = result[0]?.generated_text;
          return result;
        };
        wrapped.tokenizer = model.tokenizer;
        return wrapped;
      }, env, () => {}, { model: data.model, failOnGenerationError: true, onDiagnostic: (event, value) => {
        if (Number.isFinite(value)) observations[event] = value;
        else (observations.events ??= []).push(event);
      } });
      self.postMessage({ type: 'ready', loadMs: performance.now() - started, assets });
    } else {
      fixtureText = data.transcript;
      observations = {};
      const result = await infer(data.audio, data.language, data.now);
      self.postMessage({ type: 'result', ...result, ...observations });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error) });
  }
};
