# AI Livestream

A static, private livestream **simulation** refined in [sandbox issue #52](https://github.com/takahirox/sandbox/issues/52).
Open `index.html` through HTTPS or a localhost HTTP server, choose Japanese or English,
and press **Go live**. Allow a camera and microphone. After the first model download,
speak normally; an occasional fictional viewer comment responds to recent speech.
**End** releases both devices. Switching tabs or leaving the page also ends the session.
The unobtrusive **About** menu explains the simulation, local reactions, permissions,
and initial model download. The player shows **Camera & mic on** whenever capture
is active, including during loading; no real broadcast or audience is claimed.
Viewer counts, likes and subscriptions are fictional, temporary reactions to recognized
speech. Your own Like/Subscribe choices are independent and last until the page is
reloaded. There is no connected audience, account, upload, stream, analytics, or backend.

## Compatibility and performance

Use a current desktop Chrome or Edge with WebGPU, `shader-f16`, AudioWorklet,
and camera/microphone access enabled. Other browsers/devices may work when they
provide these APIs. The app checks GPU support before asking for media or loading
models. Unsupported devices get a retryable message, never a remote API fallback.
Speech uses single-threaded WebAssembly; chat uses WebLLM on WebGPU. A CPU-only language
model fallback is deliberately omitted because its latency would make this demo
unusable on many devices. Mobile layout is supported; mobile inference depends
on the device and available GPU memory.

Expect about **1.1 GB** on first use, plus temporary inference memory (allow roughly
4–6 GB of free memory during loading). Actual speed and memory depend on the
GPU, CPU, browser and device. Japanese recognition with Base can miss words, particularly with noise,
quiet speech, or partial sentences. Select the spoken language before starting.
Downloads stop with End; completed model assets can be reused from browser cache.
Failed downloads, lost devices, GPU/runtime errors and slow operations end cleanly
and leave Go live available. Loading has a five-minute limit and each inference job
has a 90-second limit. A slow connection can require another attempt.

## Local processing and privacy

- The initial preview uses only project HTML, CSS and JS. It does not request
  devices, import the AI runtime, download weights, or run inference. Gallery
  screenshots render the same inert illustration and empty chat.
- Only explicit Go live requests camera and mic. The video element is locally muted.
  An AudioWorklet averages microphone samples to mono 16 kHz with a fixed six-second
  window (96,000 float samples). Windows with under 350 ms of sufficiently loud
  audio are dropped; a second energy gate runs before recognition. Acknowledgements
  allow at most one audio message to wait on the UI thread, even if it stalls.
- One dedicated module Worker runs ASR followed by language generation. There is
  one job at a time and one replaceable latest audio window while busy; no growing
  queue. Six-second windows use a 5.5-second submission guard (allowing scheduling jitter), with an eight-second
  minimum between comment opportunities, at most 96
  transcription tokens and 64 generated tokens. Audio arriving while loading
  is discarded; busy audio replaces the pending window. This bounds resources and
  prioritizes recent speech over backlog. There are no random opportunity skips or
  viewer-dependent inference rates. A first meaningful window can generate immediately;
  six-second windows typically yield one opportunity every twelve seconds.
  Slow replies are not rejected merely for taking 24 seconds. If newer speech arrived,
  a reply is held in the Worker until the latest recognition confirms its topic (within
  90 seconds); otherwise it is discarded. End cancels all pending work. Silence produces no job
  or filler chat. Recognizer errors/hallucinations remain possible.
- Transcription is supplied as quoted context to Qwen, which generates the actual
  comment; there is no canned comment roulette. Reasoning mode is disabled. A
  rolling prompt context uses at most 400 characters from three speech windows
  for 24 seconds;
  it expires on silence or language changes. Four viewer voices rotate between
  questions, casual reactions, preferences and noticing changes. Sampling uses
  temperature 0.7, top-p 0.9, repetition penalty 1.15 and frequency/presence
  penalties. One unrelated question/reply example establishes the conversational
  format; it is never substituted for generated output. Three recent replies
  discourage repetition.
  Short, safe topical replies survive a word/concept or conversational-reference check
  (including pronoun-based follow-ups). Explicit preferences and questions may reuse
  topic words without being treated as echoes. Generic praise, visual claims, URLs,
  unsafe vocabulary, wrong-language replies, speech echoes, multiline/long replies
  and duplicates are suppressed. These
  checks are imperfect, not a moderation or factuality guarantee. Odd wording and
  ASR mistakes remain possible. The AI never receives camera frames.
- Audience scoring uses only recognized words, questions, detail, invitations and
  a small bounded audio RMS contribution. It does not infer emotions or understand
  video. Each score is posted before chat generation. Skipped/filtered replies
  still influence reactions. Interest affects only fictional engagement;
  comment opportunities are deterministic. Repeated transcripts cannot generate repeated chat. Silence produces
  no topic or filler comment.
- The timer-free `VirtualAudience` state machine starts at 25 displayed viewers
  after capture starts (held steady while loading). One UI timer computes bounded
  internal engagement each second after models are ready. The displayed watching
  count updates at most once every 25 seconds, by −3 to +4; some viewers can leave
  even during engaging speech. Internal state stays close to the displayed count,
  so silence does not keep increasing the display to catch up with hidden growth.
  Interest fades within 18 seconds of the last recognized speech. Viewer state is
  bounded to 5–180, with a quiet target of 9 and engaged targets in the low hundreds.
  Likes/subscriptions accrue independently of chat at the smaller audience scale;
  subscriptions require sustained interest above 0.55 and are rare. Simulated totals
  cap at 500 likes/30 subscriptions. A stalled tick integrates at most two seconds
  and publishes only one bounded viewer change, so delays never create a catch-up
  burst. End cancels the timer and resets simulated counts; manual choices are
  preserved and contribute exactly zero or one. Nothing is persisted.
- Network traffic consists of static page/runtime/model GETs from the site,
  jsDelivr, Hugging Face, its asset delivery hosts and a pinned model library on
  raw.githubusercontent.com. The inference Worker's fetch guard permits only GET asset requests. No inference API, WebSocket,
  service worker, telemetry or application-server writes are used. Asset providers
  receive ordinary download request metadata such as IP address, **never audio,
  video, transcripts, prompts or comments**. No credentials are required.
- Only runtime/model assets may persist in ordinary HTTP/Cache Storage caches
  (Transformers.js uses `transformers-cache`; WebLLM uses model, WASM and config
  Cache Storage caches). Clear this site's browser storage to remove model cache. User media, transcripts and chat are never persisted.
  The camera is never sampled by code or recorded. Current chat has a 60-row limit;
  Worker deduplication keeps 20 recent comments. End clears chat, terminates the
  Worker (including in-flight inference/downloads), closes AudioContext and stops
  every media track. Late permission responses are stopped immediately.

## Pinned dependencies and licenses

| Asset | Exact version/revision | Download | License/source |
| --- | --- | --- | --- |
| Transformers.js, bundled browser ESM | `3.8.1` | ~0.9 MB JS | Apache-2.0; [Hugging Face](https://github.com/huggingface/transformers.js/tree/3.8.1) |
| ONNX Runtime Web, matching bundled runtime's WASM | `1.22.0-dev.20250409-89f8206ba4` | Tens of MB runtime/WASM | MIT; [Microsoft](https://github.com/microsoft/onnxruntime) |
| [Xenova/whisper-base](https://huggingface.co/Xenova/whisper-base/tree/64da57285918e20ea79ea5c88eed7197933abaa8), multilingual, q8 | `64da57285918e20ea79ea5c88eed7197933abaa8` | 76.9 MB encoder + merged decoder, plus tokenizer/config | Conversion repository Apache-2.0; [original Whisper](https://github.com/openai/whisper) MIT |
| WebLLM browser ESM | `0.2.85` | 6.6 MB JS | Apache-2.0; [MLC](https://github.com/mlc-ai/web-llm/tree/v0.2.85) |
| [mlc-ai/Qwen3-1.7B-q4f16_1-MLC](https://huggingface.co/mlc-ai/Qwen3-1.7B-q4f16_1-MLC/tree/80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc) | `80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc` | 968.0 MB weight shards + 11.4 MB tokenizer/config | [Original Qwen](https://huggingface.co/Qwen/Qwen3-1.7B), Apache-2.0 |
| MLC compiled WebGPU model library, `v0_2_84/base/Qwen3-1.7B-q4f16_1_cs1k-webgpu.wasm` | `00fe7a40e57e5e8eb9fef87526a4bf28ad5846c0` | 5.6 MB | Apache-2.0; [MLC binary libraries](https://github.com/mlc-ai/binary-mlc-llm-libs/tree/00fe7a40e57e5e8eb9fef87526a4bf28ad5846c0) |

Sizes are decimal MB, approximate, excluding browser overhead. Models are fetched
from immutable revision paths; runtime and WASM use exact jsDelivr npm versions.
WebLLM's chat-completion method runs inside the Worker, not through an HTTP API.
It has one pinned model entry, a 1,536-token context, 256-token prefill chunks and
no thinking output. Its conversation/KV state is reset before each comment; only
the bounded quoted context is supplied again. No model files or third-party runtime
code are vendored in this project. See
[`config.mjs`](./config.mjs) for the authoritative pins. The illustration is original CSS.

## Validation

From the repository root (Node 22+, Python 3.9+):

```sh
npm ci --prefix workers/persistent-counter
npm exec --prefix workers/persistent-counter -- playwright install chromium
node --test tests/ai-livestream.test.mjs
python3 -m unittest discover -s tests -v
python3 scripts/build_site.py
node --test tests/gallery.test.mjs tests/pokemon-coin-flip.test.cjs tests/walk-to-hospital.test.mjs
```

The normal suite uses fake media devices, mocked AI and synthesized audio buffers.
It checks seeded Japanese/English audience trajectories, silence/decline, count caps,
reactions without chat, manual-choice independence, rolling context/voice selection,
resource cleanup, permission races/errors, unavailable GPU, failed model
downloads, silence, language/context transfer, cadence, bounded history, filtering,
video-first desktop/mobile layout, keyboard focus, reduced motion and network
inactivity. DOM checks reject removed filler copy and technical badges in every
session state, verify the single About disclosure, and check contextual loading,
capture, ended and error feedback. The gallery suite captures the inert preview
without media permissions or model downloads. CI runs these without weights or hardware.

For the opt-in bounded **real-model** test on a WebGPU-capable machine:

```sh
LOCAL_AI_SMOKE=1 node --test tests/ai-livestream-model.test.mjs
```

This downloads the pinned ASR/WebLLM assets and passes synthetic Japanese/English WAV fixtures
through the same ASR/generator implementation in a browser Worker. It asserts
recognized topics, short topical generated comments, and GET-only asset traffic;
it never requests real camera/mic access. See fixture provenance in
`tests/fixtures/ai-livestream/README.md`. This is intentionally excluded from ordinary
CI to avoid hardware requirements and repeated large downloads. `?debug=1` shows
only ephemeral numeric counters, last ASR/generation timings, seconds since the last
visible comment, and exact model/backend identity. It traces VAD silence/backpressure,
audio submissions/pending windows, ASR errors/accepted recognition, cadence/repeated
speech, generation errors, categorized output rejection, context validation, Worker
results, UI insertion/discards and engagement ticks. A closed event vocabulary
rejects arbitrary strings. No audio, transcripts, prompts, runtime exceptions or
identifying details enter this panel, logs, telemetry or storage. End clears it.

The ordinary suite also replays the recorded 1.7B outputs and scripted bilingual
follow-ups through the issue #50 and current pipelines, without weights:

```sh
node scripts/replay_livestream_pipeline.mjs
```

`pipeline-replay.json` records acceptance frequency/reasons and deterministic
small-audience trajectories. This is a scheduling/filter comparison, not a new
model-quality or hardware benchmark. The real-model comparison can be saved
separately from historical evidence with
`node scripts/compare_livestream_models.mjs --mlc --issue52`.

See [the model comparison](./MODEL-EVALUATION.md) for concrete bilingual fixture
outputs, measured resource costs, limitations and reproduction commands.
