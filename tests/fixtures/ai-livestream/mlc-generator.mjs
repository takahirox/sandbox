export const MLC_RUNTIME = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/lib/index.js';
export const MLC_COMMIT = '00fe7a40e57e5e8eb9fef87526a4bf28ad5846c0';
export const MLC_MODELS = [
  { id:'Qwen3-0.6B-q4f16_1-MLC', revision:'8c14ce481d4c692769976ad52afea453a102df19' },
  { id:'Qwen3-1.7B-q4f16_1-MLC', revision:'80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc' },
];
export async function mlcGenerator(small = false) {
  const [{ CreateMLCEngine }, { localPipeline }] = await Promise.all([
    import(MLC_RUNTIME), import('../../../projects/ai-livestream/text-model.mjs'),
  ]);
  const model = MLC_MODELS[small ? 0 : 1];
  return localPipeline(() => { throw Error('ASR is measured separately'); }, CreateMLCEngine, {
    seed: 42, model: {id:`mlc-ai/${model.id}`,revision:model.revision},
    library:`https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/${MLC_COMMIT}/web-llm-models/v0_2_84/base/${model.id.replace('-MLC','')}_cs1k-webgpu.wasm`,
  })('text-generation', model.id, {});
}
