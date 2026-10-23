import { LLM, MODEL_LIBRARY } from './config.mjs';

// Composes two local engines behind the inference pipeline's small interface.
// Both run in the same dedicated Worker; neither method is a remote API call.
export function localPipeline(asrPipeline, CreateMLCEngine, { seed, model: selected = LLM, library = MODEL_LIBRARY } = {}) {
  return async (task, model, options) => {
    if (task !== 'text-generation') return asrPipeline(task, model, options);
    const engine = await CreateMLCEngine(selected.id.split('/').at(-1), {
      appConfig: { model_list: [{
        model_id: selected.id.split('/').at(-1),
        model: `https://huggingface.co/${selected.id}/resolve/${selected.revision}/`,
        model_lib: library,
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
