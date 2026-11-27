# Expanded livestream training corpus

Issue #62 and PR #63. This round follows the owner's request to train on
substantially more fictional livestream chat, prioritizing spoken Japanese.
It uses the same Japanese-adapted Qwen3 0.6B WBD base and adapter shape as the
current demo. See the [training notes](../../scripts/livestream-training/README.md)
for source pins, licenses, curation and reproduction.

## Corpus and training budget

The frozen training set contains **1,604 examples** (1,430 Japanese and 174
English), about 4.2 times the original 384. It has 1,491 retained
Gemma-drafted rows and 113 original authored rows. The local teacher used
240 prompts across 152 retained topics in ten everyday domains. The corpus
includes four viewer voices, 494 question-mark replies, 83 examples with
prior context, and 31 `SKIP` targets. There are 1,590 distinct normalized
utterances and 1,482 distinct non-`SKIP` replies. Fourteen authored
utterances intentionally have two replies to teach different viewer styles.

A 64-prompt batch with the cached 31B teacher hit a Metal memory limit.
The [smaller local Qwen pilot] produced enough formatting and language
errors that its rows were excluded. The 16-prompt Gemma batches took
18.6 minutes. The highest sampled teacher process RSS was 16.16 GiB.
The second Gemma pass screened 512 candidates in 3.7 minutes. At the
observed retention and throughput, drafting 5,000 screened examples would
require roughly an hour of generation alone. The bounded run stopped at
240 prompts, with multilingual drafting and curation taking priority over
reaching the suggested range.

The first pass found 1,762 parseable teacher rows and rejected 183
malformed lines. Its checks removed 99 near-duplicate utterances or
replies, 61 script or length mismatches, 17 probable unsupported details
and six examples with inappropriate terms. No draft overlapped the 134
reserved normalized transcripts at the configured exact and lexical
thresholds. The check also rejected an injected exact copy and a near-copy
of an evaluation transcript. This establishes lexical separation within
the available files. The teacher's pretraining data and semantic similarity
remain unverified.

The manual sample used 12 Japanese and five English examples from each
48-prompt block. The reviewer rejected 31 of 85 drafts after the first pass.
They included invented facts, missing referents, generic or awkward chat,
weak grounding and inappropriate tone. For example, `Much saltier!`
asserted a taste difference when the speaker had only said they would try
a different brand of soy sauce. The second local screen flagged 36 of 512
drafts and accounted for 33 additional removals after manual adjudication.
It passed seven of nine manually rejected cases in the overlap, so residual
grounding and style errors are likely. The corpus remains mostly single-turn,
with authored examples contributing additional contextual and withholding
cases. All inputs were synthetic and generated or authored for this experiment.

[smaller local Qwen pilot]: https://huggingface.co/mlx-community/Qwen3-4B-Instruct-2507-4bit/tree/50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b

## Evaluation method

The 49 new synthetic scenarios include 30 Japanese and 12 English
comment opportunities, and seven expected withholds for silence, unclear
speech, camera questions and private information. Their input wording and
story details were authored independently of teacher drafting. A subset starts
with an earlier turn before a pronoun, fragment, correction or continuation.
Each model receives the same scenarios through the inference code used by
the app's Worker. The benchmark supplies accurate transcripts to the
recognizer boundary, applies the normal comment guards and cadence, and
records the last turn of each scenario for the scored comparison. The
benchmark also saves earlier turns. The original 1.7B route keeps its
shipped prompts and settings.
Both 0.6B arms use the shipped 0.6B settings and prompts with different LoRAs.
The browser benchmark uses a seed of 42 for all stacks.

One bilingual review pass sees the same rubric and transcript context for
shuffled, anonymous model outputs. A reply earns **useful** if it is relevant
to the latest speech, sounds like natural short viewer chat, and contains
neither unsupported detail nor inappropriate content. A natural open
question or playful reaction can earn credit without repeating the speech.
Concrete invented or contradicted facts, unobserved visual details and
unwarranted outcomes count as unsupported. Inappropriate includes soliciting
private information. Empty output and the exact `SKIP` marker are abstentions.
The scorer removes empty thinking wrappers and normalizes Unicode for
comparison. Raw and displayed outputs receive separate annotations when
filtering changes the reply. Questions include explicit question marks and
unpunctuated questions flagged by the reviewer. Variety uses normalized exact
repeats and Japanese `ね` endings alongside the examples. One seed and one
reviewer limit the precision of these comparisons.

## Clean-transcript results

Each cell gives **raw → displayed** counts. Responses and quality flags
include all cases. Useful yield divides by the opportunities for a reply.
Withholding counts the separate cases where silence was expected.

