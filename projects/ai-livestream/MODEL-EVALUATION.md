# Local model and pipeline evaluation — issues #52 / #50


## Issue #52: retain 1.7B and repair the pipeline

The shipped model was already **mlc-ai/Qwen3-1.7B-q4f16_1-MLC**, pinned revision
`80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc`, running WebLLM 0.2.85 / WebGPU,
with Whisper Base q8 / single-threaded WASM. This change retains those assets.
No larger text model, new download, service, cloud inference or recurring cost is
introduced. The historical model-size/runtime comparison below remains evidence
for this selection; it is not a new 0.6B-to-1.7B upgrade in #52.

### Failure trace and offline comparison

`issue50/` snapshots the shipped config/inference from `40b9e91` for reproducible
comparison. `node scripts/replay_livestream_pipeline.mjs` produces
`tests/fixtures/ai-livestream/pipeline-replay.json`, and the normal automated suite
asserts that exact evidence. Synthetic fixtures only; nothing comes from a user's
session. Three comparisons deliberately separate model output from scheduling:

| Replay | Recognized windows | Shipped #50 accepted | Revised accepted | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Recorded real Japanese/English 1.7B output, isolated 120 s apart | 6 | 4 (67%) | 4 (67%) | Same four topical follow-ups; two echoes still suppressed |
| Scripted natural pronoun follow-ups, Japanese/English | 2 | 0 | 2 (100%) | Lexical gate falsely rejected implicit references |
| Scripted distinct coffee conversation, six-second windows for 120 s | 20 | 1 (5%) | 10 (50%) | Eight-second opportunity gate, no probabilistic starvation; ~5/minute with available generation |

The conversation deliberately injects scheduler randomness 0.99, demonstrating a
possible starvation path, **not average measured production acceptance**. Its ASR
and replies are mocks. The isolated replay uses actual recorded transcripts/raw
outputs from #50; it does not rerun weights or claim improved model fluency.
Examples of previously rejected scripted follow-ups are “How long did that take?”
and “それ、人懐っこい子だった？” Neither needs to copy the source noun. A fresh
model run is reported separately below.

The observed implementation causes are independently testable:

1. A six-second audio window passes the worklet's 350 ms voiced threshold and the
   Worker's RMS >= 0.006 gate; silent/invalid windows never reach ASR. VAD silence
   and backpressure now have counters.
2. ASR exceptions, boilerplate/empty recognition and accepted recognition have
   different counters. Two historical Japanese detail errors recur in fresh ASR;
   English recognition is accurate on these fixtures.
3. The old 18-second attempt gate also consumed rejected/skipped opportunities;
   probability at ordinary interest ~0.42 was only ~54%. Recognition taking over
   18 seconds skipped generation altogether. Revised first recognition can generate
   immediately, subsequent opportunities are at least eight seconds apart, and
   there are no random skips or audience-dependent generation rates.
4. Output parsing supports strings and structured assistant content and removes
   only an empty disabled-thinking prefix. Nonempty reasoning, bad formatting,
   language mismatch, safety/privacy, visual/generic output, length, duplicates,
   disconnected topics and echoes have categorized rejection counters. Pronoun
   references and preferences can survive without fragile exact noun/echo overlap.
   Japanese causal endings are excluded from content-word echo scoring.
5. The UI previously discarded every result older than 24 seconds, including a
   valid slow reply on an unchanged topic. There is now one active inference and
   one replaceable latest audio window. If speech arrives during generation, hold
   its reply in Worker memory and validate it against newer recognition before
   publishing (at most 90 seconds from the original ASR start). A changed topic,
   expired candidate or language change discards it. No newer speech means a slow
   reply can display directly within the existing 90-second job deadline. There
   is no backlog burst. End terminates the Worker and clears pending audio/chat.

