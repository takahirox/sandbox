"""Train a next-token GRU on the local quiz teacher and export rowwise int8 weights."""
import argparse
import json
from pathlib import Path
import struct
import subprocess

import torch
from torch import nn
from torch.nn import functional as F


HERE = Path(__file__).resolve().parent
ASSET = HERE.parents[1] / "projects" / "kids-ai-quiz" / "quiz-gru-v1.bin"
SPECIAL = ["<pad>", "<start>", "<end>", "\n"]
EMBEDDING = 48
HIDDEN = 96


class LanguageModel(nn.Module):
    def __init__(self, size):
        super().__init__()
        self.embedding = nn.Embedding(size, EMBEDDING)
        self.gru = nn.GRU(EMBEDDING, HIDDEN, batch_first=True)
        self.output = nn.Linear(HIDDEN, size)

    def forward(self, tokens):
        hidden, _ = self.gru(self.embedding(tokens))
        return self.output(hidden)


def encode(rows):
    tokens = [["<start>", *" \n ".join(row).split(" "), "<end>"] for row in rows]
    vocab = SPECIAL + sorted({word for row in tokens for word in row} - set(SPECIAL))
    index = {word: i for i, word in enumerate(vocab)}
    length = max(map(len, tokens))
    encoded = torch.tensor([[index[w] for w in row] + [0] * (length - len(row)) for row in tokens])
    return vocab, encoded


def export(model, vocab, path):
    def floats(tensor):
        values = tensor.detach().cpu().flatten().tolist()
        return struct.pack(f"<{len(values)}f", *values)

    def matrix(tensor):
        tensor = tensor.detach().cpu()
        scales = tensor.abs().amax(dim=1).clamp(min=1e-8) / 127
        weights = (tensor / scales[:, None]).round().clamp(-127, 127).to(torch.int8)
        return floats(scales) + bytes(value & 255 for value in weights.flatten().tolist())

    meta = json.dumps(vocab, ensure_ascii=False, separators=(",", ":")).encode()
    weights = [
        matrix(model.embedding.weight), matrix(model.gru.weight_ih_l0), matrix(model.gru.weight_hh_l0),
        floats(model.gru.bias_ih_l0), floats(model.gru.bias_hh_l0),
        matrix(model.output.weight), floats(model.output.bias),
    ]
    path.write_bytes(struct.pack("<4sIHH", b"QGR1", len(meta), EMBEDDING, HIDDEN) + meta + b"".join(weights))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--steps", type=int, default=3200)
    parser.add_argument("--device", choices=["cpu", "mps"], default="cpu")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--output", type=Path, default=ASSET)
    args = parser.parse_args()

    torch.manual_seed(68)
    torch.set_num_threads(args.threads)
    rows = json.loads(subprocess.check_output(["node", str(HERE / "dataset.mjs")]))
    vocab, encoded = encode(rows)
    encoded = encoded.to(args.device)
    model = LanguageModel(len(vocab)).to(args.device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.003)
    print(f"{len(rows)} rows, {len(set(map(tuple, rows)))} unique, {len(vocab)} tokens, "
          f"{sum(p.numel() for p in model.parameters())} parameters", flush=True)

    for step in range(1, args.steps + 1):
        indexes = torch.randint(len(rows), (96,), device=args.device)
        batch = encoded[indexes]
        predicted = model(batch[:, :-1])
        loss = F.cross_entropy(predicted.flatten(0, 1), batch[:, 1:].flatten(), ignore_index=0)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        if step == 1 or step % 200 == 0 or step == args.steps:
            print(f"step {step:4} loss {loss.item():.4f}", flush=True)
    export(model, vocab, args.output)


if __name__ == "__main__":
    main()
