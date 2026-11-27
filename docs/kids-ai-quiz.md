# Local Japanese quiz experiment

The quiz generates its first question and later rounds on the device. Each round
has three large choices, a retry after a wrong answer, and a next button that
also skips. Read-aloud starts on request when a local Japanese voice is
available. Advancing or leaving the page stops speech. The gallery uses a
fixed, inert example without starting the worker or accessing storage or speech.
[Play the quiz](../projects/kids-ai-quiz/index.html)

## Model and training

The model is a 113,533-parameter, decoder-only GRU language model with a
48-wide embedding, a 96-wide recurrent state, and 493 space-delimited word
and phrase tokens. Starting from a single start token, it samples a topic,
clue, Japanese prompt, correct answer and two distractors in sequence. A clue
can describe three objects in order, pictured quantities, or consecutive
numbers. The model can choose an object type to count in a mixed picture
and refer to generated positions in its answers. Sampling uses
temperature 0.85 and drops tokens below 3% of the
peak weight. The previous 320-parameter WASM model sampled presentation
choices after the application supplied the question's fact.
[GRU architecture](https://aclanthology.org/D14-1179/) ·
[Inference implementation](../projects/kids-ai-quiz/model.mjs)

We chose a small recurrent model with a fixed-size state and scalar CPU
inference to keep the static app dependency-free. For scale, the Q4_K_M
weights for the Japanese-capable general-purpose Qwen2.5-0.5B Instruct
alone are 491 MB. This quiz uses a narrow vocabulary and a 130,372-byte
binary. It learns from an offline procedural teacher with locally authored
contrasts, Japanese prompts, and pictured tasks. The teacher produced 18,200
examples, 9,996 unique. It draws 1,400 per topic across 12 topics and adds
1,400 mixed-picture questions to counting. For those questions the teacher
holds out selected pairs of counts for all object names and both group
orders. Other holdouts cover selected addition, subtraction, comparison,
position and sequence instances.
[Qwen publisher's model files](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/tree/main) ·
[Teacher and holdouts](../scripts/kids-ai-quiz/dataset.mjs)

Training starts from seed 68 and uses next-token cross-entropy, AdamW with
learning rate 0.003, and 3,200 batches of 96 rows. The CPU run took 16.8 seconds
on an Apple M4 Max using Python 3.13 and PyTorch 2.9.1. First and last
minibatch losses were 6.199 and 0.699. The export uses row-wise symmetric
int8 weights with float32 scales and biases. The worker expands the rows
once for inference. The source data, training code and weights use the
project's MIT license. Training uses original project data and generated
examples. PyTorch is a training dependency only.
[Training code](../scripts/kids-ai-quiz/train.py) ·
[Project license](../projects/kids-ai-quiz/LICENSE.txt)

```sh
python3.13 -m venv /tmp/kids-quiz-train
/tmp/kids-quiz-train/bin/python -m pip install torch==2.9.1
/tmp/kids-quiz-train/bin/python scripts/kids-ai-quiz/train.py
shasum -a 256 projects/kids-ai-quiz/quiz-gru-v1.bin
```

The shipped SHA-256 is
`7c90470b5e5466de4798f8bcb5e8b41f66ec22b40a0e1028f75e80a81c6c0e66`.
A second CPU run on the same setup reproduced the artifact byte for byte.
Floating-point results can vary across training platforms.

## Verification and recovery

The worker checks hiragana-centered text, three distinct answer labels and
one supported answer before rendering. For factual questions it recognizes
the relationship in the prompt, then looks up the subject and checks the
choices against the corresponding contrast. For picture puzzles it reads
the requested operation and checks the model's quantities, objects or
sequence. A mixed picture can use any two distinct known object types and
positive quantities totaling at most nine. The check counts the requested
type from that picture and verifies the model's answer. The topic label
helps rotate topics. The harness shuffles the three generated choices and
renders the question and picture.
[Semantic checks](../projects/kids-ai-quiz/verify.mjs)

The worker has up to 20 attempts of 56 tokens each per round and a
1.5-second deadline covering load and generation. It prepares at most one
future round off the main thread. Invalid or recent duplicate proposals
are skipped. A startup timeout serves playable fallback at the deadline
and permits one fresh worker attempt in the background. Children can keep
playing fallback while that attempt is pending. A verified result can be
used on a later advance. A second timeout, a generation timeout after the
worker is ready, or a worker failure keeps that visit on fallback. The
fallback has 242 curated targets and single-digit puzzle instances across
ten topics. Leaving the page terminates the worker. A back-forward cache
restore can start a fresh worker.
[Candidate selection](../projects/kids-ai-quiz/generate.mjs) ·
[Fallback](../projects/kids-ai-quiz/quiz.mjs)

The model history keeps up to 160 recent nonpersonal content identifiers in
local storage. The fallback uses its own bounded history. With storage
blocked, recency still works in the tab until navigation. Concurrent tabs
keep independent in-memory histories and can replace the saved list. Inference
and read-aloud run locally. The only inference download is the same-origin
static model and its runtime, with no account, telemetry, or backend inference.
The DOM's `data-source` attribute identifies the path for testing.

## Diversity and integrity

The comparison uses 24 seeded visits of 12 rounds for each column. The
original loads the 49-anchor implementation and its actual WASM artifact
from Git. Reload tests preserve on-device history, and fresh sessions start
with an empty one. Each target is one relationship and subject, number
problem, or position and target item. The counts collapse paraphrases,
answer permutations, swapped addends, picture substitutions in number
puzzles, and the two directions for the same three compared quantities.
For counting one kind of object, the instance is the requested count and
the other count, regardless of object names or left-to-right order.

| Measure | Original 49 anchors | Trained model, reloads | Trained model, fresh sessions | Fallback alone, reloads |
| --- | ---: | ---: | ---: | ---: |
| Distinct targets in 288 rounds | 48 | 231 | 164 | 183 |
| Topics sampled | 7 | 12 | 12 | 10 |
| Distinct first rounds in 24 visits | 1 | 24 | 24 | 23 |
| Exact revisits in 288 rounds | 240 (83.3%) | 57 (19.8%) | 124 (43.1%) | 105 (36.5%) |
| Exact repeats in the preceding six rounds | 9 (3.1%) | 0 | 2 (0.7%) | 0 |
| Same relationship or task in the preceding six rounds, including exact repeats | 112 (38.9%) | 32 (11.1%) | 36 (12.5%) | 38 (13.2%) |
| Rounds served by the symbolic fallback | — | 0 | 0 | 288 |

All columns count a near repeat when a round asks about the same
relationship or uses the same reasoning task as any of the previous six.
Any two addition rounds count, as do two questions about animal sounds.
Animal sounds and number of legs count as different relationships. The
evaluator classifies the original facts by their displayed clues using
the same families, and the window crosses visit boundaries in every
column. This is a proxy for perceived repetition.

Across the reload sample, the trained model covered animals (33 distinct
targets), objects (19), vehicles (17), everyday situations (13), food (20),
places (12), shapes (15), colors (7), counting and arithmetic (33), quantity
comparison (18), number sequences (17) and position (27). This includes 11
distinct tasks asking the child to count one kind of object and 20 position
scenes whose ordered picture triples were absent from training. The reload
sample included a held-out position target and a held-out comparison. The
fresh-session sample included a held-out mix of four requested objects and
five other objects. The browser test independently verified a held-out
mix of five pencils and two stars generated from the shipped weights.

The integrity audit checked the first two distinct generated rounds per
topic from the reload sample, two fallback rounds per topic, and the four
reported held-out rounds including the browser test. Each of the 48 had
one defensible answer among its displayed choices. The Japanese uses
short hiragana-centered instructions. Terms such as `ごかくけい` and
number sequences that step by two may be harder for some five-year-olds.
The evaluator rejected 162 of 1,000 raw proposals, compared with 48 of
1,000 in the first trained version. Counting and arithmetic accounted
for 116 rejections in 171 draws. Tests cover wrong sums, a wrong count of
one kind of object, an inconsistent sequence, duplicate choices and a
factual option outside its checked contrast.

| Source | Japanese prompt | Displayed choices | Answer |
| --- | --- | --- | --- |
| Model | いるかは どうやって すすむ？ | つばさで とぶ / からだを くねらせて はう / ひれで およぐ | ひれで およぐ |
| Model | おなじ ぶんずつ ふえるよ。つぎの かずは？ (0, 2, 4) | 8 / 0 / 6 | 6 |
| Model, held out | まんなかは どれ？ (☂️, 🚗, ⭐) | くるま / ほし / かさ | くるま |
| Model, held out | いちばん すくないのは？ (three pictured groups) | ほしが 1こ / ほしが 4こ / ほしが 3こ | ほしが 1こ |
| Model, held out | ふね は いくつ ある？ (4 boats, 5 pencils) | 8 / 0 / 4 | 4 |
| Browser model, held out | えんぴつ は いくつ ある？ (5 pencils, 2 stars) | 9 / 0 / 5 | 5 |
| Fallback | かどは いくつ？ (hexagon) | 3 / 0 / 6 | 6 |
| Fallback | おうちで よむ ほんを かりるのは どこ？ | ぱんやさん / えき / としょかん | としょかん |

Factual coverage is limited to 169 supported targets. The single-digit
bounds and the target counting rules give a ceiling of 396 targets,
including 36 mixed-count pairs. Some supported instances may be rare or
unreachable at the chosen sampling settings. Evidence of extrapolation
covers the reported holdouts and novel position scenes. Small topics can
recur as the recent history fills. A child's subjective experience is unmeasured.

## Browser measurements

Chromium 153.0.8010.12 on Apple M4 Max with Node 24.22.3 serving assets
over loopback, a 390×740 mobile viewport and 4× CPU throttling on the page
target. Each version used 24 fresh contexts and seven advances per context.
Startup ends when three enabled choices appear. Advance measures the click
to the updated playable round.
Worker turnaround includes message scheduling and on the cold request
includes worker initialization and the weight fetch. Decode measures the
new worker's sampling and checks. Times are median / p95.

| Measure | Original WASM quiz | Trained GRU quiz |
| --- | ---: | ---: |
| Startup assets, raw / gzip bytes | 28,184 / 10,558 | 184,928 / 140,898 |
| Later assets, raw / gzip bytes | 2,188 / 1,611 | 0 / 0 |
| First playable round | 35.7 / 39.6 ms | 75.9 / 82.3 ms |
| First advance | 18.4 / 22.2 ms | 3.0 / 44.6 ms |
| Warm advance | 17.9 / 21.1 ms | 2.4 / 43.6 ms |
| First worker turnaround | 15.2 / 16.9 ms | 38.6 / 41.6 ms |
| Warm worker turnaround | 15.4 / 17.2 ms | 12.3 / 15.2 ms |
| Worker decode and verification | — | 1.7 / 5.4 ms |
| Page JavaScript heap after GC | 1,983,752 / 1,991,356 B | 2,090,856 / 2,092,056 B |
| Resident model numeric buffers | 65,536 B WASM linear memory | 458,792 B typed arrays |

Transfer totals sum the static files and their individual gzip sizes,
excluding headers. The model adds a cold download and roughly doubles
local startup. Pre-generation shortens typical advances. The p95 for both
first and later advances is higher with the trained model. All 192 measured
rounds of the new version came from the model. The page heap and numeric
buffers are separate measurements. Worker JavaScript heap, transient loading
buffers, browser process memory, network latency and battery impact are
outside these figures. Physical Pixel 7a performance is unmeasured.

## Reproduce and verify

```sh
npm ci --prefix workers/persistent-counter
npm exec --prefix workers/persistent-counter -- playwright install chromium
node scripts/kids-ai-quiz/evaluate.mjs --browser
node --test tests/kids-ai-quiz.test.mjs tests/kids-ai-quiz-browser.test.mjs
python3 scripts/build_site.py
```

Omit `--browser` to run the seeded content sample alone. The comparison
requires original revision `1d8075bbea02d3acf4191f2c33684a743cd5f295` in Git
history. Browser tests exercise the actual weight file on fresh visits,
reloads and advances, including selective counting with held-out quantities.
They also exercise gallery isolation, touch, keyboard, speech cancellation,
worker failure, startup retry and its limit, and page restoration. The deployment
and live project link can be verified after merge.
[Evaluation script](../scripts/kids-ai-quiz/evaluate.mjs)

The historical symbolic evaluation is in the parent history at
`git show 764ffca:docs/kids-ai-quiz.md`.