Prompts keep latest speech primary, earlier context only for fragments/pronouns,
and instruct the model not to infer missing prices, causes, comparisons or
outcomes. The unrelated guitar example, four viewer styles, language reset,
24-second / three-window / 400-character context, three recent prompt replies,
20-comment dedup history and sampling remain bounded. Tests verify context expiry,
voice variation, structured parsing, slow inference, changed topics, silence,
safety, repetition and cancellation. One short response per inference is retained:
forcing multiple replies would increase filler and repeat risk on quiet windows.

`?debug=1` traces each stage with a closed vocabulary of counts, numeric timings,
exact model/backend identity and time since the last UI comment. Browser tests
exercise the real AudioWorklet → Worker → ASR mock → local text-engine mock →
filter → UI path, including a valid recognized fixture yielding SKIP. Its panel
shows accepted recognition + generation attempt + format rejection + zero comments,
without speech, prompts, exception text, IPs, media or persistent telemetry.
The normal screen and inert screenshot preview are unchanged.

### Fresh 1.7B versus stronger 4B: measured on the same fixtures

Three actual browser runs on 2026-10-23 used an Apple M4 Max / 64 GiB, Chromium
153.0.8010.12 / Metal / shader-f16, seed 42, the six existing WAVs, the same ASR,
1,536-token context, disabled thinking and q4f16_1 WebLLM backend. Each fixture was
120 seconds apart to isolate topics; continuous cadence is tested offline above.
The first 1.7B run used the initial latest-speech prompt; the second added the
explicit no-inferred-price/cause instruction. It did **not** fix the Japanese
ASR-induced mistakes. 4B used that same second prompt and voices.

| Stack | Model/tokenizer/library assets* | Initialization | Peak browser RSS | Generation / fixture | End-to-end / fixture | Final filter acceptance |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.7B, initial prompt | 1,064.8 MB | 121.74 s | 3.42 GiB | 0.19–0.41 s | 2.47–3.02 s | 4/6 |
| **1.7B, revised prompt** | **1,064.8 MB** | **110.96 s** | **3.14 GiB** | **0.20–0.67 s** | **2.43–3.34 s** | **4/6** |
| 4B, same revised prompt | 2,360.1 MB | 287.46 s | 3.67 GiB | 0.41–1.71 s | 2.78–5.21 s | 6/6 |

*Same asset accounting and RSS caveats as the historical methodology below;
runtime JS/ASR WASM add overhead. First use is roughly 1.1 GB versus 2.4 GB.
Initialization includes downloads/session creation on one connection; it is not a
universal hardware-speed claim. All six ASR windows preserve the fixture topic,
but both runs misrecognize 公園 as `5円` and 温度 as `ボンド`. ASR timings were
2.23–2.67 s for revised 1.7B and 2.37–4.05 s in the separate 4B run; the text model
cannot repair evidence it was never given. Two model runs do not establish broad
sampling variability; prompt variation here shows concrete output sensitivity.

Representative **observed** replies (not canned replacements):

| Fixture | Revised 1.7B | 4B | Assessment |
| --- | --- | --- | --- |
| Japanese cats | `今日は何で猫を買ったの？` | `5円で猫を見たの？` | Both follow ASR's corrupted price premise; 1.7B additionally assumes buying |
| English coffee | `What's your favorite coffee drink?` | `What's your favorite coffee drink?` | Same short topical question |
| Japanese discovery | `コーヒーの苦みが減ったのは、ボンドを下げたことによるですね。` | `ボンド下げたってこと？` | 1.7B retelling withheld; 4B asks about the same misheard word |
| English discovery | `Why does coffee taste better when it's colder?` | `Try adjusting the water ratio instead.` | Both related; 4B offers a useful alternative |
| Japanese quiet tea | `お茶を飲んでいたことだけ。` | `今日は静かにしていますか？` | 1.7B retelling withheld; 4B grammatical but redundant |
| English quiet tea | `You sure you'll be back soon?` | `Tea? What kind?` | Both conversational, short and related to the break/tea |

