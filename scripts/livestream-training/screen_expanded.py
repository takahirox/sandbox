"""Use the offline teacher to screen synthetic draft replies in a second pass."""

import argparse
from hashlib import sha256
from itertools import batched
import json
from pathlib import Path
import re
from time import perf_counter

import mlx.core as mx
from mlx_lm import batch_generate, load

from draft_expanded import REVISION

INSTRUCTIONS = """Screen fictional Japanese and English livestream chat examples.
Each input row is [earlier speech, latest speech, viewer's proposed reply].
P = grounded, understandable short viewer chat. Allow casual slang, specific questions,
preference and figurative reactions. A modest generic reaction can fit an obvious moment.
F = adds or contradicts a concrete event, cause, visible fact, result, amount, time, person
or other detail unsupported by the speech. A genuine open question is okay.
S = vague for this utterance, missing referent, unnatural language, echoes the speech,
or sounds like an assistant instead of one brief viewer message.
I = intrusive, offensive or inappropriate. Classify every row independently.
Respond with one letter per row in order, separated by spaces. No other text.

Example:
["", "電車が来る前に切符買えた。", "間に合うとホッとするな"]
["", "I tried a different type of tape.", "The blue stuff sticks much better."]
["", "あれって……、もういいや。", "どうやって使うの？"]
["", "I shared the recipe.", "You're an idiot."]
Answer: P F S I

Rows to screen:
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("teacher", type=Path)
    parser.add_argument("examples", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--rows", type=int, default=512, help="Maximum teacher rows to screen")
    args = parser.parse_args()
    if args.rows < 1:
        parser.error("--rows must be positive")
    if args.teacher.name != REVISION or not (args.teacher / "config.json").is_file():
        raise ValueError(f"Provide the local teacher snapshot {REVISION}")
    examples = args.examples.read_bytes()
    rows = [row for row in map(json.loads, examples.splitlines())
            if row["source"] != "authored"][:args.rows]
    groups = list(batched(rows, 8))
    model, tokenizer = load(args.teacher)
    mx.set_cache_limit(1024 ** 3)
    scores = {}
    started = perf_counter()
    for offset in range(0, len(groups), 16):
        batch = groups[offset:offset + 16]
        prompts = []
        for group in batch:
            prompt = INSTRUCTIONS + "\n".join(
                json.dumps([row[k] for k in ("earlier", "speech", "reply")], ensure_ascii=False)
                for row in group
            )
            tokens = tokenizer.apply_chat_template(
                [{"role": "user", "content": prompt}],
                tokenize=False, add_generation_prompt=True, enable_thinking=False,
            )
            prompts.append(tokenizer.encode(tokens, add_special_tokens=False))
        result = batch_generate(model, tokenizer, prompts, max_tokens=36,
                                completion_batch_size=16, prefill_batch_size=4)
        for group, text in zip(batch, result.texts, strict=True):
            text = re.sub(r"^\s*Answer:\s*", "", text, flags=re.I)
            letters = re.sub(r"[\s,\[\].]+", "", text)
            if len(letters) != len(group) or not re.fullmatch(r"[PFSI]+", letters):
                letters = "?" * len(group)
            scores.update((row["id"], letter) for row, letter in zip(group, letters, strict=True))
        receipt = {"curatedSha256": sha256(examples).hexdigest(), "verdicts": scores}
        args.output.write_text(json.dumps(receipt, indent=2) + "\n")
        mx.clear_cache()
        print(f"{len(scores)}/{len(rows)} rows, {perf_counter() - started:.1f}s", flush=True)


if __name__ == "__main__":
    main()
