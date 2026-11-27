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
Speech uses single-threaded WebAssembly; chat uses wllama on WebGPU. A CPU-only language
model fallback is deliberately omitted because its latency would make this demo
unusable on many devices. Mobile layout is supported; mobile inference depends
on the device and available GPU memory.

The experimental default is **Japanese-adapted Qwen3 0.6B with a livestream LoRA adapter**.
Expect about **755 MB** on first use, plus temporary inference memory. Append
`?model=baseline` to use the original 1.7B generator (about 1.1 GB) on the
same recognition and comment pipeline. Actual speed and memory depend on the
GPU, CPU, browser and device. The [tuning evaluation](./TUNING-EVALUATION.md)
and [expanded-corpus evaluation](./EXPANDED-EVALUATION.md) report desktop
browser results and mobile feasibility limits. Japanese recognition
with Base can miss words, particularly with noise, quiet speech, or partial sentences. Select the spoken language before starting.
Downloads stop with End; completed model assets can be reused from browser cache.
Failed downloads, lost devices, GPU/runtime errors and slow operations end cleanly
and leave Go live available. Loading has a five-minute limit and each inference job
has a 90-second limit. A slow connection can require another attempt.

## Local processing and privacy

- The initial preview uses only project HTML, CSS and JS. It does not request
  devices, import the AI runtime, download weights, or run inference. Gallery
  screenshots render the same inert illustration and empty chat.
