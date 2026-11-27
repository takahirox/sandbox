# Livestream comment tuning evaluation

The default for [Issue #62](https://github.com/takahirox/sandbox/issues/62) is
Qwen3 0.6B WBD with a task-specific GGUF LoRA. The original 1.7B model is
available via [`?model=baseline`](./?model=baseline). The experiment also
evaluates the same Japanese-adapted 0.6B weights without the livestream
adapter, using the same runtime and sampling settings. The
[model notice](./models/NOTICE.md) records the trained artifact, licenses and
revision pins.

The reviewed RMSNorm checkpoint produced zero useful Japanese replies on
eight expected-reply cases. The new default produced one useful reply on
those eight cases and three on the seven additional Japanese transcript
opportunities. It still struggled with noisy recognition and on the five
original clean transcript opportunities. The 1.7B model had higher useful
yield on the English transcript set.

## Method and rubric

The Chromium harness runs the six original WAVs and four added Japanese WAVs
through Whisper Base q8. It also feeds 18 original and eight additional
transcript scenarios through the production inference code with only ASR
replaced. The fixtures are synthetic and were excluded from the training
corpus and teacher inputs. Some of the transcript cases were inspected while
comparing prototypes. The four added WAVs were generated after the shipped
checkpoint was trained. See [fixture provenance] for the texts and audio
generation settings.

Each mode uses the same ASR, prompt builder, voice rotation, context bound
and output filters. The two WBD modes use wllama, a temperature of 0.4,
top-p 0.85, top-k 20, min-p 0.01 and repetition penalty 1.05. The original
1.7B rollback uses its WebLLM decoding settings. Each mode samples once
per comment opportunity with seed 42. Earlier turns establish context and
recent replies. Only final turns contribute to transcript quality scores.

The implementation assistant rated each visible reply against the fixture
topic and the original spoken words where available. The ratings file keeps
the exact comment alongside its flags.

- **Relevant (R)** engages a detail or referent supported by the latest topic.
  Generic approval or a reply about a superseded topic fails.
- **Natural (N)** reads as a brief, coherent viewer reaction or question in the
  requested language. Garbling, robotic wording and bare retellings fail.
- **Unsupported (F)** asserts or presupposes a concrete missing or contradicted
  detail, such as a misrecognition repeated as fact. Clarifying questions and
  personal preferences can pass.
- **Useful yield** counts relevant and natural replies without unsupported
  details. **Correct withholding** counts cases labeled for silence that
  produced no visible comment.
- **Diversity** counts questions and exact repeats after stripping the empty
  thinking block, punctuation and spacing. SKIP is excluded from repeat counts.

[fixture provenance]: https://github.com/takahirox/sandbox/tree/main/tests/fixtures/ai-livestream

## Results on Apple M4 Max

The 2026-11-27 JST measurements used macOS 27.2.1, 64 GiB RAM and headless
Chromium 153.0.8010.12 with Metal and `shader-f16`.

| Stack | Initial static assets | Cold load | Warm load | Peak browser RSS | Median generation, WAV / text | Median window-to-visible, WAV / text |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original 1.7B | 1,093.9 MB | 101.50 s | 1.63 s | 4.45 GiB | 225 / 376 ms | 2.72 s / 326 ms |
| Tuned WBD 0.6B | 753.5 MB | 69.56 s | 1.92 s | 4.33 GiB | 235 / 248 ms | 2.57 s / 252 ms |
| WBD 0.6B without adapter | 752.6 MB | 76.41 s | 1.95 s | 3.15 GiB | 496 / 255 ms | 3.85 s / 288 ms |

Asset sizes count uncompressed runtime and model bytes. Cold load starts with
an empty browser context. Warm load restarts the Worker with the same context
and model caches. RSS sums browser, renderer and GPU process readings about
once per second. Shared pages can be double-counted, and this method can miss
GPU allocations or short peaks. One run per model is insufficient to attribute
the observed difference between the two WBD RSS or WAV timings to LoRA.

Window-to-visible starts when the completed fixture window is submitted and
ends at insertion into the chat DOM. It excludes capture and scheduling and
includes only shown replies. The median WAV ASR took 2.34 s in the tuned run.
Synthetic camera p95 frame gaps during jobs were 50 ms for 1.7B, 67 ms for
tuned WBD and 50 ms for untuned WBD. The longest gaps were 417 ms, 67 ms and
100 ms respectively. Treat these as individual synthetic-camera measurements.

| Set / stack | Shown | Relevant | Natural | Unsupported | Useful yield | Correct withholding | Questions among shown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 WAVs / original 1.7B | 7/10 | 5 | 3 | 5 | 2/10 | — | 4/7 |
| 10 WAVs / tuned WBD 0.6B | 8/10 | 5 | 4 | 3 | 2/10 | — | 1/8 |
| 10 WAVs / WBD 0.6B without adapter | 7/10 | 6 | 2 | 1 | 2/10 | — | 4/7 |
| 26 transcript turns / original 1.7B | 18/26 | 14 | 7 | 4 | 5/19 | 4/7 | 12/18 |
| 26 transcript turns / tuned WBD 0.6B | 16/26 | 13 | 5 | 6 | 4/19 | 7/7 | 0/16 |
| 26 transcript turns / WBD 0.6B without adapter | 15/26 | 8 | 3 | 6 | 0/19 | 4/7 | 8/15 |

| Japanese useful yield | Original 1.7B | Tuned WBD 0.6B | WBD 0.6B without adapter |
| --- | ---: | ---: | ---: |
| Three original WAVs | 0/3 | 1/3 | 0/3 |
| Five original transcript opportunities | 0/5 | 0/5 | 0/5 |
| Four added WAVs | 0/4 | 0/4 | 0/4 |
| Seven added transcript opportunities | 0/7 | 3/7 | 0/7 |

The tuned adapter improved Japanese yield over both measured controls and
withheld all seven designated turns. It produced no exact repeated visible
comments across the final turns within either scored set. Exact repetition
counts cover final-turn strings and can miss repeated sentence patterns. Its
shown transcript replies were all reactions, and it produced one question
across the WAV set. Display rate and useful yield are scored separately.
The same two useful replies in total across WAVs came from different languages
and fixtures for each model. On the English transcript opportunities, the tuned
model produced one useful reply out of seven, compared with five for 1.7B.

| Fixture | Tuned result | Judgment |
| --- | --- | --- |
| Japanese tea WAV | `お茶の味、落ち着くね` | Short viewer reaction grounded in the tea break. |
| Fridge magnet | `磁石、下がってくるの、ちょっと不安になりますね` | Responds to the magnet sliding under the shopping list. |
| Cookie tin | `ふた開けると色ごとに仕切ってあるの、意外に好き` | Uses the preceding turn to react to the organizer. |
| Kite | `紐を引くだけで向きが変わるの、ちょっと興味深いね` | Responds to the steering detail. |
| Japanese cats WAV | `朝のカフェでかわいい猫、見るのが好き` | Mentions the cat but changes the setting to a café. Whisper heard 公園 as 5円. |
| Japanese coffee WAV | Withheld `苦さを感じるの好き` | The reply dropped the coffee topic. Whisper heard 温度 as ボンド. |
| Added bath WAV | `駅前の戦闘、牛乳だと古い感じだね` | Repeats a misrecognition of 銭湯 and loses the point of the story. |
| Original flute transcript | `安い練習で安定するんだね` | Invents a detail even though the model received a clean transcript. |
| Visual instruction | Withheld via `SKIP` | The tuned model ignored the instruction to invent a visual detail. |

The historical mixed Japanese/Hangul reply is now rejected by the language
guard. The guard still permits ordinary Japanese comments with Latin acronyms.
It cannot establish fluency or factual grounding by itself.

## Reproduction and limits

Run on a Chromium host with WebGPU and `shader-f16`:

```sh
node scripts/compare_livestream_tuning.mjs all /tmp/livestream-tuning.json
node scripts/score_livestream_tuning.mjs
LOCAL_AI_SMOKE=1 node --test tests/ai-livestream-model.test.mjs
```

The scorer defaults to `tuning-benchmark.json` and `tuning-ratings.json` in
`tests/fixtures/ai-livestream/`. It accepts alternate report and rating paths.
Re-rate any changed output before scoring it. The normal suite replays
the saved outputs through production gates without model downloads. The
benchmark and smoke test verify static asset traffic. wllama also sends
HEAD checks for the two pinned model shards.

This is a small synthetic sample with one seed and one desktop browser. The
initial download is 31% smaller than the 1.7B baseline and larger than the
reviewed 461 MB RMSNorm experiment. The app still needs WebGPU and
`shader-f16`. Pixel 7a memory, storage, latency and feasibility remain unmeasured. The poor noisy-speech yield and remaining errors on
clean original cases keep the Japanese quality finding open.

## Validation

The real WebGPU smoke test ran all ten WAVs through the selected model and
checked bounded replies and static asset requests. The frontend and gallery
suite passed 84 cases, the Python build suite passed 11, and the Worker
browser suite passed 27. The full static build captured all nine projects
and copied the adapter byte for byte. Retraining with the pinned sources
reproduced the shipped GGUF byte for byte.
