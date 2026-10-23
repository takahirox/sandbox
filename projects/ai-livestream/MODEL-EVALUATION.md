# Local model and pipeline evaluation — issue #50

## Decision

Use **Qwen3 1.7B, MLC q4f16_1, WebLLM 0.2.85**, keeping **Whisper Base q8** on
single-threaded WASM. The sharded MLC build initialized, produced better short
follow-ups, and used less measured browser memory than the existing 0.6B ONNX
stack. It increases the first download from about 680 MB to **1.1 GB**. This is a
measured change of runtime/conversion as well as parameter count; simply increasing
the ONNX model size failed. No remote inference or automatic model fallback is used.

## Method and resource evidence

On 2026-10-23, six synthetic Japanese/English WAVs passed through actual browser
ASR and generation on an Apple M4 Max, 64 GiB RAM, headless Chromium
153.0.8010.12, Metal / `shader-f16`. No camera, microphone or account was used.
The 2.97–5.85-second fixtures cover cats in a park / coffee aroma, a coffee
temperature discovery with an audience question, and a quiet tea break, in both
languages. All speech fits in the six-second window. Exact text, TTS provenance,
audio, baseline source and raw results live in `tests/fixtures/ai-livestream/`.

| Text stack | Text weights | Models/tokenizers/library assets* | Cold initialization | Peak aggregate browser RSS | Generation per fixture |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original Qwen3 0.6B ONNX q4f16 | 569.8 MB | 658.6 MB | 69.94 s | 4.59 GiB | 0.21–0.37 s |
| Qwen3 0.6B MLC q4f16_1 | 335.4 MB | 432.1 MB | 129.54 s | 2.30 GiB | 0.11–0.28 s warm; 2.13 s first |
| **Qwen3 1.7B MLC q4f16_1** | **968.0 MB** | **1,064.8 MB** | **121.49 s** | **2.84 GiB** | **0.18–0.75 s** |
| Qwen2.5 1.5B ONNX q4f16, legacy runtime | 1,221.9 MB | 1,308.6 MB | Aborted after 136.48 s | 4.47 GiB up to failure | No generation |
| Qwen3 1.7B ONNX q4f16, legacy runtime | 1,426.1 MB | 1,514.9 MB | Aborted after 150.75 s | 5.26 GiB up to failure | No generation |

*Decimal MB; includes ASR and model tokenizers, and MLC's 5.6 MB compiled library.
Excludes runtime JS and ONNX WASM, bringing the selected total to approximately
1.1 GB. ONNX sizes come from download progress totals; MLC uses exact pinned shard
manifest sizes plus tokenizer/library HTTP metadata. Both the manifest and all
weight shards are immutable assets. ASR took about 2.3–2.8 seconds per window;
selected end-to-end fixture jobs took 2.51–3.43 seconds. A separate production
ASR/WebLLM smoke run passed in 105 seconds including downloading/loading.

RSS samples sum the browser, renderer, GPU and utility process resident memory
once per second using CDP process IDs and `ps`. Shared pages can be counted twice,
sub-second peaks can be missed, and RSS is not unique GPU allocation or JS heap.
The WebLLM catalog estimates roughly 2 GB VRAM for this model; the app limits
context to 1,536 tokens and prefill chunks to 256. Allow roughly 4–6 GB free during
loading. The old README's 1–2 GB allowance was too optimistic for its ONNX stack.

Cold initialization includes downloading and session creation, excluding the
runtime import. Fresh contexts were used; MLC candidates were evaluated
concurrently, so bandwidth/cache/compilation variation makes cold-load times
unsuitable for ranking model speed. This is one capable desktop, not a broad
hardware benchmark. The selected stack requires WebGPU / `shader-f16`; recognition
uses single-threaded WASM because Pages lacks cross-origin isolation. Desktop
Chrome/Edge are the intended devices. Mobile layout is tested; mobile inference
and low-memory GPU compatibility are not established by this measurement.

Other recorded experiments explain the choice:

- The two larger ONNX conversions aborted with the pinned Transformers.js 3.8.1 /
  ONNX Runtime 1.22 dev stack. Retesting 1.7B with Transformers.js 4.2.0 and its
  matching runtime failed with `std::bad_alloc`. No quality score or generation
  latency is invented for a model that never initialized.
