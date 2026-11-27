# Local Japanese quiz experiment

[さんたく くいず](../projects/kids-ai-quiz/index.html) opens with a playable
question. Each press of 「つぎへ」 picks a fresh fact and asks a browser-local
model to sample three candidate rounds, each with a phrasing and three choices.
The first proposal that passes validation is used. If the model is unavailable,
too slow, or returns three rejected proposals, the game makes a vetted round
for the same fact. Players can skip a question or stop waiting at any time.

The game has seven topics and 49 anchors. Every anchor appears once before the
next cycle, with no consecutive questions from the same topic and a gap between
reuses of each anchor. Each anchor supports three approved phrasings and up to
60 arrangements of plausible choices. The knowledge base limits what the model
can ask about. Speech is opt-in, with a Japanese on-device voice when available.
The text, pictures, and accessible clue descriptions are available without speech.

## Model selection

| Approach considered | Japanese and browser implications |
| --- | --- |
| Qwen2.5-0.5B-Instruct | Apache-2.0, 490 million parameters and Japanese support. The publisher’s 4-bit Q4_K_M GGUF alone is 491 MB. Local adaptation would still need a compatible browser runtime and that order of download and memory. [Model card](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) · [Published GGUF](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/main/qwen2.5-0.5b-instruct-q4_k_m.gguf) |
| Sarashina2.2-0.5B-Instruct | MIT, Japanese-focused, with an ONNX conversion for Transformers.js. Its published q4 ONNX file is 939 MB. Transformers.js supports CPU/WASM and WebGPU depending on the model and runtime. [Publisher’s model](https://huggingface.co/sbintuitions/sarashina2.2-0.5b-instruct-v0.1) · [ONNX files](https://huggingface.co/onnx-community/sarashina2.2-0.5b-instruct-v0.1-ONNX/tree/main/onnx) · [Transformers.js documentation](https://huggingface.co/docs/transformers.js/index) |
| Conditional log-linear token model | 320 learned parameters. It learns preferences for Japanese phrasing and distractors from a small original corpus. The game renders tokens using a curated vocabulary. The exported model runs on the CPU in a dedicated WebAssembly worker. [WebAssembly specification](https://www.w3.org/TR/wasm-core/) |

The first two options would provide open-ended Japanese generation. Their
published download sizes and adaptation costs ruled them out for this experiment
before any weights were fetched or phone performance measured. The chosen
architecture allows local training, a small static asset, and a finite output
grammar that the game can check exhaustively.

## Training and verification

The [dataset recipe](../scripts/kids-ai-quiz/dataset.mjs) expands original
Japanese wording, everyday facts, and semantic groups from the
[content catalog](../projects/kids-ai-quiz/content.mjs). The dataset uses synthetic
combinations of these hand-authored materials. No third-party corpora, weights,
private data, or child interactions enter training. Emoji are native text
glyphs. The original quiz code, catalog, recipes, and weights are released
under the [MIT license](../projects/kids-ai-quiz/LICENSE.txt).

The same model is trained on 1,260 general quiz examples and then adapted on
1,260 child quiz examples. The general examples favor conventional written
Japanese and mix close and easy distractors. Child examples favor short
hiragana, nearby distractors, and balanced positions for the answer. The recipe
checks that child targets pass the quiz validator and that all 5,040 corrupted
examples fail it. These corruptions include repeated choices, a duplicate
answer, choices from other topics, and longer text with kanji.

The model samples four categorical tokens in order from learned softmax
distributions. They select a wording, two distractor ranks from a fact-specific
pool, and the position of the correct answer. Distributions are conditioned on
topic and, for the second distractor, on the first. Training uses supervised
cross-entropy, with an added unlikelihood loss for rejected tokens during
adaptation. The shipped artifact includes the float32 coefficients and sampler.

The verifier independently checks the token shape, allowlisted wording, three
distinct choices, topic membership, and one occurrence of the known answer in
its expected position. Matching and counting questions use explicit visual
targets. The model cannot introduce free text or assert a fact outside the
catalog. Coverage of age suitability and semantics depends on the quality of
the catalog. The language and relevance scores below are automated proxies
alongside catalog review. They do not measure a child’s comprehension.

## Reproduce the experiment

The recorded run used CPython 3.13.13, Node.js 26.12.1 and
[WABT 1.0.39](https://github.com/WebAssembly/wabt/releases/tag/1.0.39).
Training uses the Python and Node standard libraries plus `wat2wasm`.
The evaluation rebuilds both stages in a temporary directory, verifies the
shipped artifact byte for byte, and prints metrics and raw examples.

```sh
python3 scripts/kids-ai-quiz/train.py
node scripts/kids-ai-quiz/evaluate.mjs
node --test tests/kids-ai-quiz.test.mjs tests/kids-ai-quiz-browser.test.mjs
```

Version 1 is `quiz-model-v1.wasm`, SHA-256
`3efa6dbe704187193e8ec04edffe6868510101a5b52f0e1fab031027ef78fe4f`.
The local CPU training and export took 0.52 seconds in a timed run.
Training files live outside the static project.

## Held-out results

Two anchors per topic were withheld as question targets from both stages.
The split shares the seven topics and phrasing vocabulary with training.
A held-out label can appear as a distractor in another example. The model
receives rank and topic tokens, so it never learns the held-out label or clue
text. The evaluation checks 60 rounds per held-out anchor with three proposals
each, under identical seeds and conditions, against a separately written
Japanese answer key.

| Measure | General baseline | Child-adapted v1 |
| --- | ---: | ---: |
| Structured four-token proposals | 2,520 / 2,520 | 2,520 / 2,520 |
| Three distinct choices and exactly one correct answer | 2,388 / 2,520 | 2,489 / 2,520 |
| Short hiragana-centered language | 1,034 / 2,520 | 2,506 / 2,520 |
| All choices relevant to the topic | 1,528 / 2,520 | 2,497 / 2,520 |
| Proposals passing every check | 595 / 2,520 | 2,452 / 2,520 |
| Rounds with an accepted proposal within three draws | 477 / 840 | 840 / 840 |
| Mean distinct accepted distractor pairs per anchor | 9.86 / 10 | 10 / 10 |
| Accepted pair seen among the last four for that anchor | 204 / 595 | 937 / 2,452 |
| Model transfer size before HTTP compression | 1,554 bytes | 1,554 bytes |
| Fixed WASM linear memory | 64 KiB | 64 KiB |
| Warm sampling per proposal, median and p95 | 0.625 / 0.834 µs | 0.625 / 0.791 µs |

The timings above are from Node.js on an Apple M4 Max. They measure the
four-token sampler and exclude UI, worker startup, and network. In a separate
Chromium 153 run with a 390×740 viewport and 4× CPU throttling, the first
request through the real worker returned in 13.1 ms and the next three in
15.2–16.7 ms on loopback.
The worker benchmark includes the first model fetch and initialization. Neither
measurement establishes runtime, memory pressure, or battery use on a Pixel 7a.

For 「にゃあにゃあ なくのは？」, the adapted model proposed 「ねこ」「いぬ」
「ひつじ」 and passed. The baseline once proposed 「ねこ」「いぬ」「ひこうき」,
which failed relevance. The adapted model sometimes repeated 「あひる」 as
both distractors, used kanji in 「鳴き声」, or offered 「ぴんく」 as a decoy in
a corn question. All were rejected. Adaptation increased coverage but also
slightly increased the rate of repeated pairs when repeatedly drawing from
the same anchor. Across 490 simulated game rounds, topic rotation produced
zero consecutive same-topic rounds and zero repeats of an anchor within the
previous 12 rounds.

## Browser limits and validation

The first paint and gallery capture use only game assets, with no worker
creation or model fetch. The first advance fetches the 1,554-byte WASM asset
from the same origin. One worker retains the instantiated model for later
rounds in the tab, and a restart uses ordinary HTTP caching for the versioned
URL when available. The loader caps the asset at 4 KiB, requests run one at a
time, and each round has a 1.5-second deadline covering load and inference.
The 64 KiB model linear-memory figure excludes JavaScript, the worker, and
browser overhead. The game uses no backend, telemetry, or browser storage.

Browser tests exercise real WASM inference, cold preview, mobile touch and
keyboard, reduced motion, optional speech, cancellation, and error recovery.
The normal Pages build discovers the project and captures its first round.
After merge, Pages deployment and the published project link remain to be
verified. Physical Pixel 7a playtesting is follow-up.
