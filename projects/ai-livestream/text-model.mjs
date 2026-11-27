import {
  LLM, MODEL_LIBRARY, SMALL_LLM, SMALL_MODEL_LIBRARY, TUNED_MODEL_ID, TUNED_MODEL_URL,
} from './config.mjs';

const hubModel = ({ id, revision }) => `https://huggingface.co/${id}/resolve/${revision}/`;

async function cacheTunedMetadata() {
  // WebLLM expects these two files beside the tensor manifest. Alias the pinned
  // originals in its Cache API namespaces so the static overlay stays small.
  await Promise.all([
    ['webllm/config', 'mlc-chat-config.json'],
    ['webllm/model', 'tokenizer.json'],
  ].map(async ([namespace, name]) => {
    const cache = await caches.open(namespace);
    const target = new URL(name, TUNED_MODEL_URL);
    if (await cache.match(target.href)) return;
    const response = await fetch(new URL(name, hubModel(SMALL_LLM)));
    if (!response.ok) throw new Error('Chat metadata unavailable');
    await cache.put(target.href, response);
  }));
}

// Composes two local engines behind the inference pipeline's small interface.
// Both run in the same dedicated Worker; neither method is a remote API call.
export function localPipeline(asrPipeline, CreateMLCEngine, {
  seed, model: selected = LLM, library = MODEL_LIBRARY, tuned = false,
} = {}) {
  return async (task, model, options) => {
    if (task !== 'text-generation') return asrPipeline(task, model, options);
    if (tuned) await cacheTunedMetadata();
    const id = tuned ? TUNED_MODEL_ID : selected.id.split('/').at(-1);
    const engine = await CreateMLCEngine(id, {
      appConfig: { model_list: [{
        model_id: id,
        model: tuned ? TUNED_MODEL_URL : hubModel(selected),
        model_lib: tuned ? SMALL_MODEL_LIBRARY : library,
        overrides: {
          context_window_size: 1536, prefill_chunk_size: 256,
          repetition_penalty: 1.15,
        },
      }] },
      logLevel: 'SILENT',
      initProgressCallback: event => options.progress_callback?.({
        status: 'progress', progress: event.progress * 100,
      }),
    });
    const generate = async (messages, generation) => {
      // Only the bounded context supplied by inference survives between comments.
      await engine.resetChat();
      const result = await engine.chat.completions.create({
        messages, max_tokens: generation.max_new_tokens,
        temperature: generation.temperature, top_p: generation.top_p,
        frequency_penalty: 0.25, presence_penalty: 0.15,
        extra_body: { enable_thinking: false },
        ...(seed === undefined ? {} : { seed }),
      });
      return [{ generated_text: result.choices[0]?.message.content || '' }];
    };
    // WebLLM applies the model's own chat template, including disabled thinking.
    generate.tokenizer = { apply_chat_template: messages => messages };
    return generate;
  };
}