| Language and stack | Replies | Relevant | Natural | Unsupported | Useful yield | Correct withholding |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Japanese, original 1.7B | 33 → 2 | 4 → 1 | 29 → 1 | 29 → 0 | 1 → 1 / 30 | 1 → 3 / 4 |
| Japanese, active 0.6B | 29 → 25 | 28 → 24 | 9 → 8 | 6 → 4 | 6 → 6 / 30 | 3 → 4 / 4 |
| Japanese, expanded 0.6B | 32 → 4 | 9 → 3 | 26 → 3 | 1 → 0 | 5 → 2 / 30 | 2 → 4 / 4 |
| English, original 1.7B | 14 → 8 | 9 → 6 | 11 → 6 | 4 → 1 | 4 → 4 / 12 | 1 → 3 / 3 |
| English, active 0.6B | 12 → 7 | 4 → 3 | 4 → 2 | 1 → 1 | 0 → 0 / 12 | 3 → 3 / 3 |
| English, expanded 0.6B | 11 → 2 | 5 → 2 | 7 → 0 | 1 → 0 | 1 → 0 / 12 | 3 → 3 / 3 |

No raw or displayed clean-transcript reply received an inappropriate-content
flag under this rubric. Raw replies still include responses to withholding
cases, such as an unrelated color question after an access-code request
and a fabricated clothing explanation after a camera question.

| Language and stack | Raw repeats | Displayed repeats | Raw questions / other | Displayed questions / other | Useful displayed questions / reactions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Japanese, original 1.7B | 27 | 0 | 30 / 3 | 2 / 0 | 1 / 0 |
| Japanese, active 0.6B | 0 | 0 | 11 / 18 | 10 / 15 | 2 / 4 |
| Japanese, expanded 0.6B | 11 | 0 | 20 / 12 | 2 / 2 | 1 / 1 |
| English, original 1.7B | 2 | 0 | 14 / 0 | 8 / 0 | 4 / 0 |
| English, active 0.6B | 2 | 0 | 1 / 11 | 1 / 6 | 0 / 0 |
| English, expanded 0.6B | 4 | 0 | 7 / 4 | 2 / 0 | 0 / 0 |

The baseline generated the same shamisen question on 28 Japanese turns.
In 27 of those turns, the already displayed question was also present in
the prompt's `avoid_repeating` field. The count comes from replaying the
recorded dialog through the prompt builder. The association limits how far
this run can generalize about baseline quality on independent fresh chats.
The active adapter used `ね` on 10 raw and eight displayed Japanese replies.
The candidate moved away from that ending, but used `どっちが正解？` seven times
and `意外と楽そう` five times. Duplicate suppression removed exact repeats
from all three displayed stacks. The expanded adapter lost three of its
five useful Japanese raw replies and its one useful English raw reply
to the shared display guards.

| Stack / clean speech | Raw reply | Display result |
| --- | --- | --- |
| Active / spent longer picking flat skipping stones than throwing them | `石、どこで拾うの？` | Shown. A specific follow-up about the search. |
| Active / moving the router up weakened the signal in one room | `その和室、きっと通気性が結構違うんだね` | Shown. Introduces ventilation as an explanation. |
| Expanded / tried playing the shamisen with the finger marks covered | `どこまで弾いた？` | Shown. A grounded question. |
| Expanded / could open the new tap with an elbow while both hands were dusty | `意外と楽そう` | Withheld by the topic guard. The reaction fit the convenience described aloud. |
| Expanded / playing a synth whose pitch knob was wired in reverse | `flat?` | Withheld as a repeat of a reply to the bagel story. It could fit this musical context as a short pitch question. |
| Original / easing grip made the stunt kite turn | `Did you adjust the kite or the grip again?` | Shown. A follow-up tied to the technique. |
| Original / moving the router up weakened the signal in one room | `今日はどの三味線だったの？` | Withheld as a repeat. The raw question refers to the earlier instrument scenario. |

**Decision.** Keep the active 0.6B default and the original 1.7B
`?model=baseline` comparison route. The expanded adapter reduced invented
details in this run. It also produced fewer relevant comments, repeated
short templates and lowered useful displayed Japanese yield from six to
two. English useful displayed yield was zero for both adapters, while the
1.7B produced four. The [expanded GGUF](../../scripts/livestream-training/artifacts/3ec890afedd57fd7/livestream.gguf)
is archived with the corpus and benchmark.

## Browser resource measurements

