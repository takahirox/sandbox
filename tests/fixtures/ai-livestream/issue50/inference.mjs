import {
  ASR, LLM, WASM, messagesFor, meaningfulSpeech, cleanComment,
  sharesTopic, echoesSpeech, MIN_COMMENT_INTERVAL, WINDOW_SAMPLES, VOICES,
} from './config.mjs';
import { speechInterest } from '../../../../projects/ai-livestream/audience.mjs';

// Shared by the actual Worker and the opt-in real-model evaluation.
export async function createInference(pipeline, env, progress, {
  random = Math.random, onEngagement = () => {},
} = {}) {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.numThreads = 1; // GitHub Pages has no cross-origin isolation.
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.wasmPaths = WASM;
  const asr = await pipeline('automatic-speech-recognition', ASR.id, {
    revision: ASR.revision, device: 'wasm', dtype: 'q8',
    progress_callback: event => progress('Listening', event),
  });
  const generator = await pipeline('text-generation', LLM.id, {
    revision: LLM.revision, device: 'webgpu', dtype: 'q4f16',
    progress_callback: event => progress('Chat', event),
  });
  let lastAttempt = -Infinity, lastSpeech = '', previousLanguage = '', voice = 0;
  const recent = [], context = [];
  return async (audio, language, now = performance.now()) => {
    if (!(audio instanceof Float32Array) || audio.length > WINDOW_SAMPLES || audio.length < 1600)
      return { comment: '' };
    let energy = 0;
    for (const sample of audio) {
      if (!Number.isFinite(sample)) return { comment: '' };
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / audio.length);
    if (rms < 0.006) return { comment: '' };
    const started = performance.now();
    const output = await asr(audio, {
      language: language === 'ja' ? 'japanese' : 'english',
      task: 'transcribe', max_new_tokens: 96,
    });
    const text = (output.text?.trim() || '').slice(-400);
    if (!meaningfulSpeech(text)) return { comment: '' };
    if (language !== previousLanguage) recent.length = 0;
    if (language !== previousLanguage || now - (context.at(-1)?.now ?? -Infinity) > 24000) {
      context.length = 0;
      lastSpeech = '';
    }
    previousLanguage = language;
    while (context.length && now - context[0].now > 24000) context.shift();
    const repeated = text === lastSpeech;
    const interest = speechInterest(text, language, rms) * (repeated ? 0.5 : 1);
    // Publish before generation: reactions continue even if chat is skipped/filtered.
    onEngagement(interest);
    const previous = context.map(item => item.text).join(' ').slice(-400);
    if (!repeated) {
      context.push({ text, now });
      while (context.length > 3) context.shift();
    } else if (context.length) {
      context.at(-1).now = now;
    }
    lastSpeech = text;
    if (repeated || now - lastAttempt < MIN_COMMENT_INTERVAL || performance.now() - started > 18000)
      return { comment: '', interest };
    const first = lastAttempt === -Infinity;
    lastAttempt = now; // Throttle skipped and filtered attempts too.
    if (!first && random() > 0.2 + interest * 0.8) return { comment: '', interest };
    const speaker = voice++ % VOICES.length;
    const prompt = generator.tokenizer.apply_chat_template(
      messagesFor(text, language, { context: previous, recent, voice: speaker }),
      { tokenize: false, add_generation_prompt: true, enable_thinking: false },
    );
    const results = await generator(prompt, {
      max_new_tokens: 64, do_sample: true, temperature: 0.7,
      top_p: 0.9, top_k: 40, repetition_penalty: 1.15,
      no_repeat_ngram_size: 3, return_full_text: false,
    });
    const generated = results[0]?.generated_text;
    const raw = Array.isArray(generated) ? generated.at(-1)?.content : generated;
    const cleaned = cleanComment(raw || '', recent, language);
    const comment = sharesTopic(cleaned, `${previous} ${text}`, language) &&
      !echoesSpeech(cleaned, text, language) ? cleaned : '';
    if (comment) {
      recent.push(comment);
      if (recent.length > 20) recent.shift();
    }
    return { comment, interest, voice: speaker };
  };
}
