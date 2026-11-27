# Local Japanese quiz experiment

The quiz generates its first question and later rounds on the device. Each round
has three large choices, a retry after a wrong answer, and a next button that
also skips. Read-aloud starts on request when a local Japanese voice is
available. Advancing or leaving the page stops speech. The gallery uses a
fixed, inert example without starting the worker or accessing storage or speech.
[Play the quiz](../projects/kids-ai-quiz/index.html)

## Model and training

The model is a 113,388-parameter, decoder-only GRU language model with a
48-wide embedding, a 96-wide recurrent state, and 492 space-delimited word
and phrase tokens. Starting from a single start token, it samples a topic,
clue, Japanese prompt, correct answer and two distractors in sequence. A clue
can describe three objects in order, pictured quantities, or consecutive
numbers. The model can refer to its own generated picture positions in
answers. Sampling uses temperature 0.85 and drops tokens below 3% of the
peak weight. The previous 320-parameter WASM model sampled presentation
choices after the application supplied the question's fact.
[GRU architecture](https://aclanthology.org/D14-1179/) ·
[Inference implementation](../projects/kids-ai-quiz/model.mjs)

We chose a small recurrent model with a fixed-size state and scalar CPU
inference to keep the static app dependency-free. For scale, the Q4_K_M
weights for the Japanese-capable general-purpose Qwen2.5-0.5B Instruct
alone are 491 MB. This quiz uses a narrow vocabulary and a 130,210-byte
binary. It learns from an offline procedural teacher with locally authored
contrasts, Japanese prompts, and pictured tasks. The teacher produced 16,800
examples, 8,619 unique, with equal counts for 12 topics. The corpus excludes
selected instances of addition, subtraction, comparing, position and sequence
tasks for reproducible novelty checks.
[Qwen publisher's model files](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/tree/main) ·
[Teacher and holdouts](../scripts/kids-ai-quiz/dataset.mjs)

Training starts from seed 68 and uses next-token cross-entropy, AdamW with
learning rate 0.003, and 3,200 batches of 96 rows. The CPU run took 17 seconds
on an Apple M4 Max using Python 3.13 and PyTorch 2.9.1. First and last
minibatch losses were 6.205 and 0.682. The export uses row-wise symmetric
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
`c9efdcbc670df2bb83b169661ac5a3349f9b986be7b62eab6836d20364a00b9f`.
A second CPU run on the same setup reproduced the artifact byte for byte.
Floating-point results can vary across training platforms.

## Verification and recovery

The worker checks hiragana-centered text, three distinct answer labels and
one supported answer before rendering. Factual prompts use checked
contrasts. Pictured puzzles use the model's own operands, groups, items or
sequence and an independent arithmetic or position check. The topic label
helps rotate topics, while the clue and prompt determine which checks apply.
The harness shuffles the three generated answers and renders the text and
illustration.
[Semantic checks](../projects/kids-ai-quiz/verify.mjs)

The worker has up to 20 attempts of 56 tokens each per round and a
1.5-second deadline covering load and generation. It prepares at most one
future round off the main thread. Invalid or recent duplicate proposals
are skipped. When the model times out, is unavailable, or runs out of
valid fresh proposals, the quiz can use the checkpoint's symbolic
generator. The fallback has 242 curated targets and single-digit puzzle
instances across ten topics. Leaving the page terminates the worker. A
back-forward cache restore can start a fresh worker.
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

| Measure | Original 49 anchors | Trained model, reloads | Trained model, fresh sessions | Fallback alone, reloads |
| --- | ---: | ---: | ---: | ---: |
| Distinct targets in 288 rounds | 48 | 215 | 152 | 183 |
| Topics sampled | 7 | 12 | 12 | 10 |
| Distinct first rounds in 24 visits | 1 | 24 | 22 | 23 |
| Exact revisits in 288 rounds | 240 (83.3%) | 73 (25.3%) | 136 (47.2%) | 105 (36.5%) |
| Exact repeats in the preceding six rounds | 9 (3.1%) | 1 (0.3%) | 4 (1.4%) | 0 |
| Exact or same-group repeats in the preceding six rounds | 136 (47.2%) | 3 (1.0%) | 18 (6.3%) | 22 (7.6%) |
| Rounds served by the symbolic fallback | — | 0 | 0 | 288 |

Same-group repeats include similar problems such as two sums yielding
the same result, two rounds asking for the leftmost item, or two
questions about the same animal covering. The original has one group per
topic. The six-round test window crosses visit boundaries even in the
empty-history sample. It measures overlap using these labels as a proxy for
what feels repetitive.

Across the reload sample, the trained model covered animals (25 distinct
targets), objects (20), vehicles (19), everyday situations (13), food (19),
places (13), shapes (16), colors (7), counting and arithmetic (20), quantity
comparison (25), number sequences (18) and position (20). It produced 16
position scenes whose ordered picture triples were absent from training. One
leftmost-item target was also held out independently of the other pictured
items. The fresh-session sample contained a held-out quantity comparison.
Scenes with the same position and target were collapsed in the diversity
counts.

The integrity audit checked the first two distinct generated rounds per
topic and both holdouts, plus two fallback rounds per topic. This included
checking each displayed distractor against the prompt or pictured
evidence and reading the Japanese for age-appropriate vocabulary and
instructions. All 46 had one defensible answer. A few terms, such as
`ごかくけい` and `かいちゅうでんとう`, and stepping by two can be harder for
some five-year-olds. The evaluator separately found 48 rejected proposals
out of 1,000 raw draws before retries. Counting and arithmetic had the
highest rejection rate in this sample, at 10 of 42 draws. Examples of
rejections covered by tests include a wrong sum, an inconsistent sequence,
duplicate choices and a factual option outside its checked contrast.

| Source | Japanese prompt | Displayed choices | Answer |
| --- | --- | --- | --- |
| Model | しろと くろの けんばんを おすのは どれ？ | すず / ふえ / ぴあの | ぴあの |
| Model | うしの あしは なんぼん？ | 4 / 2 / 8 | 4 |
| Model | うんどうぐつを かうのは どこ？ | さかなやさん / くつやさん / はなやさん | くつやさん |
| Model | おなじ ぶんずつ ふえるよ。つぎの かずは？ (0, 2, 4) | 6 / 1 / 4 | 6 |
| Model, held out | いちばん ひだりに あるのは？ (📕, ⛵, 🍌) | ふね / ほん / ばなな | ほん |
| Model, held out | いちばん すくないのは？ (three pictured groups) | ばななが 3こ / ばななが 4こ / ばななが 1こ | ばななが 1こ |
| Fallback | かどは いくつ？ (hexagon) | 3 / 0 / 6 | 6 |
| Fallback | おうちで よむ ほんを かりるのは どこ？ | ぱんやさん / えき / としょかん | としょかん |

Factual coverage is limited to 169 supported targets. The single-digit
bounds and the position target normalization give a ceiling of 360 distinct
targets under the counting rules above. Some supported instances may be rare
or unreachable at the chosen sampling settings. The spot check covers 46
rounds. Evidence of extrapolation is limited to the two reported holdouts
and the novel position scenes. Small matching topics can recur as the
recent history fills. A child's subjective experience is unmeasured.

## Browser measurements

Chromium 153.0.8010.12 on Apple M4 Max, using loopback, a 390×740 mobile
viewport and 4× CPU throttling on the page target. Each version used 24 fresh
contexts and seven advances per context. Startup ends when three enabled
choices appear. Advance measures the click to the updated playable round.
Worker turnaround includes message scheduling and on the cold request
includes worker initialization and the weight fetch. Decode measures the
new worker's sampling and checks. Times are median / p95.

| Measure | Original WASM quiz | Trained GRU quiz |
| --- | ---: | ---: |
| Startup assets, raw / gzip bytes | 28,184 / 10,512 | 182,975 / 140,229 |
| Later assets, raw / gzip bytes | 2,188 / 1,603 | 0 / 0 |
| First playable round | 35.2 / 44.9 ms | 72.0 / 83.8 ms |
| First advance | 18.9 / 23.2 ms | 4.0 / 42.2 ms |
| Warm advance | 18.0 / 21.3 ms | 2.3 / 7.0 ms |
| First worker turnaround | 15.0 / 16.5 ms | 36.6 / 42.9 ms |
| Warm worker turnaround | 15.6 / 16.6 ms | 12.9 / 14.8 ms |
| Worker decode and verification | — | 1.6 / 3.8 ms |
| Page JavaScript heap after GC | 1,983,820 / 1,992,068 B | 2,086,324 / 2,089,364 B |
| Resident model numeric buffers | 65,536 B WASM linear memory | 458,208 B typed arrays |

Transfer totals sum the static files and their individual gzip sizes,
excluding headers. The model adds a cold download and roughly doubles
local startup. Pre-generation shortens typical advances. Its occasional
late first result shows up in the p95. All 192 measured rounds of the new
version came from the model. On the built site with seed 68, the worker
produced a flashlight question on load, a fire-engine question on advance,
and a shape-matching question on reload. The page heap and numeric buffers are
separate measurements. Worker JavaScript heap, transient loading buffers,
browser process memory, network latency and battery impact are outside
these figures. Physical Pixel 7a performance is unmeasured.

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
reloads and advances, as well as gallery isolation, touch, keyboard, speech
cancellation, model failure, timeout, and page restoration. The deployment
and live project link can be verified after merge.
[Evaluation script](../scripts/kids-ai-quiz/evaluate.mjs)

The historical symbolic evaluation is in the parent history at
`git show 764ffca:docs/kids-ai-quiz.md`.
