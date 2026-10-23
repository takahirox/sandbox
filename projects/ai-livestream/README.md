# AI Livestream

A static, private livestream **simulation** for [sandbox issue #46](https://github.com/takahirox/sandbox/issues/46).
Open `index.html` through HTTPS or a localhost HTTP server, choose Japanese or English,
and press **Go live**. Allow a camera and microphone. After the first model download,
speak normally; an occasional fictional viewer comment responds to recent speech.
**End** releases both devices. Switching tabs or leaving the page also ends the session.
The unobtrusive **About** menu explains the simulation, local reactions, permissions,
and initial model download. The player shows **Camera & mic on** whenever capture
is active, including during loading; no real broadcast or audience is claimed.
Likes and subscriptions are temporary local button states. There is no audience,
account, upload, stream, analytics, or backend.

## Compatibility and performance

Use a current desktop Chrome or Edge with WebGPU, `shader-f16`, AudioWorklet,
and camera/microphone access enabled. Other browsers/devices may work when they
provide these APIs. The app checks GPU support before asking for media or loading
models. Unsupported devices get a retryable message, never a remote API fallback.
Speech uses single-threaded WebAssembly; chat requires WebGPU. A CPU-only language
model fallback is deliberately omitted because its latency would make this demo
unusable on many devices. Mobile layout is supported; mobile inference depends
on the device and available GPU memory.

Expect about **680 MB** on first use, plus temporary inference memory (allow roughly
1–2 GB of free memory). Actual speed and memory depend on GPU, CPU, browser and
device. Japanese recognition with Base can miss words, particularly with noise,
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
  one job at a time, no pending inference queue, at least ten seconds between
  submitted windows and generation attempts, at most 96 transcription tokens and
  64 generated tokens. Audio arriving while busy/loading is discarded. This bounds
  resources and prioritizes recent speech over backlog. Silence produces no job
  or filler chat. Recognizer errors/hallucinations remain possible.
- Transcription is supplied as quoted context to Qwen, which generates the actual
  comment; there is no canned comment roulette. Qwen's reasoning mode is disabled.
  Prompting asks for safe, short,
  topical comments. Local filtering rejects common inappropriate words, URLs,
  multiline/long output, caption boilerplate and recent duplicates. A local word
  overlap check suppresses comments with no topic word from the speech. This is
  conservative and can also suppress valid paraphrases. Greedy decoding favors
  coherence; variation comes from the changing speech context. These small
  models and guardrails are imperfect; comments are fictional, not genuine opinions
  or a moderation guarantee. Odd wording and incorrect details remain possible;
  word overlap is not a fact checker. They cannot see the video.
- Network traffic consists of static page/runtime/model GETs from the site,
  jsDelivr, Hugging Face, and Hugging Face's asset delivery hosts. The inference
  Worker's fetch guard permits only GET asset requests. No inference API, WebSocket,
  service worker, telemetry or application-server writes are used. Asset providers
  receive ordinary download request metadata such as IP address, **never audio,
  video, transcripts, prompts or comments**. No credentials are required.
- Only runtime/model assets may persist in ordinary HTTP/Cache Storage caches
  (Transformers.js uses `transformers-cache`). Clear this site's browser storage
  to remove model cache. User media, transcripts and chat are never persisted.
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
| [onnx-community/Qwen3-0.6B-ONNX](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/tree/58ca03a5e7b354b480b1a82b34bde8dc7b854cc0), q4f16 | `58ca03a5e7b354b480b1a82b34bde8dc7b854cc0` | 569.8 MB weights, plus tokenizer/config | [Original Qwen license](https://huggingface.co/Qwen/Qwen3-0.6B/blob/main/LICENSE), Apache-2.0; ONNX conversion linked by model card |

Sizes are decimal MB, approximate, excluding browser overhead. Models are fetched
from immutable revision paths; runtime and WASM use exact jsDelivr npm versions.
No model files or third-party runtime code are vendored in this project. See
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
It checks resource cleanup, permission races/errors, unavailable GPU, failed model
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

This downloads the pinned assets and passes synthetic Japanese/English WAV fixtures
through the same ASR/generator implementation in a browser Worker. It asserts
recognized topics, short topical generated comments, and GET-only asset traffic;
it never requests real camera/mic access. See fixture provenance in
`tests/fixtures/ai-livestream/README.md`. This is intentionally excluded from ordinary
CI to avoid hardware requirements and repeated large downloads. `?debug=1` shows
only Worker state/audio rate, not speech or model exception content.
