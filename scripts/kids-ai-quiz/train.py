"""Train the quiz token generator and export a one-page WebAssembly model."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import struct
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().parent
MODEL = ROOT / "projects/kids-ai-quiz/quiz-model-v2.wasm"
STAGES = 4


def feature_rows(stage, topic, first, topic_count):
    rows = [stage, (topic + 1) * STAGES + stage]
    if stage == 2:
        rows.append((topic_count + 1) * STAGES + first)
    return rows


def update(weights, rows, size, token, rate, negative=False):
    scores = [sum(weights[row][i] for row in rows) for i in range(size)]
    peak = max(scores)
    probabilities = [math.exp(score - peak) for score in scores]
    total = sum(probabilities)
    probabilities = [p / total for p in probabilities]
    if negative:
        # Gradient of log(1 - P(rejected token)).
        p = min(probabilities[token], 0.999999)
        rate *= -0.3 * p / (1 - p)
    delta = [rate * ((i == token) - p) for i, p in enumerate(probabilities)]
    for row in rows:
        for i in range(size):
            weights[row][i] += delta[i]


def train(weights, records, limits, topic_count, epochs, rate, seed):
    indices = list(range(len(records)))
    rng = random.Random(seed)
    for epoch in range(epochs):
        rng.shuffle(indices)
        for index in indices:
            example = records[index]
            topic, tokens = example["topic"], example["tokens"]
            for stage, token in enumerate(tokens):
                rows = feature_rows(stage, topic, tokens[1], topic_count)
                update(weights, rows, limits[stage], token, rate / (1 + epoch / 5))
            for stage, token in example.get("negatives", []):
                rows = feature_rows(stage, topic, tokens[1], topic_count)
                update(weights, rows, limits[stage], token, rate / (1 + epoch / 5), negative=True)


def compile_model(weights, topic_count, destination):
    packed = b"".join(struct.pack("<f", weight) for row in weights for weight in row)
    data = "".join(f"\\{byte:02x}" for byte in packed)
    source = (SOURCE / "model.wat").read_text().replace("@WEIGHTS@", data)
    source = source.replace("@HISTORY_BASE@", str((topic_count + 1) * STAGES))
    with tempfile.TemporaryDirectory() as folder:
        wat = Path(folder) / "model.wat"
        wat.write_text(source)
        subprocess.run(["wat2wasm", str(wat), "-o", str(destination)], check=True)
    artifact = destination.read_bytes()
    print(f"{destination.name}: {len(artifact)} bytes, sha256 {hashlib.sha256(artifact).hexdigest()}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=MODEL)
    parser.add_argument("--baseline", type=Path, help="also write the pre-adaptation model")
    args = parser.parse_args()
    data = json.loads(subprocess.check_output(["node", str(SOURCE / "dataset.mjs")]))
    limits, topic_count = data["limits"], data["topicCount"]
    width = max(limits)
    weights = [[0.0] * width for _ in range((topic_count + 1) * STAGES + width)]

    train(weights, data["baseline"], limits, topic_count, epochs=6, rate=0.025, seed=640)
    if args.baseline:
        compile_model(weights, topic_count, args.baseline.resolve())
    train(weights, data["adaptation"], limits, topic_count, epochs=12, rate=0.035, seed=641)
    compile_model(weights, topic_count, args.output.resolve())
    print(f"Training examples: {len(data['baseline'])} general + {len(data['adaptation'])} child quiz")


if __name__ == "__main__":
    main()
