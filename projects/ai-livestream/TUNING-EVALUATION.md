# Qwen3 0.6B livestream tuning experiment

[Issue #62](https://github.com/takahirox/sandbox/issues/62) compares the tuned
0.6B default with the original 1.7B model, available at
[`?model=baseline`](./?model=baseline). The comparison includes untuned
0.6B so the size reduction and the learned adaptation can be evaluated separately.

The [model notice](./models/NOTICE.md) contains the weights, revision pins and
license. The [training source and data](https://github.com/takahirox/sandbox/tree/main/scripts/livestream-training)
include the reproduction commands and corpus provenance. All three variants use
the same WebLLM version, sampler, 1,536-token context, 256-token prefill, four
voices, production prompts, ASR configuration and comment filters.

## Method and rubric

The opt-in Chromium harness loads one model per fresh browser context. It runs
the six existing synthetic Japanese and English recordings through real Whisper
Base q8, then runs 18 held-out transcript scenarios using the same inference code
with only the ASR output replaced by the fixture. These cases cover new everyday
topics, explicit topic changes, two-turn references, misrecognition, repetition,
silence and instructions asking for private or visual information. Neither
fixture set went into training. One model sample per opportunity uses seed 42.
The earlier optimization trial used a different exploratory transcript set.
The baseline receives the same visual-claim filter as the tuned and control
models because the trial exposed a phrase the old filter did not catch.

The final turn of each transcript scenario is scored. Earlier turns are fed
through the full pipeline to establish context and update recent replies. Six
scenarios are labeled for withholding. A reviewer labels each visible reply
against the intended fixture topic and the original spoken words when available:

- **Relevant (R)** engages the latest topic or a referent supported by recent
  speech. A generic positive reaction or an earlier topic after a switch fails.
- **Natural (N)** sounds like a brief, coherent viewer reaction or question in
  the requested language. Garbling, task instructions, robotic wording and
  bare retellings fail.
- **Unsupported (F)** states or presupposes a concrete detail absent from or
  contradicted by the fixture, including ASR mistakes repeated as fact or a
  claim of seeing the stream. An open clarification or a personal preference
  can pass.
- **Useful yield** counts relevant and natural comments without unsupported
  details on opportunities that should produce a reply. **Correct withholding**
  counts suppressed comments on the six cases labeled for withholding.
- **Diversity** counts questions versus reactions, and exact duplicate outputs
  after removing the empty thinking block, punctuation and spacing and folding
  case. SKIP is excluded from repetition. This counts exact repeats across the
  scored cases, so it can miss repeated templates with different topic words.

The implementation assistant applied the rubric to the recorded outputs. The
case-level annotations and raw turns keep that judgment auditable. Acceptance
by the production filters is reported separately from the usefulness score.

## Results on Apple M4 Max

The 2026-11-27 JST run used 64 GiB RAM, macOS 27.2.1, and headless Chromium
153.0.8010.12 with Metal and `shader-f16`.

| Stack | Initial static assets | Cold load | Warm load | Peak browser RSS | Median generation, WAV / transcript | Median window-to-visible, WAV / transcript |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original 1.7B | 1,093.9 MB | 98.56 s | 1.28 s | 4.50 GiB | 221 / 194 ms | 2.39 s / 174 ms |
| **Tuned 0.6B** | **461.3 MB** | **40.71 s** | **1.09 s** | **3.57 GiB** | **136 / 112 ms** | **2.36 s / 124 ms** |
| Untuned 0.6B | 461.3 MB | 40.68 s | 1.10 s | 3.58 GiB | 128 / 100 ms | 2.33 s / 131 ms |

Initial asset sizes sum logical model, tokenizer, compiled library and runtime
bytes before HTTP compression. The tuned stack loaded the versioned manifest
and the 131,072-byte trained overlay into WebLLM's model cache. Cold load
includes runtime imports, download and initialization. Warm load restarts the
Worker with the same browser's asset cache. Cold timings reflect one connection.
RSS is the peak of one-second sums over browser, renderer and GPU processes,
which can double-count shared pages and miss short spikes or GPU allocations.
Window-to-visible measures from submitting the completed fixture window to
inserting the comment into the chat DOM. It excludes the six-second capture
and scheduler wait and includes only replies that were shown. Median real ASR
alone was 2.22–2.23 seconds across the three runs.

The synthetic camera's p95 interval between frame callbacks was 50 ms during
jobs for all three variants. The maximum was 67 ms for each. Before jobs, p95
was 67 ms for the original 1.7B and 50 ms for both 0.6B runs. The fixture
harness observed no clear responsiveness advantage from these frame samples.

| Set / stack | Shown | Relevant | Natural | Unsupported | Useful yield | Correct withholding | Questions among shown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Six WAVs / original 1.7B | 4/6 | 4 | 4 | 2 | 2/6 | — | 4/4 |
| Six WAVs / tuned 0.6B | 6/6 | 3 | 1 | 2 | 1/6 | — | 2/6 |
| Six WAVs / untuned 0.6B | 5/6 | 3 | 3 | 0 | 1/6 | — | 3/5 |
| 18 held-out turns / original 1.7B | 11/18 | 7 | 7 | 1 | 5/12 | 4/6 | 8/11 |
| 18 held-out turns / tuned 0.6B | 10/18 | 6 | 2 | 2 | 2/12 | 6/6 | 2/10 |
| 18 held-out turns / untuned 0.6B | 8/18 | 5 | 5 | 4 | 1/12 | 4/6 | 4/8 |

The tuned stack cut the initial assets by 58% versus 1.7B and gained one useful
held-out reply versus the untuned 0.6B. It withheld on the three cases sent to
the model that called for silence. The existing audio/speech gates handled the
other three. Its Japanese frequently came out garbled, including on clean
held-out transcripts, and it yielded fewer useful replies than 1.7B in both
sets. None of the three stacks produced a Japanese reply that met all three
quality conditions in this sample. The largest clear gains are smaller
downloads and the measured withholding behavior.

Across the scored final turns of each set there were zero exact raw duplicates
apart from SKIP and zero exact visible duplicates. The tuned model used more
reactions and fewer questions than 1.7B. It also produced awkward reactions and
mixed-script fragments, so a wider mix of reply formats did not lift naturalness.
The repeat fixture suppressed an identical recognition in all three stacks.

| Fixture | Original 1.7B | Tuned 0.6B | Observation |
| --- | --- | --- | --- |
| Japanese cats WAV | `今日は何で猫を買ったの?` | `5円で猫見지難しに進む?` | Whisper heard 公園 as 5円. The original assumes a purchase and the tuned model leaks the error in a garbled reply. |
| Japanese coffee WAV | Withheld the echo about ボンド | `コーヒー苦みだと手間違って少ないよね` | Whisper heard 温度 as ボンド. The tuned output also lacks coherent phrasing. |
| English coffee WAV | `What's your favorite coffee drink?` | `A fresh cup sounds delightful.` | Both useful, with different viewer voices. |
| Flute continuation | Withheld a question about when practice started | `低い音は途中の違いだな` | The adaptation picks up the low note but sounds unnatural. The untuned control instead referred to guitar strings. |
| English printing | `Are you using a special paper for invitations?` | `What paper are you printing on?` | Both ask a grounded follow-up. The untuned 0.6B withheld. |
| Visual instruction | `What brand are those glasses?` | Withheld via `SKIP` | The tuned model ignored the quoted instruction to pretend to see the streamer. |
| Corrected English transcript | `What did you mean by "moving stair"?` | `Morning stars are often like moving staircases.` | The baseline follows the superseded words and the tuned reply invents a comparison. |

## Reproduction

With the pinned Playwright Chromium installed, on a WebGPU host with
`shader-f16`, run from the repository root:

```sh
node scripts/compare_livestream_tuning.mjs all /tmp/livestream-tuning.json
node scripts/score_livestream_tuning.mjs
```

The scoring command defaults to the committed measurements and annotations in
`tests/fixtures/ai-livestream/tuning-benchmark.json` and
`tests/fixtures/ai-livestream/tuning-ratings.json`. It also accepts both paths
as arguments. If sampling changes the outputs, re-review the replies before
applying the rubric. The normal tests replay the saved outputs through the
production guards without a GPU, browser model downloads or training. This
benchmark starts Chromium's synthetic camera, uses no physical devices and
checks the browser requests for GET-only static-asset traffic.

## Limits

This is a small synthetic sample, with one sampling seed and one desktop
browser build. It does not cover dialects, fast or overlapping speech, longer
sessions or adversarial inputs. Both runtimes still require WebGPU with
`shader-f16`. Smaller assets and lower desktop RSS make the 0.6B trial more
plausible on phones, but neither desktop RSS nor a synthetic camera establishes
Pixel 7a readiness. A mobile browser can still fail GPU initialization, storage
quota or memory allocation. Physical-device feedback is optional.

## Validation

The normal tests passed across 84 frontend cases, 11 Python build cases and
27 Worker browser integrations. The full site build captured all nine gallery
projects and copied the trained binary byte for byte. The opt-in WebGPU smoke
passed on all six synthetic audio inputs. Exporting from the saved training
checkpoint reproduced both shipped overlay files byte for byte. Wrangler's
dry-run bundle and two local D1 migration runs passed.

The Worker unit suite had 70 passes and one local `ECONNRESET` during the
counter's 340-request NAT burst test, reproduced on the unchanged upstream
checkpoint. The initially intermittent direct WebRTC assertion passed on an
isolated retry and on a complete browser-suite retry.

After merge, verify the Pages deployment serves the versioned overlay and
loads both model choices from the published project path. Physical phone
testing can provide additional observations separately.
