import {
  CHAT_RUNTIME, LLM, MODEL_LIBRARY, SMALL_CHAT_RUNTIME, SMALL_MODEL_FILES, SMALL_MODEL_LIBRARY,
  TUNED_ADAPTER_URL,
} from './config.mjs';

const hubModel = ({ id, revision }) => `https://huggingface.co/${id}/resolve/${revision}/`;

export function localPipeline(asrPipeline, CreateMLCEngine, {
  seed, model: selected = LLM, library = MODEL_LIBRARY,
} = {}) {
  return async (task, model, options) => {
    if (task !== 'text-generation') return asrPipeline(task, model, options);
    const id = selected.id.split('/').at(-1);
    const engine = await CreateMLCEngine(id, {
      appConfig: { model_list: [{
        model_id: id,
        model: hubModel(selected),
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
    generate.tokenizer = { apply_chat_template: messages => messages };
    return generate;
  };
}

// Both runtimes generate on device. Load only the requested text engine.
export async function selectPipeline(asrPipeline, mode, { seed } = {}) {
  if (mode === 'baseline') {
    const { CreateMLCEngine } = await import(CHAT_RUNTIME);
    return localPipeline(asrPipeline, CreateMLCEngine, { seed });
  }
  const { Wllama } = await import(SMALL_CHAT_RUNTIME);
  return async (task, model, options) => {
    if (task !== 'text-generation') return asrPipeline(task, model, options);
    const engine = new Wllama({ default: SMALL_MODEL_LIBRARY }, {
      suppressNativeLog: true, parallelDownloads: 2,
      logger: { debug() {}, log() {}, info() {}, warn() {}, error() {} },
    });
    let loraAdapters = [];
    if (mode !== 'small') {
      const response = await fetch(TUNED_ADAPTER_URL);
      if (!response.ok) throw Error('Chat adapter unavailable');
      loraAdapters = [{ blob: await response.blob() }];
    }
    await engine.loadModelFromUrl(SMALL_MODEL_FILES[0], {
      n_ctx: 1536, n_batch: 256, n_threads: 1, n_gpu_layers: 99,
      lora_adapters: loraAdapters,
      progressCallback: ({ loaded, total }) => options.progress_callback?.({
        status: 'progress', progress: total ? loaded * 100 / total : 0,
      }),
    });
    const generate = async (messages, generation) => {
      const result = await engine.createChatCompletion({
        messages, max_tokens: generation.max_new_tokens,
        temperature: 0.4, top_p: 0.85, top_k: 20, min_p: 0.01, repeat_penalty: 1.05,
        cache_prompt: false, chat_template_kwargs: { enable_thinking: false },
        ...(seed === undefined ? {} : { seed }),
      });
      const message = result.choices[0]?.message;
      const text = message?.content || '';
      return [{ generated_text: message?.reasoning_content
        ? `<think>${message.reasoning_content}</think>${text}` : text }];
    };
    generate.tokenizer = { apply_chat_template: messages => messages };
    return generate;
  };
}
