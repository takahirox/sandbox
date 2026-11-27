"""Train a livestream LoRA adapter over the pinned Japanese Qwen3 GGUF shards."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import random
import re
import subprocess
from time import perf_counter
from urllib.request import urlretrieve

import gguf
import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
from mlx_lm.models.qwen3 import Model, ModelArgs
import numpy as np
from transformers import AutoTokenizer

SOURCE = Path(__file__).resolve().parent
QWEN = "https://huggingface.co/Qwen/Qwen3-0.6B/resolve/c1899de289a04d12100db370d81485cdf75e47ca/"
WBD = "https://huggingface.co/webbigdata/Qwen3-0.6B_WBD/resolve/789a31e3011376f1c5f1ace071ba81f39ed20b5a/"
SOURCE_SHA256 = {
    "config.json": "660db3b73d788119c04535e48cf9be5f55bc3100841a718637ae695b442f27dd",
    "tokenizer.json": "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
    "tokenizer_config.json": "d5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101",
    "Q8_0-00001-of-00002.gguf": "6991c038064ba0a9742b64500e4d282d8f0d003e358409ffef8b24d9e8f8ee12",
    "Q8_0-00002-of-00002.gguf": "bfb73f1597257eca62361f4f88a635e192b95a2efe2505104fb04f3a699404b2",
}
SHARDS = ("Q8_0-00001-of-00002.gguf", "Q8_0-00002-of-00002.gguf")
SEED = 62
BATCH_SIZE = 4
EPOCHS = 4
LR = 0.0003
LORA_LAYERS = range(20, 28)
RANK = 8
ALPHA = RANK


class LoraLinear(nn.Module):
    def __init__(self, linear):
        super().__init__()
        self.weight = linear.weight
        out_dim, in_dim = self.weight.shape
        bound = in_dim ** -0.5
        self.a = mx.random.uniform(-bound, bound, (RANK, in_dim), dtype=mx.float32)
        self.b = mx.zeros((out_dim, RANK), dtype=mx.float32)

    def __call__(self, x):
        update = (x @ self.a.astype(x.dtype).T) @ self.b.astype(x.dtype).T
        return x @ self.weight.T + (ALPHA / RANK) * update

def download(url, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        partial = path.with_suffix(".download")
        urlretrieve(url, partial)
        partial.replace(path)
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != SOURCE_SHA256[path.name]:
        raise ValueError(f"Unexpected SHA-256 for {path}")


def mlx_name(gguf_name):
    if gguf_name == "token_embd.weight":
        return "model.embed_tokens.weight"
    if gguf_name == "output_norm.weight":
        return "model.norm.weight"
    match = re.fullmatch(r"blk\.(\d+)\.(\w+)\.weight", gguf_name)
    if not match:
        raise ValueError(f"Unrecognized tensor {gguf_name}")
    i, name = match.groups()
    suffix = {
        "attn_q": "self_attn.q_proj", "attn_k": "self_attn.k_proj", "attn_v": "self_attn.v_proj",
        "attn_output": "self_attn.o_proj", "attn_q_norm": "self_attn.q_norm",
        "attn_k_norm": "self_attn.k_norm", "attn_norm": "input_layernorm",
        "ffn_norm": "post_attention_layernorm", "ffn_gate": "mlp.gate_proj",
        "ffn_up": "mlp.up_proj", "ffn_down": "mlp.down_proj",
    }[name]
    return f"model.layers.{i}.{suffix}.weight"

def load_gguf_model(base, shards):
    args = ModelArgs.from_dict(json.loads((base / "config.json").read_text()))
    model = Model(args)
    model.eval()
    weights = []
    for path in shards:
        reader = gguf.GGUFReader(path)
        for tensor in reader.tensors:
            name = mlx_name(tensor.name)
            value = gguf.dequantize(tensor.data, tensor.tensor_type)
            weights.append((name, mx.array(value.astype(np.float16))))
    model.load_weights(weights)
    mx.eval(model.parameters())
    return model

def lora_modules(model):
    for index in LORA_LAYERS:
        layer = model.layers[index]
        yield layer.mlp, "down_proj", f"blk.{index}.ffn_down.weight"
        yield layer.self_attn, "o_proj", f"blk.{index}.attn_output.weight"

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


def tune(base, shards, output):
    mx.random.seed(SEED)
    rng = random.Random(SEED)
    model = load_gguf_model(base, shards)
    tokenizer = AutoTokenizer.from_pretrained(base, local_files_only=True)
    modules = []
    for parent, key, name in lora_modules(model):
        module = LoraLinear(getattr(parent, key))
        setattr(parent, key, module)
        modules.append((name, module))
    model.freeze()
    for _, module in modules:
        module.unfreeze(keys=["a", "b"])

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
    print(f"Metal peak allocator memory: {mx.get_peak_memory() / 2**30:.2f} GiB", flush=True)
    writer = gguf.GGUFWriter(output, "qwen3")
    writer.add_type(gguf.GGUFType.ADAPTER)
    writer.add_string(gguf.Keys.Adapter.TYPE, "lora")
    writer.add_float32(gguf.Keys.Adapter.LORA_ALPHA, ALPHA)
    for name, module in modules:
        for suffix, array in (("lora_a", module.a), ("lora_b", module.b)):
            if not mx.all(mx.isfinite(array)).item() or not mx.any(array != 0).item():
                raise ValueError("Invalid trained LoRA matrix")
            writer.add_tensor(f"{name}.{suffix}", np.asarray(array, dtype=np.float16))
    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("work", type=Path, help="Scratch directory for pinned downloads")
    parser.add_argument("output", type=Path, help="Output path for the trained GGUF adapter")
    args = parser.parse_args()
    base = args.work / "base"
    for name in ("config.json", "tokenizer.json", "tokenizer_config.json"):
        download(QWEN + name, base / name)
    shards = [args.work / name for name in SHARDS]
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda path: download(WBD + path.name, path), shards))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    tune(base, shards, args.output)


if __name__ == "__main__":
    main()
