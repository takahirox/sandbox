import {
  ASR,
  LLM,
  WASM,
  messagesFor,
  meaningfulSpeech,
  cleanComment,
  sharesTopic,
  MIN_COMMENT_INTERVAL,
} from './config.mjs';

// Shared by the actual Worker and the opt-in real-model smoke test.
export async function createInference(pipeline, env, progress) {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.numThreads = 1; // GitHub Pages has no cross-origin isolation.
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.wasmPaths = WASM;
  const asr = await pipeline('automatic-speech-recognition', ASR.id, {
    revision: ASR.revision,
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (event) => progress('Listening', event),
  });
  const generator = await pipeline('text-generation', LLM.id, {
    revision: LLM.revision,
    device: 'webgpu',
    dtype: 'q4f16',
    progress_callback: (event) => progress('Chat', event),
  });
  let lastComment = -Infinity;
  let lastSpeech = '';
  const recent = [];
  return async (audio, language, now = performance.now()) => {
    if (
      !(audio instanceof Float32Array) ||
      audio.length > 96000 ||
      audio.length < 1600
    )
      return { comment: '' };
    let energy = 0;
    for (const sample of audio) energy += sample * sample;
    if (Math.sqrt(energy / audio.length) < 0.006) return { comment: '' };
    const output = await asr(audio, {
      language: language === 'ja' ? 'japanese' : 'english',
      task: 'transcribe',
      max_new_tokens: 96,
    });
    const text = output.text?.trim() || '';
    if (!meaningfulSpeech(text) || text === lastSpeech) return { comment: '' };
    lastSpeech = text;
    if (now - lastComment < MIN_COMMENT_INTERVAL) return { comment: '' };
    const prompt = generator.tokenizer.apply_chat_template(
      messagesFor(text, language),
      {
        tokenize: false,
        add_generation_prompt: true,
        enable_thinking: false,
      },
    );
    const results = await generator(prompt, {
      max_new_tokens: 64,
      do_sample: false,
      repetition_penalty: 1.15,
      return_full_text: false,
    });
    const generated = results[0]?.generated_text;
    const raw = Array.isArray(generated)
      ? generated.at(-1)?.content
      : generated;
    const cleaned = cleanComment(raw || '', recent, language);
    const comment = sharesTopic(cleaned, text, language) ? cleaned : '';
    // Throttle attempts too, even when the safety filter suppresses the output.
    lastComment = now;
    if (comment) {
      recent.push(comment);
      if (recent.length > 20) recent.shift();
    }
    return { comment };
  };
}
