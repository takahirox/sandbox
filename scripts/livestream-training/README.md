# Livestream comment tuning

The Qwen3 0.6B experiment for [Issue #62](https://github.com/takahirox/sandbox/issues/62)
uses a rank-8 LoRA adapter over the Japanese-adapted Qwen3 0.6B WBD model.
The original RMSNorm checkpoint often produced garbled Japanese, and two
trials with the original Qwen3 q4 weights still yielded incomplete or
misgrounded replies. This version starts from a Qwen checkpoint with additional
Japanese training and runs the GGUF LoRA directly in the browser using wllama.
The adapter operates on the MLP down-projection and attention output projection
of the final eight decoder layers. It trains 458,752 parameters and exports
32 FP16 arrays in a 919,968-byte GGUF. The 639 MB of Q8_0 shards remains frozen.
The loading path and licenses are documented in the [model notice].

[model notice]: ../../projects/ai-livestream/models/NOTICE.md

## Data and training

The frozen `train.jsonl` contains 384 original synthetic examples (332 Japanese
and 52 English). It covers four viewer voices, everyday topics, short reactions
and questions, topic switches, referential turns, silence, private or visual
requests, and corrupted transcripts. The Japanese set includes 20 paired clean
and noisy utterances with the same grounded reply. These pairs teach the model
to react to a clear detail even when a number, location or adjacent phrase is
misrecognized.

The implementation assistant wrote the speech and context in every row. It
also wrote 268 target replies. The remaining 116 replies are labeled
`gemma-4-draft`. A local teacher drafted one short reply for each supplied
utterance and viewer style. The implementation assistant reviewed the drafts
and revised generic reactions, retellings and unnatural wording. No model API,
recorded media, private data, or scraped chat logs were used. The [teacher
conversion] and [original teacher model] use Apache 2.0. The authored examples
are offered under [CC0 1.0].

[teacher conversion]: https://huggingface.co/mlx-community/gemma-4-31b-it-4bit/tree/535c5606372deb5d5ab7e29280f111ef2a8e084e
[original teacher model]: https://huggingface.co/google/gemma-4-31B-it/tree/3548789868c5356dbf307c98e6f609007b82b3eb
[CC0 1.0]: https://creativecommons.org/publicdomain/zero/1.0/

The WAVs and transcript scenarios used for evaluation were excluded from the
training corpus and the teacher's inputs. The frozen dataset is sufficient
to reproduce the adaptation without teacher access.

`prompts.mjs` calls the production prompt builder. The trainer unpacks the
pinned GGUF weights to FP16 for its forward pass and keeps trainable copies
of the LoRA matrices in FP32. The objective is cross-entropy on reply and
end-token positions. Adam uses learning rate 0.0003, gradient clipping at 1,
seed 62, batch size 4, and four shuffled epochs (384 updates). It uses the
Qwen3 no-thinking assistant header. The [browser evaluation] measures
transfer to the deployed GGUF/WebGPU path.

[browser evaluation]: ../../projects/ai-livestream/TUNING-EVALUATION.md

## Reproduction

Use Apple silicon, Python 3.12, Node 22+, and space for the pinned GGUF shards,
tokenizer and Python environment. From the repository root:

```sh
work="$(mktemp -d)"
uv venv --python 3.12 "$work/venv"
uv pip install --python "$work/venv/bin/python" -r scripts/livestream-training/requirements.txt
"$work/venv/bin/python" scripts/livestream-training/train.py "$work" "$work/livestream.gguf"
shasum -a 256 scripts/livestream-training/train.jsonl "$work/livestream.gguf"
```

The trainer verifies SHA-256 for both GGUF shards, tokenizer and config.
A different Metal or MLX build may yield different rounded weights. To deploy
a new checkpoint, put the adapter under
`projects/ai-livestream/models/resolve/<sha256-prefix>/livestream.gguf`, update
the runtime pin and artifact test, and rerun the browser comparison.

| File | SHA-256 |
| --- | --- |
| `train.jsonl` | `289dae9c07a4fa87a1de8761aebed0b9bba477b11814cfca313eb5efd8932785` |
| `livestream.gguf` | `e3866302664199c20d0c4b35fee826b06562ebb9782fd46059e35ea0de1d2192` |

The training run on an Apple M4 Max / 64 GiB took 38.4 seconds for the optimizer
loop and peaked at 2.38 GiB in the MLX allocator. Mean response-only loss fell
from 2.7035 to 1.2150. The evaluation scores are recorded separately.

## Second round

The [owner update] made clean, spoken Japanese the primary evaluation. The
first adapter sometimes added details to clean transcripts and rarely asked
questions. This round restores its 32 FP16 LoRA arrays into FP32 trainable
weights and continues training over the same frozen WBD base. The parent
adapter's SHA-256 is checked before loading.

The implementation assistant authored `follow-up.jsonl` under [CC0 1.0]. It
contains 64 new Japanese examples, 16 per viewer voice. The targets include
brief questions about details the speaker can answer, casual reactions,
preferences and responses to changes. Some examples resolve a pronoun from
the preceding turn, change the subject or explicitly correct a word. The
training set also replays all 52 original English rows and all 18 original
Japanese `SKIP` rows. No teacher, recordings or user data were used in this
round. The fresh evaluation transcripts and all WAVs were excluded.

The follow-up uses the existing response-only objective, seed 62, batch
size 4, clipping at 1 and a fresh Adam optimizer. Train for two epochs with
learning rate 0.00012 (68 updates), then export only the final adapter. The
lower learning rate and replay aim to retain prior behavior while adding
question and reaction supervision. Neither the training schedule nor the
candidate artifact was chosen by looking at the fresh evaluation outputs.

Run the same environment setup as above, then:

```sh
"$work/venv/bin/python" scripts/livestream-training/train.py "$work" "$work/follow-up.gguf" --follow-up
shasum -a 256 scripts/livestream-training/follow-up.jsonl "$work/follow-up.gguf"
```

| File | SHA-256 |
| --- | --- |
| `follow-up.jsonl` | `f114d8b24ff05d21e2c61820f7eaf001e726db268d6bc2d90bc65c7f434efba1` |
| `follow-up.gguf` | `3385b8fa05610879ebcf51d967979f113d3b2455e9e3d97eb6e11eb5eb1e8e8e` |

On the Apple M4 Max with Python 3.12.13 and the pinned requirements, the
optimizer loop took 7.1 seconds and MLX reported 2.39 GiB peak allocator
memory. Mean training loss fell from 2.2723 in epoch one to 1.5876 in epoch two.
The [exported candidate] uses the same [Apache-2.0 license] as the parent
adapter. See the [follow-up evaluation] for browser results and the deployment
decision.

[owner update]: https://github.com/takahirox/sandbox/pull/63#issuecomment-7208271222
[exported candidate]: ./artifacts/3385b8fa05610879/livestream.gguf
[Apache-2.0 license]: ../../projects/ai-livestream/models/LICENSE
[follow-up evaluation]: ../../projects/ai-livestream/FOLLOW-UP-EVALUATION.md
