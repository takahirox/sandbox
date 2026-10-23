// Opt-in evaluation only. Inputs and outputs are synthetic fixtures, never user speech.
import {mlcGenerator, MLC_RUNTIME, MLC_COMMIT, MLC_MODELS} from './mlc-generator.mjs';
import { RUNTIME, WASM, isAssetRequest } from './baseline/config.mjs';
const small25 = { id: 'onnx-community/Qwen2.5-0.5B-Instruct', revision: '22942cb7d7ba4cc81bb4673549ca4d4614469b5e' };
const candidate = { id: 'onnx-community/Qwen3-1.7B-ONNX', revision: '3231b522c6e703b2f9b3cd8ea27426a1289a02f2' };
const modernRuntime = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';
const modernWasm = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/';
const assetFetch = fetch.bind(globalThis);
globalThis.fetch = (input, options) => {
  const request = new Request(input, options), url = new URL(request.url);
  const mlcAsset = ['GET', 'HEAD'].includes(request.method) && (url.href === MLC_RUNTIME ||
    (url.origin === 'https://raw.githubusercontent.com' && url.pathname.startsWith(`/mlc-ai/binary-mlc-llm-libs/${MLC_COMMIT}/web-llm-models/v0_2_84/base/`)) ||
    (url.origin === 'https://huggingface.co' && MLC_MODELS.some(model => url.pathname.startsWith(`/mlc-ai/${model.id}/resolve/${model.revision}/`)) && !url.search));
  if (!mlcAsset && !isAssetRequest(url, request.method === 'HEAD' ? 'GET' : request.method) && !(['GET', 'HEAD'].includes(request.method) && url.origin === 'https://cdn.jsdelivr.net' && (url.href === modernRuntime || url.href.startsWith(modernWasm))) && !(['GET', 'HEAD'].includes(request.method) && url.origin === 'https://huggingface.co' && [small25, candidate, { id:'onnx-community/Qwen2.5-1.5B-Instruct', revision:'d54957e3af1be04546436e874a60fe386041b244' }].some(model => url.pathname.startsWith(`/${model.id}/resolve/${model.revision}/`)) && !url.search)) throw Error(`Non-asset request: ${request.method} ${url.origin}${url.pathname.slice(0,160)}`);
  return assetFetch(request);
};
let infer, transcript, raw, timings, files = {}, loadingAt = 0;
self.onmessage = async ({data}) => {
  try {
    if (data.type === 'init') {
      let seed = 42;
      Math.random = () => ((seed = Math.imul(seed, 16807) >>> 0) / 4294967296);
      const {pipeline, env} = await import(data.modern ? modernRuntime : RUNTIME);
      const {createInference} = await import(data.baseline ? './baseline/inference.mjs' : '../../../projects/ai-livestream/inference.mjs');
      files = {};
      loadingAt = performance.now();
      const measuredPipeline = async (task, id, options) => {
        env.backends.onnx.wasm.wasmPaths = data.modern ? modernWasm : WASM;
        if (task === 'text-generation') {
          if (data.q8) options.dtype = 'q8';
          if (data.q4) options.dtype = 'q4';
          if (data.cpu) options.device = 'wasm';
          const chosen = data.qwen05 ? small25 : data.qwen25 ? { id: 'onnx-community/Qwen2.5-1.5B-Instruct', revision: 'd54957e3af1be04546436e874a60fe386041b244' } : data.stronger ? candidate : { id: 'onnx-community/Qwen3-0.6B-ONNX', revision: '58ca03a5e7b354b480b1a82b34bde8dc7b854cc0' };
          id = chosen.id; options.revision = chosen.revision;
        }
        if (data.modern && task === 'automatic-speech-recognition') options.session_options = { graphOptimizationLevel: 'basic' };
        if (data.modern) env.remotePathTemplate = `{model}/resolve/${options.revision}/`;
        const model = data.mlc && task === 'text-generation' ? await mlcGenerator(data.mlcSmall) : await pipeline(task, id, {...options, progress_callback: event => {
          if (event.total) files[`${task}/${event.file}`] = event.total;
        }});
        if (data.mlc && task === 'text-generation') {
          // Exact byte sizes from the pinned shard manifest / asset metadata.
          files['text-generation/shards'] = data.mlcSmall ? 335372288 : 968001536;
          files['text-generation/tokenizer.json'] = 11422654;
          files['text-generation/model-library.wasm'] = data.mlcSmall ? 5535989 : 5566554;
          files['text-generation/config+manifest'] = 2075 + (data.mlcSmall ? 129391 : 134335);
        }
        const wrapped = async (...args) => {
          const start = performance.now();
          const output = await model(...args);
          timings[task] = performance.now() - start;
          if (task === 'automatic-speech-recognition') transcript = output.text;
          else raw = output[0]?.generated_text;
          return output;
        };
        wrapped.tokenizer = model.tokenizer;
        return wrapped;
      };
      const start = performance.now();
      infer = await createInference(measuredPipeline, env, () => {}, {random: () => 0});
      self.postMessage({type:'ready', loadMs: performance.now()-start, assetBytes: Object.values(files).reduce((a,b)=>a+b,0), files});
    } else {
      transcript = ''; raw = ''; timings = {};
      const start = performance.now();
      const output = await infer(data.audio, data.language, data.now);
      self.postMessage({type:'result', ...output, transcript, raw, timings, totalMs:performance.now()-start});
    }
  } catch (error) { self.postMessage({type:'error', message:String(error), loadMs:performance.now()-loadingAt, files, assetBytes:Object.values(files).reduce((a,b)=>a+b,0)}); }
};
