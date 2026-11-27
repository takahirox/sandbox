# Local Japanese quiz experiment

The Japanese three-choice quiz builds a playable round on every normal visit.
The next button also skips a round. A wrong answer invites another try, while a
correct answer moves focus to the next button. A Japanese voice appears only
when the browser offers one that runs on the device. Speech starts on request
and stops when the player advances or leaves the page.
[Play the quiz](../projects/kids-ai-quiz/index.html)

## How rounds are generated

The browser runs a small symbolic solver over relationships and number rules.
For example, the animal table can ask how a dolphin moves, where it lives, or
what covers a duck's back. Each relationship defines its own true answers and
contrasts. The solver chooses a topic and an unused subject or number problem,
preferring a different kind of problem from those played recently. It instantiates
the prompt and chooses two distinct, nonmatching options. Counting, joining
groups, removing crossed-out objects, and comparing three pictured groups use
single-digit values with bounded combinations. Each round checks for exactly
one matching choice and three distinct labels.
[Relationships](../projects/kids-ai-quiz/content.mjs) ·
[Solver and number rules](../projects/kids-ai-quiz/quiz.mjs)

The previous 320-parameter sampler already met the transfer budget, but it
only chose presentation tokens after the subject had been selected. A trained
semantic sampler would still need a verified set of facts or a checker for
its claims. Even a small general Japanese-capable model such as Qwen2.5-0.5B
ships a 491 MB 4-bit file before including a runtime. A domain-specific
constraint solver can instantiate relationships and number problems from a
small set of rules, with no training, weight download, or inference
dependencies. The bounded search fits in a browser event handler.
[Qwen publisher's model files](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/tree/main) ·
[Smith and Mateas on declarative procedural generation](https://adamsmith.as/papers/tciaig-asp4pcg.pdf)

The first round and each advance use the same synchronous path. There is no
pending generation to wait for or cancel. If the solver throws or returns a
rejected proposal, the game takes the first eligible problem and constructs
its three choices with the same rules. Both paths rotate through topics and
prefer unseen IDs. When a topic runs out of unseen questions, its least recently
played question becomes eligible again. A gallery capture requests a fixed,
inert example and leaves storage and speech untouched.

The history holds up to 256 nonpersonal question IDs in browser storage,
using roughly 2.5 KB in the sample below. If storage is unavailable or cleared,
the quiz still works using the current tab's history. Simultaneous tabs keep
their own in-memory histories and can overwrite one another's recent state.
Inference, history, and speech stay on the device. The quiz has no backend,
account, analytics, or third-party runtime. The original code and vocabulary
are available under the [MIT license](../projects/kids-ai-quiz/LICENSE.txt).

## Semantic diversity

The evaluation runs 24 seeded visits of 12 rounds each. It shares one store
across the new visits to model reloads. The baseline uses the shipped WASM
and its original reset-on-reload behavior. One ID represents one subject and
relationship or one number problem. Paraphrases, answer order, distractors,
swapped addends, pictured object substitutions, and the choice of greatest or
least for the same three quantities share an ID.

| Measure | Previous quiz | Solver | Fallback only |
| --- | ---: | ---: | ---: |
| Distinct questions possible | 49 | 242 | 242 |
| Distinct questions sampled | 48 | 183 | 179 |
| Topics sampled | 7 | 10 | 10 |
| Distinct first rounds out of 24 | 1 | 23 | 23 |
| Exact revisits over all 288 rounds | 240 (83.3%) | 105 (36.5%) | 109 (37.8%) |
| Exact repeat within the prior 12 rounds | 56 (19.4%) | 0 | 0 |
| Exact or related repeat within the prior 12 rounds | 266 (92.4%) | 77 (26.7%) | 176 (61.1%) |

A related repeat is a round that shares a group with an earlier round in the
12-round window, including across visits. The baseline has one group per
topic. The solver groups questions such as animal coats with the same
covering, sums with the same result, or rounds from a single task like color
matching. This intentionally counts some genuinely different experiences as
related and measures rule-level similarity. It is an automated proxy for
what a child might find repetitive.

| Topic | Before sampled | Solver sampled | Solver possible |
| --- | ---: | ---: | ---: |
| Animals | 6 | 28 | 37 |
| Objects and their uses | 0 | 18 | 18 |
| Everyday situations | 7 | 8 | 8 |
| Places | 0 | 8 | 8 |
| Food | 7 | 22 | 22 |
| Vehicles | 7 | 18 | 18 |
| Shapes | 7 | 16 | 16 |
| Colors | 7 | 7 | 7 |
| Counting, joining and taking away | 7 | 28 | 73 |
| Comparing quantities | 0 | 30 | 35 |

The 242 IDs comprise 134 relationship or matching targets and 108 number
problems. The fixed vocabulary, contrast sets, and single-digit limits keep the
space finite. Small topics such as colors cycle sooner. The old quiz combined
objects and routines in one topic, listed under everyday situations for the
baseline column.

| Example | Answer |
| --- | --- |
| おたまじゃくしが くらす ところは？ | いけ |
| あひるの せなかを おおうのは？ | はね |
| おうちで よむ ほんを かりるのは どこ？ | としょかん |
| とうふを つくる もとに なるのは？ | だいず |
| かどは いくつ？ with a hexagon | 6 |
| あわせて なんこ？ with groups of 1 and 3 fish | 4 |
| ばつの りんごを とると、いくつ のこる？ with 1 of 3 apples crossed out | 2 |
| いちばん すくないのは？ with groups of 2, 3 and 7 apples | 2 apples |

## Browser measurements

The loopback benchmark uses Chromium 153.0.8010.12 on Apple M4 Max with a
390×740 mobile viewport and 4× Chromium CPU throttling. Each version gets
32 fresh browser contexts with seven advances each. Startup measures
navigation to three enabled choices. Advance measures the click handler
through generation and DOM update, including the previous worker startup and
WASM load on its first advance. Figures use median and p95 in milliseconds.

| Measure | Previous quiz | Solver |
| --- | ---: | ---: |
| Startup assets, raw / gzip bytes | 28,184 / 10,558 | 30,187 / 11,392 |
| First-advance assets, raw / gzip bytes | 2,188 / 1,611 | 0 |
| Time to first playable round, median / p95 | 36.7 / 40.3 ms | 37.3 / 41.4 ms |
| First advance, median / p95 | 18.6 / 22.3 ms | 3.8 / 7.3 ms |
| Warm advance, median / p95 | 18.0 / 21.2 ms | 2.3 / 6.4 ms |
| Main JavaScript heap after GC, median / p95 | 1,978,952 / 1,986,976 B | 2,056,812 / 2,058,652 B |
| WASM linear memory | 65,536 B | 0 |

The larger ruleset adds 834 gzip bytes at startup and saves 777 gzip bytes
over the first two rounds combined. The median main JavaScript heap rises by
about 76 KiB while the separate WASM allocation goes away.

Static transfer counts HTML, CSS, JavaScript, and any fetched worker or
model files. Gzip sums files individually and excludes HTTP headers. Main
JavaScript heap is Chromium's post-GC used heap after seven advances. The
previous worker's JavaScript heap and browser process memory are outside that
measurement, so the main-heap comparison describes only the page. Physical
Pixel 7a performance and a child's subjective playtest remain optional
follow-up. Loopback timings exclude real network conditions and phone
battery behavior.

## Reproduce and verify

The evaluation reads the previous project from Git revision
`1d8075bbea02d3acf4191f2c33684a743cd5f295` in a temporary directory. Omit
`--browser` for the seeded content sample alone. For the browser benchmark,
use the repository's pinned Playwright and Chromium. The original model
training recipe is available at that revision.
[Evaluation script](../scripts/kids-ai-quiz/evaluate.mjs)

```sh
npm ci --prefix workers/persistent-counter
npm exec --prefix workers/persistent-counter -- playwright install chromium
node scripts/kids-ai-quiz/evaluate.mjs --browser
node --test tests/kids-ai-quiz.test.mjs tests/kids-ai-quiz-browser.test.mjs
python3 scripts/build_site.py
```

The tests check every plan against the declared contrasts or independent
arithmetic, and spot-check each relationship using a separate answer rubric.
Browser checks cover seeded fresh visits and reloads, gallery isolation,
portrait and landscape touch targets, keyboard and focus behavior, fallback
on the same click, and opt-in speech cancellation. After merge, verify the
Pages deployment and the published project link.
