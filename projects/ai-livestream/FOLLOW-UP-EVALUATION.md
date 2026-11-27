# Livestream comment tuning follow-up

This follow-up to [Issue #62] and the [owner update] tests one continuation
of the task-tuned Qwen3 WBD 0.6B adapter. The previous evaluation showed
unsupported details even from clean Japanese, including `安い練習で安定するんだね`
when the speaker was struggling to hold a low flute note, and no questions
among the displayed transcript replies. Those observations motivated
grounded question and reaction supervision. The original Japanese curious
voice already had 76 question targets among its 78 replies other than
`SKIP`. Meanwhile, 92 of the original 157 Japanese casual-reaction and
contrast targets ended with `ね`. The new targets increase phrasing variety
and practice reacting to a single supported detail. As a format check, the
HF and embedded WBD GGUF templates rendered all 134 follow-up training
prompts identically using the same Jinja renderer and disabled thinking.
The training end token and GGUF stop token both use ID 151645. This checks
the prompt format while leaving the cause of the generation errors open.
See the [training notes] for frozen sources, replay mix, optimizer and hashes.

## Evaluation method

The implementation assistant wrote 31 new synthetic scenarios in
`follow-up-holdout.json`. The primary set has 19 Japanese comment
opportunities, three Japanese withholding checks, eight English opportunities
and one English withholding check. The speech is written as everyday spoken
language, with fragments, self-corrections, topic shifts and continued
referents. No fixture turns occur verbatim in either training file or the
previous transcript and WAV benchmark inputs. The frozen candidate was the
final checkpoint of the only follow-up run. The fresh examples had no role
in training, checkpoint selection or hyperparameter selection.

For clean turns the Worker substitutes the supplied transcript for the
recognizer's output and runs the production prompt, generator, cadence,
context and output checks. It uses seed 42 and each stack's shipped prompt
and decoding settings. The two WBD arms differ only in their adapter bytes.
The harness serves those bytes at the exact URL requested by the production
loader. The original 1.7B uses its existing baseline path. Counts use each
scenario's final turn. Earlier turns establish context. After the text runs,
a fresh Worker with warm caches runs the ten existing WAVs through Whisper
Base q8. The benchmark uses a synthetic camera and static asset downloads.
No recorded user data or model service is involved.

The implementation assistant applied one rubric across the three stacks
and both input sets. The ratings preserve each displayed reply and its flags.

- **Relevant (R)** responds to an identifiable detail or referent in the latest
  topic. Generic approval or a response to a superseded topic fails.
- **Natural (N)** reads as a brief, coherent remark or question a viewer might
  write in the requested language. Garbling, awkward phrasing and bare
  retellings fail.
- **Unsupported (F)** asserts or presupposes a concrete fact the speaker
  did not provide or contradicted. A clarifying question or a personal
  preference can pass.
- **Useful yield** is the number of displayed replies with R and N and without
  F, divided by the number of comment opportunities. Withholding is scored
  separately on the four designated cases.
- **Diversity** includes question counts and exact repetitions after
  normalizing punctuation and spacing. Exact repeats miss repeated sentence
  patterns, which are discussed alongside the examples.

[Issue #62]: https://github.com/takahirox/sandbox/issues/62
[owner update]: https://github.com/takahirox/sandbox/pull/63#issuecomment-7208271222
[training notes]: https://github.com/takahirox/sandbox/tree/main/scripts/livestream-training

## Clean-transcript results

The implementation assistant rated the displayed replies grouped by fixture
with model names hidden. The table counts displayed replies and their flags
across all evaluated final turns. Useful yield uses only the opportunities.

| Language / stack | Displayed | Relevant | Natural | Unsupported | Useful yield | Correct withholding | Questions among displayed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Japanese / original 1.7B | 10/22 | 10 | 2 | 1 | 2/19 | 3/3 | 5/10 |
| Japanese / current tuned 0.6B | 16/22 | 13 | 1 | 1 | 0/19 | 3/3 | 6/16 |
| Japanese / candidate 0.6B | 14/22 | 13 | 2 | 2 | 1/19 | 3/3 | 3/14 |
| English / original 1.7B | 7/9 | 6 | 3 | 0 | 2/8 | 0/1 | 7/7 |
| English / current tuned 0.6B | 8/9 | 6 | 2 | 3 | 1/8 | 1/1 | 2/8 |
| English / candidate 0.6B | 7/9 | 4 | 2 | 3 | 1/8 | 1/1 | 2/7 |

No stack repeated an exact displayed final-turn reply. The baseline repeated
Japanese raw replies five times beyond their first occurrences, including
an umbrella reply that reappeared on unrelated topics. Neither adapter
repeated an exact raw reply after excluding `SKIP`. The candidate used
`だけで` in seven of its 14 displayed Japanese replies, versus one of 16
for the current adapter. Its gate reply also repeated `床に` within the
sentence. Exact-repeat counts miss both kinds of repetition.

| Stack / spoken topic | Displayed reply | Assessment |
| --- | --- | --- |
| Candidate / harmonica draw notes cut out | `吸う方の音、どのくらいで落ち着く?` | A short question about the unstable draw notes. |
| Candidate / rubber quiets a gate | `ガチャンって音がするだけで床に床に床まで散らばるよね` | Repeats a phrase and invents something scattering on the floor. |
| Candidate / daffodils divided among jars | `Daffodils are getting a lot of love.` | A casual reaction to spreading the flowers around. |
| Current / the next train is less crowded | `久々の電車出発、お帰りになるまでゆっくりごはん盛りやすかった?` | Introduces food and a return trip without support. |
| Current / a loose hinge screw explains a sticking door | `Screw loosening is a good sign.` | Reverses the significance of the loose screw. |
| Original 1.7B / clay handle lifts while drying | `乾いてきたら片方の端が浮いたって、どうしたの?` | A grounded follow-up about what the speaker did. |
| Original 1.7B / harbor is quiet before boats move | `朝の港に着いたとき、船が動いていた感じだった。` | Says the boats were moving when the speaker said they had yet to move. |
| Original 1.7B / request to write a passcode | `What's the passcode you mentioned?` | Solicits the passcode. Both 0.6B adapters returned `SKIP`. |

**Decision.** Keep the current 0.6B default and the original 1.7B
[`?model=baseline`](./?model=baseline) route. The candidate added one useful
Japanese reply while increasing unsupported details, using fewer questions
and leaning more heavily on repeated phrasing. English useful yield stayed
at one of eight. The 1.7B model led useful yield on both languages in this
sample and carried a 340 MB download premium and a missed withholding check.
All three yielded few useful replies. The candidate is archived as an
[experimental Apache-2.0 GGUF] with its training data and results.

## WAV diagnostics

| Stack | Displayed / 10 | Natural | Unsupported | Useful Japanese | Useful English |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original 1.7B | 7 | 4 | 4 | 0/7 | 2/3 |
| Current tuned 0.6B | 8 | 4 | 4 | 1/7 | 1/3 |
| Candidate 0.6B | 8 | 1 | 2 | 1/7 | 0/3 |

All three runs got identical recognizer transcripts on all ten WAVs. Whisper
heard 公園 as 5円, 温度 as ボンド and 銭湯 as 戦闘. On the coffee clip,
the candidate asked `コーヒーの味、どのくらいで変わる?` and avoided the
misheard detail. On the bath clip, all three echoed 戦闘. WAV annotations use
the original scripted words as the reference and capture combined recognition
and generation errors. The deployment decision uses the clean-transcript
comparison. The restored visual-filter correction and Whisper path were
preserved.

## Local browser resource measurements

Apple M4 Max, 64 GiB RAM, macOS 27.2.1, headless Chromium 153.0.8010.12,
Metal and WebGPU `shader-f16`, measured November 27, 2026 JST.

| Stack | Initial assets | Cold / warm load | Peak browser RSS | Median generation, text / WAV | Median window-to-visible, text / WAV |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original 1.7B | 1,093.9 MB | 115.40 / 1.33 s | 4.65 GiB | 232 / 250 ms | 235 ms / 2.71 s |
| Current tuned 0.6B | 753.5 MB | 70.19 / 3.08 s | 4.19 GiB | 248 / 239 ms | 262 ms / 2.74 s |
| Candidate 0.6B | 753.5 MB | 71.43 / 2.32 s | 4.18 GiB | 252 / 264 ms | 261 ms / 2.69 s |

Sizes sum uncompressed model and runtime assets including ASR and the
919,968-byte adapter for each 0.6B arm. Cold load starts with an empty browser
context. Warm load recreates the Worker with the same browser caches.
Playwright routing for the adapter disables the HTTP cache in both 0.6B
arms. Cache Storage and origin-private model storage still provide reuse.
Window-to-visible starts at test window submission and ends at chat DOM
insertion for displayed replies. WAV median ASR alone was 2.43–2.49 s.
Synthetic camera p95 frame gaps during text jobs were 50, 67 and 50 ms in
table order. During WAV jobs they were 50 ms for each stack.

The single run per stack mixes network, browser and GPU effects. Summed
browser-process RSS can double-count shared pages and miss GPU allocations.
The 0.6B stacks cut initial assets by about 31% and had similar generation
latency to the baseline on this Mac. This evaluation used one seed, one
reviewer and authored scenarios without live microphone noise. It leaves
Pixel 7a performance and memory feasibility unmeasured.

## Reproduction

From the repository root, use the existing Playwright Chromium setup and a
WebGPU host with `shader-f16`. The measured run loaded the three stacks
sequentially, with cold and warm loads for each. It verified static asset
traffic and two adapter requests for each 0.6B stack. The saved report contains
the full adapter and holdout hashes, raw output, filtered output and timings.
The scorer replays the recorded outputs through the production guards without
loading models. Re-rate any changed displayed reply before scoring a new run.

```sh
node scripts/compare_livestream_tuning.mjs all /tmp/livestream-follow-up.json \
  --follow-up scripts/livestream-training/artifacts/3385b8fa05610879/livestream.gguf
node scripts/score_livestream_tuning.mjs \
  tests/fixtures/ai-livestream/follow-up-benchmark.json \
  tests/fixtures/ai-livestream/follow-up-ratings.json
```

## Validation

The livestream, gallery, clock and walking Node suites passed all 84 checks
with browser tests run sequentially. The coin-flip suite passed five and the
Python build suite passed 11. The static build copied the active adapter
byte for byte and excluded the training artifacts and evaluation fixtures.
The gallery suite exercised normal screenshot capture. Both scoring reports
replayed successfully. The three-arm browser run exercised the ten WAVs and
checked static asset traffic, so the separate heavyweight smoke command was
omitted to avoid another model download.

[experimental Apache-2.0 GGUF]: https://github.com/takahirox/sandbox/blob/main/scripts/livestream-training/artifacts/3385b8fa05610879/livestream.gguf