Filter acceptance is **not a factual-quality score**. Excluding the two known
ASR-contaminated Japanese detail cases leaves 3/6 accepted replies for revised
1.7B and 4/6 for 4B. Automated fixture assertions reproduce this narrow rubric;
it does not claim to detect arbitrary hallucinations or evaluate all naturalness.
The original #50 real run accepted 4/6, without the new price premise but with
stiff Japanese and two withheld retellings. The fresh comparison confirms the
scheduling/filter fixes increase opportunities, not that every generated reply
has become fluent. ASR mistakes and unsupported assumptions remain limitations.

**Retain 1.7B.** 4B improves one surviving quiet Japanese reply, but repeats both
ASR errors, costs 1.3 GB more (~2.2× assets), and comes within 13 seconds of the
five-minute loading deadline on this capable desktop. Its measured RSS increase
is modest, rather than a claimed out-of-memory failure, but neither run establishes
mobile inference feasibility. A 2.4 GB download plus slower generation is a poor
trade for this small observed gain. Both require WebGPU/shader-f16; no CPU/cloud
fallback or automatic model switch is introduced. The more frequent opportunities,
reference-aware filters and safe reason counts are the material experience fix.

Evidence files are `comparison-mlc-issue52-initial.json`,
`comparison-mlc-issue52.json` and `comparison-mlc-stronger-issue52.json` under
`tests/fixtures/ai-livestream/`. They retain actual `raw`, `transcript`, measured
`comment`, timings and costs. `finalComment` / `finalReason` replay the final filters
(including later echo/reference fixes); they do not overwrite the measured output.
Only these synthetic, explicit evaluation artifacts contain speech/model content;
production diagnostics never do.

The evaluation-only stronger model is
[mlc-ai/Qwen3-4B-q4f16_1-MLC](https://huggingface.co/mlc-ai/Qwen3-4B-q4f16_1-MLC/tree/a5c9fab855e3ccbdfed2e7e69683d75f30332161),
revision `a5c9fab855e3ccbdfed2e7e69683d75f30332161`, with the
[compiled Qwen3-4B library](https://github.com/mlc-ai/binary-mlc-llm-libs/blob/00fe7a40e57e5e8eb9fef87526a4bf28ad5846c0/web-llm-models/v0_2_84/base/Qwen3-4B-q4f16_1_cs1k-webgpu.wasm).
These are not permitted production download targets. Reproduce without devices:

```sh
node scripts/compare_livestream_models.mjs --mlc --issue52
node scripts/compare_livestream_models.mjs --mlc-stronger --issue52
```

### Small-audience evidence

Seed 42, one recognized signal per six seconds, five minutes, **zero chat**:

| Fixture | Displayed viewers | Auto likes | Auto subscriptions |
| --- | ---: | ---: | ---: |
| Japanese discovery | 63 | 14 | 0 |
| English discovery | 58 | 15 | 0 |
| Japanese quiet tea | 38 | 0 | 0 |
| English quiet tea | 36 | 0 | 0 |

Start is 25, compared with #50's 300. Viewers change only once per 25 seconds,
−3 to +4, with occasional departures during engaging speech; they decline during
silence. Internal state stays close to the display. Limits are 5–180 viewers,
500 likes and 30 subscriptions; long-run tests reach the reaction caps. Zero
subscriptions in a short small-stream session is intentional. Manual toggles
add exactly zero or one independently. A stalled tick integrates at most two
seconds and publishes one bounded change; stopping cancels timers and resets the
simulation. Historical #50's 1,821–2,010 engaged viewers and 261–268 likes in five
minutes were disproportionate to this experience.

### Issue #52 validation

All local acceptance checks passed with no required human/device approval:
15 livestream tests (including real Worklet/Worker mocked browser paths and
recorded 1.7B/4B replay), 11 gallery/coin/walk tests, 11 Python build tests,
71 backend tests and 27 backend browser integrations. The backend dry-run bundle,
local D1 migration plus idempotent repeat, and full frontend build with eight safe
gallery captures passed. The three real-model fixture runs above are additional
evidence; normal CI requires neither weights nor a GPU. No deployment was performed.

## Historical issue #50 decision

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
