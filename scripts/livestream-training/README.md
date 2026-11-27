# Livestream comment tuning

Issue [#62](https://github.com/takahirox/sandbox/issues/62) used a supervised,
response-only fine-tune of Qwen3 0.6B. The trainable weights are the 113 RMSNorm
gain vectors in the attention blocks and final norm, totaling 65,536 scalars.
All matrix weights and embeddings are frozen. Using the existing WebLLM compiled
library keeps the trial on the same browser backend as the 1.7B baseline.
Earlier repository measurements put MLC q4f16 below ONNX q4f16 for both download
size and desktop RSS. Merging an attention LoRA would be more expressive, but
would require re-quantizing and distributing the affected matrices. RMSNorm
tuning lets the browser combine the original q4 shards with a 128 KiB FP16
checkpoint. The script unpacks the exact frozen matrices from the published MLC
q4f16_1 shards to FP16 in MLX. That exposes the deployed quantization error
during training while keeping the frozen browser assets reusable. An earlier
trial trained against the original BF16 checkpoint cast to FP16 and often
produced garbled replies in the browser. Its exploratory transcripts were
retired before the final evaluation.

## Data and training

The 128 lines in `train.jsonl` comprise 76 Japanese and 52 English examples.
The utterances, earlier turns, avoided replies and target comments were written
for this project by the implementation assistant. They are available under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). They contain no
real audio, private data, scraped logs or outputs from a teacher API. Rows vary
the four viewer voices and cover everyday questions, reactions, preferences,
topic switches, fragments, plausible ASR errors, repeating input, silence and
cases where the desired reply is `SKIP`. Some SKIP conditions also have
pre-generation checks in the app. This small corpus is an experiment and has no
coverage guarantees for longer streams, dialects or adversarial prompts.

`prompts.mjs` uses the production prompt builder. The loss is cross-entropy on
target comment and end token positions only. The optimizer is Adam with FP32
trainable copies, learning rate 0.003, gradient clipping at 1, seed 62, batch 4,
and ten shuffled epochs (320 updates). The exported FP16 vectors reuse the
same dtype, names and shapes as the original quantized tensor manifest. The
synthetic WAVs and the separate held-out transcript set were excluded from
training and checkpoint selection.

Measured on an Apple M4 Max / 64 GiB running macOS 27.2.1 and Python 3.12.13.
The optimization loop took 109.8 s with a 3.74 GiB peak MLX allocator reading.
Mean batch loss by epoch was 3.5581, 2.4675, 1.7872, 1.3399, 0.9324,
0.6463, 0.4730, 0.3418, 0.2555 and 0.1986. These are training losses. Browser fixture results are in
[the evaluation](../../projects/ai-livestream/TUNING-EVALUATION.md).

## Reproduction

Use a Mac with Apple silicon, Python 3.12, Node 22+, and enough space for the
~350 MB of pinned MLC shards and tokenizer, plus the Python environment. This
run used local Metal compute. From the repository root:

```sh
work="$(mktemp -d)"
uv venv --python 3.12 "$work/venv"
uv pip install --python "$work/venv/bin/python" -r scripts/livestream-training/requirements.txt
"$work/venv/bin/python" scripts/livestream-training/train.py "$work" "$work/export"
shasum -a 256 "$work"/export/*/{norms.bin,tensor-cache.json}
```

The script checks SHA-256 for the original config, tokenizer and MLC manifest and
uses the pinned manifest's byte layout and checksums for each downloaded shard.
The raw intermediate checkpoint is `$work/norms.safetensors`. Use `--export-only` to
repack it. A different Metal or MLX build may yield different rounded weights. Export uses
the weights' SHA-256 prefix as its directory name. For a new checkpoint, review
the generated manifest, ship its directory under
`projects/ai-livestream/models/resolve/`, update the runtime path and artifact
test, and rerun the browser comparison before replacing the default.

| Artifact | SHA-256 |
| --- | --- |
| `train.jsonl` | `6c13db370cf61714042d74ab76460d8c05e392ba11dc98a80857360b1676163d` |
| `norms.bin` | `362c654633a66e61409e09a4e24dc9de32228d5418546342c838991ba046a237` |
| Generated `tensor-cache.json` | `8b25c8ec54dca1acf25d2d9388fd7a2293512877ba71caa23109b9536ee73346` |

The model and adaptation use Apache-2.0. The base and its quantized conversion
are revision-pinned in the script and documented in the
[model notice](../../projects/ai-livestream/models/NOTICE.md).
Only the compact overlay and manifest are included in the site build.