- Qwen3 0.6B GPU q8 emitted multilingual gibberish, taking 12–14 seconds per reply;
  CPU q8 produced coherent but often verbose/awkward replies in 3.8–8.9 seconds.
  Float32 q4 aborted. Qwen2.5 0.5B ONNX q4f16 also failed the reply-quality fixtures.
  These observations implicate conversion/runtime behavior as well as tiny-model
  capability; parameter count alone does not explain the output.
- Newer ONNX runtime experiments also encountered a Whisper QDQ optimizer error
  (basic optimization avoided it). The production ASR/runtime pins remain
  unchanged. The MLC backend avoids the large single ONNX text graph and its
  observed initialization failures without raising the memory budget.

Reports named `comparison-*.json` retain these failures and exploratory outputs.
Earlier reports used prompts before the language reset/few-shot fixes; rerunning
an exploratory variant uses the current prompt and can produce different output.
The final MLC reports preserve observed raw/model-filtered output and a separate
`finalComment` replay of the final deterministic language/topic/echo filters.

## Quality examples and diagnosis

The baseline is the exact pre-change `config.mjs` / `inference.mjs` from `fdacade`:
greedy decoding, one window, no persona/reply history, ten-second cadence and
literal topic overlap. The final evaluation seeds generation with 42 and injects
scheduler randomness to exercise each topic. Jobs are 120 seconds apart to isolate
topics; production cadence/context/expiry use separate injected-clock tests.
GPU arithmetic and unseeded production sampling can still vary.

| Fixture | Original output/problem | Selected model raw reply after removing the empty thinking prefix | Final decision |
| --- | --- | --- | --- |
| Japanese cats | Introduced an unmentioned child: `今日もお子様の猫が可愛らし！` | `猫がどの色の子だったのか？` | Keep concrete question; wording can still be stiff |
| English coffee | Invented `A friend shared that they loved the taste and aroma of coffee.` | `What's your favorite coffee scent?` | Keep short topical question |
| Japanese discovery | Retold the reduced bitterness as another person's observation | `コーヒーの苦みが減ったのは、ボンドを下げたから。` | Suppress speech echo, including the ASR mistake |
| English discovery | `A streamer asked, “Why does lowering the water temp fix my bitter coffee?”` | `Why not try adding sugar?` | Keep related suggestion without forcing a literal coffee token |
| Japanese quiet tea | Invented lunchtime: `お昼には、静かにお茶を飲むよ。` | `お茶を飲んで、少し休みたいです。` | Suppress retelling the host's action as the viewer's own |
| English quiet tea | Invented a friend and a visible action: `The streamer smiled as they relaxed.` | `What tea are you having?` | Keep short conversational question |

Four of six final replies survive; two echoes are withheld. No canned replacement
is inserted. The 0.6B MLC comparison asked the awkward `Which coffee smell did you
love?`, repeated `What would you try next?` without a concrete topic, and speculated
that bitterness depended on one's mental state. The selected model gives more
useful English follow-ups without that invented explanation. This small fixture
set establishes concrete improvements and regression cases, not universal fluency
or a moderation/factuality guarantee. Japanese wording and recognition still need
caution; the documentation does not claim all six replies are good.

Dominant factors and changes:

- **Generation stack / prompting:** baseline English ASR was accurate while
  generation invented people/events/video actions. These failures occur after
  recognition. Sampling/personas alone did not fix them. A direct viewer role,
  one unrelated example, explicit reply language, a measured stronger MLC model,
  and anti-echo/narration filters improve the actual output. Four voices rotate
  questions, casual reactions, preferences and noticing changes. There are no
  invented biographies or hundreds of inference instances.
- **Transcription:** Whisper misheard 公園 as `5円` and 温度 as `ボンド` in two
  Japanese fixtures. Cats/coffee survived, but temperature did not. All English
  and quiet Japanese topics survived. A larger ASR cannot fix the baseline's
  invented English friends/actions, and recognition already dominates latency;
  no larger ASR download is justified as the primary fix here. Retain Base and
  record these limitations; echo filtering prevents confidently repeating the
  misrecognized causal claim.
