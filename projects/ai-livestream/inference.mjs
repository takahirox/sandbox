import {
  ASR, LLM, WASM, messagesFor, meaningfulSpeech, inspectComment,
  sharesTopic, relatesToSpeech, isReferenceContinuation, echoesSpeech,
  MIN_COMMENT_INTERVAL, WINDOW_SAMPLES, VOICES,
} from './config.mjs';
import { speechInterest } from './audience.mjs';

// Shared by the actual Worker and fixture evaluation. No user content in diagnostics.
export async function createInference(pipeline, env, progress, {
  onEngagement = () => {}, onDiagnostic = () => {},
  isSuperseded = () => false, clock = () => performance.now(),
} = {}) {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.numThreads = 1;
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
  let candidate = null;
  const recent = [], context = [];
  const remember = comment => {
    recent.push(comment);
    if (recent.length > 20) recent.shift();
  };
  return async (audio, language, now = clock()) => {
    const finish = (reason, extra = {}) => {
      onDiagnostic(reason);
      if (['reasoning', 'format', 'language', 'safety', 'generic_or_visual',
        'length', 'duplicate', 'topic', 'echo'].includes(reason)) onDiagnostic('output_discarded');
      return { comment: '', ...extra };
    };
    onDiagnostic('audio_received');
    if (!(audio instanceof Float32Array) || audio.length > WINDOW_SAMPLES || audio.length < 1600)
      return finish('invalid_audio');
    let energy = 0;
    for (const sample of audio) {
      if (!Number.isFinite(sample)) return finish('invalid_audio');
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / audio.length);
    if (rms < 0.006) { candidate = null; return finish('silence'); }
    const started = clock();
    let output;
    onDiagnostic('asr_attempt');
    try {
      output = await asr(audio, {
        language: language === 'ja' ? 'japanese' : 'english',
        task: 'transcribe', max_new_tokens: 96,
      });
    } catch { candidate = null; return finish('asr_error'); }
    onDiagnostic('asr_ms', Math.max(0, clock() - started));
    const text = (output.text?.trim() || '').slice(-400);
    if (!meaningfulSpeech(text)) { candidate = null; return finish('meaningless_speech'); }
    onDiagnostic('transcription_accepted');
    if (language !== previousLanguage) {
      recent.length = 0;
      lastSpeech = '';
      lastAttempt = -Infinity;
    }
    if (language !== previousLanguage || now - (context.at(-1)?.now ?? -Infinity) > 24000)
      context.length = 0;
    previousLanguage = language;
    while (context.length && now - context[0].now > 24000) context.shift();
    const repeated = text === lastSpeech;
    const interest = speechInterest(text, language, rms) * (repeated ? 0.5 : 1);
    onEngagement(interest);
    const previous = context.map(item => item.text).join(' ').slice(-400);
    // Resolve fragments only through the contiguous, bounded recent context.
    // An explicit new subject stops the chain, even if an older topic remains
    // in the prompt. Never revive an expired subject through stored resolutions.
    const groundingParts = [text];
    if (isReferenceContinuation(text, language)) {
      for (let i = context.length - 1; i >= 0; i--) {
        groundingParts.unshift(context[i].text);
        if (!isReferenceContinuation(context[i].text, language)) break;
      }
    }
    const grounding = groundingParts.join(' ').slice(-400);
    if (!repeated) {
      context.push({ text, now });
      while (context.length > 3) context.shift();
    } else if (context.length) context.at(-1).now = now;
    lastSpeech = text;

    // A newer voiced window arrived during inference. Validate the held reply
    // against that recognition before publishing it; transcripts stay in this realm.
    if (candidate) {
      const held = candidate;
      candidate = null;
      if (held.language === language && clock() - held.started <= 90000 &&
          sharesTopic(held.text, grounding, language) &&
          relatesToSpeech(held.comment, grounding, language)) {
        // Another window can arrive while the validating ASR call is pending.
        // Allow one extra recognition to catch an intervening topic shift, then
        // publish against the latest recognized context. Waiting for an empty
        // queue starves continuous speech when ASR exceeds the capture interval.
        // The original deadline still bounds the age of the candidate.
        if (isSuperseded() && ++held.validations < 2) {
          candidate = held;
          return finish('awaiting_context', { interest });
        }
        remember(held.comment);
        return finish('output_accepted', { comment: held.comment, interest, voice: held.voice });
      }
      onDiagnostic('stale_topic');
      onDiagnostic('output_discarded');
    }
    if (repeated) return finish('repeated_speech', { interest });
    if (now - lastAttempt < MIN_COMMENT_INTERVAL) return finish('cadence', { interest });
    lastAttempt = now;
    const speaker = voice++ % VOICES.length;
    onDiagnostic('generation_attempt');
    const generationStarted = clock();
    let raw;
    try {
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
      raw = Array.isArray(generated) ? generated.at(-1)?.content : generated;
    } catch { return finish('generation_error', { interest }); }
    onDiagnostic('generation_ms', Math.max(0, clock() - generationStarted));
    const inspected = inspectComment(raw || '', recent, language);
    if (!inspected.comment) return finish(inspected.reason, { interest });
    const comment = inspected.comment;
    // Natural pronoun-based reactions need not copy the speaker's nouns.
    if (!sharesTopic(comment, grounding, language)) onDiagnostic('no_lexical_overlap');
    if (!relatesToSpeech(comment, grounding, language)) return finish('topic', { interest });
    if (echoesSpeech(comment, grounding, language)) return finish('echo', { interest });
    if (isSuperseded()) {
      candidate = { comment, text: grounding, language, started, voice: speaker, validations: 0 };
      return finish('awaiting_context', { interest });
    }
    remember(comment);
    return finish('output_accepted', { comment, interest, voice: speaker });
  };
}
