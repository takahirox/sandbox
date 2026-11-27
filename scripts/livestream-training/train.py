"""Supervised Qwen3 RMSNorm tuning and export to a WebLLM tensor overlay."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import random
import subprocess
from time import perf_counter
from urllib.request import urlretrieve

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
from mlx.utils import tree_flatten, tree_unflatten
from mlx_lm.models.qwen3 import Model, ModelArgs
import numpy as np
from transformers import AutoTokenizer

SOURCE = Path(__file__).resolve().parent
QWEN = "https://huggingface.co/Qwen/Qwen3-0.6B/resolve/c1899de289a04d12100db370d81485cdf75e47ca/"
MLC = "https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f16_1-MLC/resolve/8c14ce481d4c692769976ad52afea453a102df19/"
SOURCE_SHA256 = {
    "config.json": "660db3b73d788119c04535e48cf9be5f55bc3100841a718637ae695b442f27dd",
    "tokenizer.json": "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
    "tokenizer_config.json": "d5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101",
    "tensor-cache.json": "f4647d617dc869d91fbd7851c65af0a2cf7dd615884ebe3b110013801b65d8c7",
}
SEED = 62
BATCH_SIZE = 4
EPOCHS = 10
LR = 0.003


class TrainableNorm(nn.RMSNorm):
    """Retain FP32 optimizer parameters and use FP16 weights on the forward pass."""

    def __call__(self, x):
        return mx.fast.rms_norm(x, self.weight.astype(x.dtype), self.eps)


def download(url, path, expected_hash=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        temporary = path.with_suffix(".download")
        urlretrieve(url, temporary)
        temporary.replace(path)
    if not expected_hash:
        expected_hash = SOURCE_SHA256[path.name]
    algorithm = "md5" if len(expected_hash) == 32 else "sha256"
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, algorithm).hexdigest()
    if digest != expected_hash:
        raise ValueError(f"Unexpected {algorithm} for {path}")


def dequantize(packed, scales):
    # MLC q4f16_1 packs eight low-to-high 4-bit values per uint32, zero at 7.
    # One FP16 scale covers four consecutive packed words (32 values).
    if packed.shape != (scales.shape[0], scales.shape[1] * 4):
        raise ValueError("Unexpected q4f16_1 layout")
    shifts = mx.arange(0, 32, 4, dtype=mx.uint32)
    nibbles = (packed[..., None] >> shifts) & 15
    groups = nibbles.reshape(*scales.shape, 32).astype(mx.float16)
    return ((groups - 7) * scales[..., None]).reshape(scales.shape[0], -1)


def load_mlc_model(base, manifest_path):
    args = ModelArgs.from_dict(json.loads((base / "config.json").read_text()))
    model = Model(args)
    model.eval()
    shards = json.loads(manifest_path.read_text())["records"]

    def prepare(shard):
        name = shard["dataPath"]
        path = manifest_path.parent / "shards" / name
        download(MLC + name, path, shard["md5sum"])
        return path

    tensors = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for shard, path in zip(shards, pool.map(prepare, shards)):
            with path.open("rb") as source:
                for record in shard["records"]:
                    dtype = {"float16": "<f2", "uint32": "<u4"}[record["dtype"]]
                    source.seek(record["byteOffset"])
                    data = source.read(record["nbytes"])
                    tensors[record["name"]] = mx.array(np.frombuffer(data, dtype).reshape(record["shape"]))

    weights = []
    for name, tensor in tensors.items():
        if name.endswith(".q_scale"):
            continue
        if name.endswith(".q_weight"):
            prefix = name.removesuffix(".q_weight")
            tensor = dequantize(tensor, tensors[prefix + ".q_scale"])
            if prefix.endswith(".c_attn"):
                sizes = (args.num_attention_heads * args.head_dim, args.num_key_value_heads * args.head_dim)
                projections = mx.split(tensor, [sizes[0], sum(sizes)], axis=0)
                parent = prefix.removesuffix("c_attn")
                weights.extend((parent + f"{kind}_proj.weight", value)
                               for kind, value in zip("qkv", projections))
                continue
            if prefix.endswith(".gate_up_proj"):
                projections = mx.split(tensor, 2, axis=0)
                parent = prefix.removesuffix("gate_up_proj")
                weights.extend((parent + f"{kind}_proj.weight", value)
                               for kind, value in zip(("gate", "up"), projections))
                continue
            name = prefix + ".weight"
        weights.append((name, tensor))
    model.load_weights(weights)
    mx.eval(model.parameters())
    return model


def training_rows(tokenizer):
    rows = subprocess.check_output(["node", SOURCE / "prompts.mjs"], text=True)
    examples = []
    for line in rows.splitlines():
        row = json.loads(line)
        prompt = tokenizer.apply_chat_template(
            row["messages"], tokenize=False, add_generation_prompt=True, enable_thinking=False,
        )
        expected_suffix = "<|im_start|>assistant\n<think>\n\n</think>\n\n"
        if not prompt.endswith(expected_suffix):
            raise ValueError("Training prompt must match WebLLM disabled-thinking format")
        inputs = tokenizer.encode(prompt, add_special_tokens=False)
        answer = tokenizer.encode(row["reply"] + "<|im_end|>", add_special_tokens=False)
        examples.append((inputs, answer))
    return examples


def batch_for(examples):
    input_length = max(len(prompt) + len(answer) - 1 for prompt, answer in examples)
    answer_length = max(len(answer) for _, answer in examples)
    inputs = np.zeros((len(examples), input_length), dtype=np.int32)
    positions = np.zeros((len(examples), answer_length), dtype=np.int32)
    targets = np.zeros_like(positions)
    mask = np.zeros_like(positions, dtype=bool)
    for i, (prompt, answer) in enumerate(examples):
        sequence = prompt + answer[:-1]
        inputs[i, :len(sequence)] = sequence
        positions[i, :len(answer)] = np.arange(len(prompt) - 1, len(sequence))
        targets[i, :len(answer)] = answer
        mask[i, :len(answer)] = True
    return tuple(map(mx.array, (inputs, positions, targets, mask)))


def assistant_loss(model, inputs, positions, targets, mask):
    hidden = model.model(inputs)
    hidden = mx.take_along_axis(hidden, positions[..., None], axis=1)
    logits = model.model.embed_tokens.as_linear(hidden).astype(mx.float32)
    return (nn.losses.cross_entropy(logits, targets) * mask).sum() / mask.sum()


def tune(base, original, checkpoint):
    mx.random.seed(SEED)
    rng = random.Random(SEED)
    model = load_mlc_model(base, original)
    tokenizer = AutoTokenizer.from_pretrained(base, local_files_only=True)
    norms = []
    for name, module in model.named_modules():
        if isinstance(module, nn.RMSNorm):
            norm = TrainableNorm(module.weight.size, module.eps)
            norm.weight = module.weight.astype(mx.float32)
            norms.append((name, norm))
    model.update_modules(tree_unflatten(norms))
    model.freeze()
    for _, module in model.named_modules():
        if isinstance(module, TrainableNorm):
            module.unfreeze()
    initial = dict(tree_flatten(model.trainable_parameters()))
    if len(initial) != 113 or sum(weight.size for weight in initial.values()) != 65536:
        raise ValueError("Unexpected Qwen3 RMSNorm parameter layout")

    examples = training_rows(tokenizer)
    grad = nn.value_and_grad(model, assistant_loss)
    optimizer = optim.Adam(learning_rate=LR)
    started = perf_counter()
    for epoch in range(EPOCHS):
        rng.shuffle(examples)
        losses = []
        for offset in range(0, len(examples), BATCH_SIZE):
            loss, gradients = grad(model, *batch_for(examples[offset:offset + BATCH_SIZE]))
            gradients, _ = optim.clip_grad_norm(gradients, 1.0)
            optimizer.update(model, gradients)
            mx.eval(model.trainable_parameters(), optimizer.state, loss)
            losses.append(loss.item())
        mean = sum(losses) / len(losses)
        if not np.isfinite(mean):
            raise ValueError("Non-finite training loss")
        print(f"epoch {epoch + 1}/{EPOCHS}, assistant loss {mean:.4f}, {perf_counter() - started:.1f}s", flush=True)
    weights = dict(tree_flatten(model.trainable_parameters()))
    changed = {name: weight.astype(mx.float16) for name, weight in weights.items()}
    if not all(mx.any(weight != initial[name].astype(mx.float16)).item()
               and mx.all(mx.isfinite(weight)).item() for name, weight in changed.items()):
        raise ValueError("Expected every exported tensor to change and stay finite")
    print(f"Metal peak allocator memory: {mx.get_peak_memory() / 2**30:.2f} GiB", flush=True)
    mx.save_safetensors(str(checkpoint), changed)


def export(checkpoint, original, output):
    weights = mx.load(str(checkpoint))
    manifest = json.loads(original.read_text())
    overlay = bytearray()
    records = []
    for shard in manifest["records"]:
        shard["dataPath"] = MLC + shard["dataPath"]
        untouched = []
        for record in shard["records"]:
            if record["name"] not in weights:
                untouched.append(record)
                continue
            weight = weights.pop(record["name"])
            if record["dtype"] != "float16" or list(weight.shape) != record["shape"]:
                raise ValueError(f"Unexpected dtype or shape: {record['name']}")
            data = np.asarray(weight, dtype="<f2").tobytes()
            if len(data) != record["nbytes"]:
                raise ValueError("Unexpected tensor byte count")
            records.append({**record, "byteOffset": len(overlay)})
            overlay.extend(data)
        shard["records"] = untouched
    if weights or len(records) != 113 or len(overlay) != 131072:
        raise ValueError("Incomplete normalization overlay")

    digest = hashlib.sha256(overlay).hexdigest()
    target = output / digest[:16]
    target.mkdir(parents=True, exist_ok=True)
    (target / "norms.bin").write_bytes(overlay)
    manifest["records"].append({
        "dataPath": "norms.bin", "format": "raw-shard", "nbytes": len(overlay),
        "records": records, "md5sum": hashlib.md5(overlay).hexdigest(),
    })
    # Keep record-level Git diffs readable for this generated manifest.
    lines = ['{"metadata":' + json.dumps(manifest["metadata"]) + ',"records":[']
    for shard in manifest["records"]:
        headers = {key: val for key, val in shard.items() if key != "records"}
        lines.append(json.dumps(headers)[:-1] + ',"records":[')
        lines.append(",\n".join(json.dumps(record) for record in shard["records"]))
        lines.append("]},")
    lines[-1] = "]}"
    (target / "tensor-cache.json").write_text("\n".join(lines) + "]}\n")
    print(f"Overlay SHA-256 {digest}\nExported {target}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("work", type=Path, help="Scratch directory for downloaded model and checkpoint")
    parser.add_argument("output", type=Path, help="WebLLM overlay output directory")
    parser.add_argument("--export-only", action="store_true", help="Reuse the saved trained checkpoint")
    args = parser.parse_args()
    base = args.work / "base"
    original = args.work / "tensor-cache.json"
    checkpoint = args.work / "norms.safetensors"
    download(MLC + original.name, original)
    if not args.export_only:
        for name in ("config.json", "tokenizer.json", "tokenizer_config.json"):
            download(QWEN + name, base / name)
        tune(base, original, checkpoint)
    export(checkpoint, original, args.output)


if __name__ == "__main__":
    main()