Apple M4 Max with 64 GiB RAM, macOS 27.2.1, headless Chromium
153.0.8010.12 using Metal and WebGPU `shader-f16`. Each arm began in a
fresh browser context. Warm loads recreated the Worker in the same context.
The benchmark checked static asset traffic without request bodies and
observed two adapter requests per 0.6B arm.

| Stack | Initial assets | Cold / warm load | Peak browser RSS | Median clean generation / visible |
| --- | ---: | ---: | ---: | ---: |
| Original 1.7B | 1,093.9 MB | 103.99 / 1.61 s | 4.59 GiB | 205 / 184 ms |
| Active 0.6B | 753.5 MB | 81.42 / 2.59 s | 4.22 GiB | 236 / 237 ms |
| Expanded 0.6B | 753.5 MB | 69.08 / 2.10 s | 4.15 GiB | 186 / 194 ms |

Initial assets include the unchanged ASR and the model/runtime files.
Both 0.6B stacks use 919,968-byte adapters and reduce initial assets by
340.4 MB (31%). Visible latency starts at benchmark submission and ends
at DOM insertion, so its median uses only displayed replies. Synthetic
camera p95 frame gaps during both clean and WAV jobs were 50.1 ms across
all three stacks. These single browser runs include network and cache
variation. Summed browser-process RSS can double-count shared pages and
miss GPU allocations. Mobile performance remains unmeasured.

## Separate WAV diagnostics

Whisper received the same ten WAVs for every stack and produced identical
transcripts, including exact agreement with the earlier clean-transcript
round's WAV runs. It still heard `公園` as `5円`, `温度` as `ボンド`,
and `銭湯` as `戦闘`. The shirt clip also contained several ASR errors.
The clean-transcript results determined checkpoint choice.

| Stack | Shown / 10 | Median ASR | Median window to visible |
| --- | ---: | ---: | ---: |
| Original 1.7B | 7 | 2.69 s | 2.96 s |
| Active 0.6B | 8 | 2.46 s | 2.70 s |
| Expanded 0.6B | 6 | 2.39 s | 2.60 s |

## Shared camera-question guard

The shared filter checks whether a clause names the live image, asks a
question or makes a request, and asks the viewer to judge appearance.
This handles both Yes/No and open questions in Japanese and English,
independent of which text engine generated the reply. The same recognition
check applies before releasing a queued reply. The Worker regression runs
both model routes with the exact inputs and generated claims from review.

| Speech | Fixture generation | Displayed |
| --- | --- | --- |
| `Does my shirt look red on camera?` | `Your shirt looks blue.` | Withheld in both routes |
| `カメラだとこのシャツ、赤く見える？` | `シャツは青だね。` | Withheld in both routes |
| `I bought new glasses for reading.` | `What color did you pick for the glasses?` | Displayed in both routes |
| `読書用に新しいメガネを買ったよ。` | `メガネは何色にしたの？` | Displayed in both routes |

Additional cases cover settings questions, declarations about a camera
image, links or materials mentioned aloud, and questions about visibility
with ASR-style punctuation.

## Validation

- 90 frontend, model-pin and browser fixture checks passed. The opt-in
  heavyweight smoke test was skipped in that suite. The three-model Chromium
  benchmark exercised the real weights, both model routes and the ten WAVs.
- All 11 Python build checks, 71 Worker checks, and 27 Worker browser checks
  passed. The Worker dry-run build and both local D1 migration runs completed.
- The static build captured all nine projects and copied the active adapter
  byte for byte. It excluded the archived candidate, training data and test
  fixtures. Curation replay reproduced the frozen corpus byte for byte.
- The new scoring report replayed successfully. The two prior scoring
  reports also replayed with their recorded grades.

## Reproduction

Use the pinned Playwright Chromium setup and a host with WebGPU
`shader-f16`. Run these commands from the repository root.

```sh
work="$(mktemp -d)"
node scripts/compare_livestream_tuning.mjs all "$work/expanded-benchmark.json" \
  --expanded scripts/livestream-training/artifacts/3ec890afedd57fd7/livestream.gguf
node scripts/score_livestream_expanded.mjs \
  tests/fixtures/ai-livestream/expanded-benchmark.json \
  tests/fixtures/ai-livestream/expanded-ratings.json
```

Use `--review` in place of the ratings path to produce the anonymous review
rows. Rate a new benchmark before scoring it. Ratings are tied to the
benchmark checksum and the scorer replays the saved generations through the
current display pipeline.

The [benchmark](../../tests/fixtures/ai-livestream/expanded-benchmark.json)
records raw and displayed output, timing, resource and model-revision
metadata. The [review flags](../../tests/fixtures/ai-livestream/expanded-ratings.json)
provide the annotations used in the tables.