- Only explicit Go live requests camera and mic. The video element is locally muted.
  Once models are ready, an AudioWorklet converts microphone samples to mono
  16 kHz PCM. It closes a voiced segment after 600 ms of quiet and caps continuous
  segments at six seconds. Acknowledgements allow at most one audio message to
  wait on the UI thread. See [the capture comparison](#utterance-endpointing).
- One dedicated module Worker runs ASR followed by language generation. There is
  one job at a time and one replaceable latest segment. The first segment goes
  through immediately. A two-second minimum between ASR job starts limits rapid
  pauses, with a timer to submit the latest pending audio once the Worker and
  cooldown are clear. Comment opportunities remain at least eight seconds apart,
  with at most 96 transcription tokens and 64 generated tokens.
  If newer audio arrives during inference, the Worker can hold one reply for
  up to two recognition segments within the original 90-second deadline.
  Silence or failed recognition clears held replies. A language change or a
  request to observe the camera also discards them. End cancels pending work.
- Transcription is supplied as quoted context to Qwen, which generates the actual
  comment; there is no canned comment roulette. Reasoning mode is disabled. A
  rolling prompt context uses at most 400 characters from three speech segments
  for 24 seconds and resets on language changes. Four viewer voices rotate between
  questions, casual reactions, preferences and noticing changes. Sampling uses
  temperature 0.7, top-p 0.9, repetition penalty 1.15 and frequency/presence
  penalties. One unrelated question/reply example establishes the conversational
  format; it is never substituted for generated output. Three recent replies
  discourage repetition.
  Both chat routes can display short reactions such as `おお！` or `なるほど`
  even when they share no words with the transcript. Output handling removes
  reasoning and control tokens, honors empty output and `SKIP`, and bounds
  plain-text comments to 110 characters. Local safeguards cover unsafe content,
  contact details, links and some claims about the live image. Camera frames stay
  in the local preview. Fictional comments can still include invented visual
  observations.
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
- Network traffic consists of static page, runtime and model requests from the site,
  jsDelivr, Hugging Face, its asset delivery hosts and a pinned model library on
  raw.githubusercontent.com. The inference Worker's fetch guard permits static asset GETs and HEAD checks for the two pinned GGUF shards. No inference API, WebSocket,
  service worker, telemetry or application-server writes are used. Asset providers
  receive ordinary download request metadata such as IP address, **never audio,
  video, transcripts, prompts or comments**. No credentials are required.
- Only runtime and model assets may persist. Transformers.js and WebLLM use
  Cache Storage, and wllama caches the frozen GGUF shards in origin-private file
  storage. Clear this site's browser storage to remove cached assets. User media, transcripts and chat are never persisted.
  The camera is never sampled by code or recorded. Current chat has a 60-row limit;
  the Worker keeps up to three recent replies for the prompt. End clears chat, terminates the
  Worker (including in-flight inference/downloads), closes AudioContext and stops
  every media track. Late permission responses are stopped immediately.

## Utterance endpointing

The AudioWorklet uses 20 ms frames, DC-corrected energy and adjacent-sample
differences to reject broadband noise. Rejected frames and frames with
noise-like sample variation update the noise floor. This lets steady filtered
noise raise the thresholds even when it initially passes the voice gate.

Onset requires three consecutive voiced frames (60 ms) above roughly 2.5 times
the noise RMS, with a minimum RMS of 0.003 in normalized PCM. During speech the
gate drops to 1.7 times the noise RMS, with a minimum of 0.002. An utterance
needs at least 120 ms of voiced frames. It starts with up to 200 ms of pre-roll
and keeps 160 ms of trailing PCM after a 600 ms pause. At the six-second cap it
splits at the quiet tail when available, or carries 160 ms of overlap into the
next segment. A continuation needs fresh voiced audio before it can be submitted.

WebRTC VAD supports 20 ms frames at 16 kHz and uses a sub-band classifier.
Kaldi's decoder endpoint rules include a 500 ms pause with high recognition
confidence and a 1000 ms pause with weaker confidence.
[WebRTC frame format](https://webrtc.googlesource.com/src/webrtc/%2B/f54860e9ef0b68e182a01edc994626d21961bc4b/common_audio/vad/include/webrtc_vad.h),
[WebRTC classifier](https://webrtc.googlesource.com/src/%2B/d3cf0476b4c7923b6c0b8d25ce85769f6686b794/webrtc/common_audio/vad/vad_core.c),
[Kaldi endpoint rules](https://kaldi-asr.org/doc/online-endpoint_8h_source.html).

The worklet uses 600 ms without a running decoder, which preserves the 380 ms
internal pause in the fixture. Energy-based detection
has a small CPU and memory footprint. Music, other speakers, and loud tonal
backgrounds can still trigger it, and speech close to the noise floor can be
missed. Shorter pauses would respond sooner at the cost of more splits and calls.

From the repository root, run the comparison against the pre-#66 Git revision
(`dbf8bde`). The replay assumes an idle ASR Worker and reports submission time
at the end of the render quantum. All times are in seconds. Each entry lists
the PCM interval, submission time, and delay since the last voiced input
in that segment. A zero delay during continuous speech marks a cut in speech.

```sh
node tests/fixtures/ai-livestream/capture.mjs --compare
```

| Synthetic input | Fixed windows | Utterance endpointing | Calls and PCM delivered, old → new |
| --- | --- | --- | --- |
| Short voice at 0.40–0.54 | No submission | 0.20–0.70 at 1.144 (+0.604) | 0 calls / 0 s → 1 / 0.50 s |
| Voice at 0.80–1.42 and 1.80–2.36 | 0–6 at 6 (+3.64) | 0.60–2.52 at 2.96 (+0.60) | 1 / 6 s → 1 / 1.92 s |
| Voice across the old boundary at 5.52–6.44, then 7.70–8.60 and 10–11 | 0–6 at 6 (+0), 6–12 at 12 (+1.00) | 5.32–6.60 at 7.04, 7.50–8.76 at 9.20, 9.80–11.16 at 11.60 (+0.60 each) | 2 / 12 s → 3 / 3.90 s |
| Continuous voice at 0.40–15.40 | 0–6 at 6 (+0), 6–12 at 12 (+0), 12–18 at 18 (+2.60) | 0.20–6.20 at 6.20 (+0), 6.04–12.04 at 12.04 (+0), 11.88–15.56 at 16 (+0.60) | 3 / 18 s → 3 / 15.68 s |
| Seeded broadband noise at 0–6.40 | 0–6 at 6 | No submission | 1 / 6 s → 0 / 0 s |

Across these patterns, the idle Worker would run ASR seven times before the
change and eight times after it. Delivered PCM fell from 42 s to 22 s. On an
arm64 Mac (Mac16,5, Node 24.22.3), a capture-only pass over 5,040 s of replayed 16 kHz input
took 698 ms of process CPU time (687 ms wall time) for fixed windows and 326 ms
(312 ms wall time) for endpointing. The worklet keeps about 391 KiB in fixed
PCM buffers. The transfer, pending slot and active job each hold at most 375 KiB
of PCM, excluding model and browser internals.

The pinned Transformers.js Whisper feature extractor pads short inputs,
so delivered PCM duration alone cannot predict ASR cost.
These measurements cover synthetic capture and submission timing. Transcription
accuracy and phone performance were unmeasured.
[Transformers.js Whisper feature extractor](https://github.com/huggingface/transformers.js/blob/3.8.1/src/models/whisper/feature_extraction_whisper.js).

## Pinned dependencies and licenses

| Asset | Exact version/revision | Download | License/source |
| --- | --- | --- | --- |
| Transformers.js, bundled browser ESM | `3.8.1` | ~0.9 MB JS | Apache-2.0; [Hugging Face](https://github.com/huggingface/transformers.js/tree/3.8.1) |
| ONNX Runtime Web, matching bundled runtime's WASM | `1.22.0-dev.20250409-89f8206ba4` | Tens of MB runtime/WASM | MIT; [Microsoft](https://github.com/microsoft/onnxruntime) |
| [Xenova/whisper-base](https://huggingface.co/Xenova/whisper-base/tree/64da57285918e20ea79ea5c88eed7197933abaa8), multilingual, q8 | `64da57285918e20ea79ea5c88eed7197933abaa8` | 76.9 MB encoder + merged decoder, plus tokenizer/config | Conversion repository Apache-2.0; [original Whisper](https://github.com/openai/whisper) MIT |
| WebLLM browser ESM | `0.2.85` | 6.6 MB JS | Apache-2.0; [MLC](https://github.com/mlc-ai/web-llm/tree/v0.2.85) |
| [Qwen3 0.6B WBD](https://huggingface.co/webbigdata/Qwen3-0.6B_WBD/tree/789a31e3011376f1c5f1ace071ba81f39ed20b5a) and [livestream adapter](./models/NOTICE.md) | `789a31e3011376f1c5f1ace071ba81f39ed20b5a`, adapter `e3866302664199c2` | 639.4 MB Q8_0 GGUF shards, 0.92 MB LoRA | Apache-2.0 |
| wllama browser ESM and WASM | `4.0.0` | 11.0 MB | MIT. [wllama](https://github.com/ngxson/wllama) |
| [mlc-ai/Qwen3-1.7B-q4f16_1-MLC](https://huggingface.co/mlc-ai/Qwen3-1.7B-q4f16_1-MLC/tree/80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc) | `80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc` | 968.0 MB weight shards + 11.4 MB tokenizer/config | [Original Qwen](https://huggingface.co/Qwen/Qwen3-1.7B), Apache-2.0 |
| MLC compiled WebGPU model library, `v0_2_84/base/Qwen3-1.7B-q4f16_1_cs1k-webgpu.wasm` | `00fe7a40e57e5e8eb9fef87526a4bf28ad5846c0` | 5.6 MB | Apache-2.0; [MLC binary libraries](https://github.com/mlc-ai/binary-mlc-llm-libs/tree/00fe7a40e57e5e8eb9fef87526a4bf28ad5846c0) |

Sizes are decimal MB, approximate, excluding browser overhead. Models are fetched
from immutable revision paths; runtime and WASM use exact jsDelivr npm versions.
The dedicated Worker loads one local text engine with a 1,536-token context,
256-token batches or prefill chunks, and thinking disabled. It sends only the
bounded messages for each reply. The static site ships the learned GGUF adapter.
The browser downloads the frozen shards and both available runtimes from pinned
sources as needed. The illustration is original CSS.

## Validation

From the repository root (Node 22+, Python 3.9+):

```sh
npm ci --prefix workers/persistent-counter
npm exec --prefix workers/persistent-counter -- playwright install chromium
node --test tests/ai-livestream.test.mjs tests/ai-livestream-audio.test.mjs
python3 -m unittest discover -s tests -v
python3 scripts/build_site.py
node --test tests/gallery.test.mjs tests/pokemon-coin-flip.test.cjs tests/walk-to-hospital.test.mjs
```

The normal suite uses fake media devices, mocked AI and synthesized audio buffers.
It checks the adapter format and default/rollback routing, seeded Japanese/English
audience trajectories, silence/decline, count caps,
reactions without chat, manual-choice independence, rolling context/voice selection,
resource cleanup, permission races/errors, unavailable GPU, failed model
downloads, pause timing, PCM bounds, silence, language/context transfer, cadence,
slow-worker and cooldown backpressure, bounded history, short
reactions on both model routes, and protocol, safety and privacy handling. It checks
video-first desktop/mobile layout, keyboard focus, reduced motion and network
inactivity. DOM checks reject removed filler copy and technical badges in every
session state, verify the single About disclosure, and check contextual loading,
capture, ended and error feedback. The gallery suite captures the inert preview
without media permissions or model downloads. CI runs these without weights or hardware.

For the opt-in bounded **real-model** test on a WebGPU-capable machine:

```sh
LOCAL_AI_SMOKE=1 node --test tests/ai-livestream-model.test.mjs
```

Set `LOCAL_AI_MODEL=baseline` to run the same smoke test with the 1.7B model.
This downloads the pinned ASR and selected text model assets and passes synthetic Japanese/English WAV fixtures
through the same ASR/generator implementation in a browser Worker. It asserts
recognition, bounded generation and plain-text output, and static asset traffic.
The smoke test uses no camera or microphone. See fixture provenance in
`tests/fixtures/ai-livestream/README.md`. This is intentionally excluded from ordinary
CI to avoid hardware requirements and repeated large downloads. `?debug=1` shows
only ephemeral numeric counters, last ASR/generation timings, seconds since the last
visible comment, and exact model/backend identity. It traces delivered audio
segments, worklet drops reported with the next segment, Worker submissions and
pending audio, ASR errors/accepted recognition, cadence/repeated
speech, generation errors, categorized output rejection, queued replies, Worker
results, UI insertion/discards and engagement ticks. A closed event vocabulary
rejects arbitrary strings. No audio, transcripts, prompts, runtime exceptions or
identifying details enter this panel, logs, telemetry or storage. End clears it.

The ordinary suite also replays the recorded 1.7B outputs and scripted bilingual
follow-ups through the issue #50 and current pipelines, without weights:

```sh
node scripts/replay_livestream_pipeline.mjs
```

`pipeline-replay.json` records the earlier acceptance counts and deterministic
small-audience trajectories. The replay command prints scheduling and delivery
counts for the current code.

See [the model comparison](./MODEL-EVALUATION.md) for concrete bilingual fixture
outputs, measured resource costs, limitations and reproduction commands.