- **Decoding/history:** greedy baseline replies repeated across two runs. Final
  sampling uses temperature 0.7/top-p 0.9, repetition 1.15 and frequency/presence
  penalties 0.25/0.15. Three recent replies discourage repetition; 20 are retained
  for deduplication. Language changes clear context and reply history to prevent
  the cross-language contamination observed during exploration. Nonempty thinking
  output is rejected; only the empty disabled-thinking prefix is removed.
- **Chunking:** fixture ASR errors are not truncation because all audio fits.
  Real speech spans windows, so up to three recent transcripts provide at most
  400 context characters for 24 seconds. A test verifies a fragment such as
  “Should I lower it further?” can use the preceding temperature discussion and
  that silence/language changes expire that context.
- **Gating:** word boundaries/common inflections avoid false matches such as
  `rest` inside `interesting`. A small explicit topic-concept list allows related
  responses such as sugar after bitterness. Questions can reuse topic words;
  non-question replies mostly copying speech are withheld. This is a heuristic,
  not a semantic fact checker. Privacy, URL, unsafe-vocabulary, visual-claim,
  length, duplicate and caption-boilerplate protections remain in place.
- **Scheduling:** ASR can run every six seconds with one job/no queue. Interest
  publishes before generation even when chat is skipped or filtered. Attempts
  are separated by 18 seconds and probabilistic; repeated transcripts produce
  no repeated chat. Silence creates no topic or filler comment.

## Deterministic audience evidence

Seed 42, RMS 0.03, one content signal every six seconds, five minutes of one-second
ticks, **zero chat messages**:

| Speech | Interest | Viewers | Auto likes | Auto subscriptions |
| --- | ---: | ---: | ---: | ---: |
| Japanese discovery/question | 0.825 | 1,821 | 261 | 8 |
| English discovery/question | 0.914 | 2,010 | 268 | 13 |
| Japanese quiet tea/break | 0.187 | 482 | 7 | 0 |
| English quiet tea/break | 0.171 | 449 | 5 | 0 |

Silence then reduces engaged viewers below half within three minutes; settled
silence adds no reactions. Tests cover rate limits, long-run caps, clock stalls,
reset, no-chat reactions, manual-choice independence and model errors/deadlines.
Scores use transcript/audio heuristics, not emotion or camera understanding.

## Reproduce and provenance

After normal Playwright setup:

```sh
node scripts/compare_livestream_models.mjs --baseline
node scripts/compare_livestream_models.mjs --mlc-small
node scripts/compare_livestream_models.mjs --mlc
node --test tests/ai-livestream.test.mjs
LOCAL_AI_SMOKE=1 node --test tests/ai-livestream-model.test.mjs
```

The comparison script explicitly downloads public model assets and saves only
synthetic fixture output. With no flag it compares baseline and both MLC sizes.
Optional `--qwen3`, `--qwen25`, `--qwen05`, `--q8`, `--q4`, `--cpu`, `--modern`,
`--modern-stronger` reproduce alternate conversion/runtime experiments. The normal
suite uses mocks and recorded outputs, requires no weights/hardware and has no
external production-network or human acceptance gate.

Production pins/licenses are in [README.md](./README.md) and [config.mjs](./config.mjs).
The selected [MLC 1.7B conversion](https://huggingface.co/mlc-ai/Qwen3-1.7B-q4f16_1-MLC/tree/80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc)
and [0.6B comparison](https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f16_1-MLC/tree/8c14ce481d4c692769976ad52afea453a102df19)
use immutable revisions. Failed ONNX candidates use
[1.7B revision 3231b522](https://huggingface.co/onnx-community/Qwen3-1.7B-ONNX/tree/3231b522c6e703b2f9b3cd8ea27426a1289a02f2)
and [1.5B revision d54957e3](https://huggingface.co/onnx-community/Qwen2.5-1.5B-Instruct/tree/d54957e3af1be04546436e874a60fe386041b244).
[WebLLM's local engine and configuration API](https://webllm.mlc.ai/docs/user/basic_usage.html)
and [Transformers.js WebGPU support](https://huggingface.co/docs/transformers.js/guides/webgpu)
are documented by their maintainers. An OpenAI-shaped JavaScript method in WebLLM
is a local GPU call, not an HTTP inference request.
