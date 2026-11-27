"""Draft fictional training examples with the cached Apache-2.0 Gemma teacher."""

import argparse
import json
from pathlib import Path
import random
from time import perf_counter

import mlx.core as mx
from mlx_lm import batch_generate, load
from mlx_lm.sample_utils import make_sampler

SOURCE = Path(__file__).resolve().parent
REVISION = "535c5606372deb5d5ab7e29280f111ef2a8e084e"
VOICES = (
    "短い具体的な質問。答えを決めつけない",
    "見どころに短く反応。驚き、共感、軽いツッコミなど",
    "話に絡めた自分の好みや気持ちを一言。経験をでっち上げない",
    "前後の変化や違いに短く反応。分からない結果は断定しない",
)
BEATS = (
    "前に失敗したやり方から一つだけ変えた",
    "途中で予定を変えた、または言い間違いを自分で訂正した",
    "小さな発見や意外な結果を雑談で話す",
    "まだ決めていない選択、練習中のこと、または困ったことを相談する",
)
BEATS_EN = (
    "changing one part of a method after trying it before",
    "changing the plan or correcting yourself mid-thought",
    "noticing a small surprise or an unexpected result",
    "an undecided choice, something you're practicing, or a minor snag",
)
VOICES_EN = (
    "one specific short follow-up question with no presumption",
    "a short spontaneous reaction, gentle joke, or empathetic aside",
    "a topical preference or feeling, with no invented personal anecdote",
    "a casual reaction to a contrast or change without assuming the result",
)

EXAMPLES = {
    "ja": (
        "以下の形式で、架空の雑談配信の発言と視聴者コメントを作って。題材は魚の缶詰。",
        "- | さば缶だと思って開けたらいわしだった。もうパスタ茹でちゃったよ。 | いわしパスタも普通に食べたいｗ\n"
        "- | 塩ふる前にツナ缶入れたら、もうそれだけでちょうどよかった。 | ツナってオイルごと入れた？\n"
        "いわし缶をトーストにのせてみたよ。 | あの汁だけは、パンがふやけるから切った。 | カリカリのままがいい派だわ",
    ),
    "en": (
        "Write three fictional livestream lines in the requested format. Topic: spare buttons.",
        "- | I opened the tin looking for a shirt button and found a Lego tire in there. | The button tin lore runs deep lol\n"
        "- | I found a button that fits! Wrong shade of green, though. | Is it close enough with the jacket on?\n"
        "I'm sorting my spare buttons by color. | Actually, no, by size. I can spot the color myself. | I'd sort by size too, way easier",
    ),
}

def prompt(topic, beat, voice, language):
    if language == "en":
        return (
            f"Write eight independent fictional casual livestream snippets about {topic}. "
            f"Situation: {BEATS_EN[beat]}. Write everything in spoken English. "
            "Use different specific details, people-free settings and sentence rhythms. "
            "Each row: earlier speech (or - if standalone) | latest speech (about 1 sentence) | chat reply. "
            "Include two or three fragments that make sense with the earlier turn; keep other rows standalone. "
            f"Viewer style: {VOICES_EN[voice]}. "
            "No invented observation, fact, outcome, identities or boilerplate. Reply with a single lively "
            "short chat message, not a summary or an assistant answer. Plain rows only, no headings or numbering."
        )
    return (
        f"日本語の雑談配信の架空の発言と視聴者コメントの組を8行。題材は「{topic}」、切り口は「{BEATS[beat]}」。"
        "8行とも別の配信の話として、出来事、具体的な物や状況、文のリズムを変える。"
        "形式：前の発言（ない場合は -）| 今の発言（口に出して自然な一息）| コメント（一言）。"
        "ときどき言い直し、話題転換、言いさし、前の一言がないと意味が通らない発言も入れる。"
        f"視聴者の口調：{VOICES[voice]}。匿名の普通のチャットの口語で、敬語や「ね」の連発を避ける。"
        "発言の受け売り、毎回同じ書き出し、映像・原因・人物・出来事の創作は禁止。"
        "返答は一言だけ。行の番号や解説、見出し、コード枠は不要。"
    )

def messages(row):
    language = row["language"]
    example_prompt, answer = EXAMPLES[language]
    return [
        {"role": "user", "content": example_prompt},
        {"role": "assistant", "content": answer},
        {"role": "user", "content": prompt(row["topic"], row["beat"], row["voice"], language)},
    ]


def jobs():
    work = []
    for line in (SOURCE / "expanded-topics.txt").read_text().splitlines():
        domain, topics = line.split("|")
        for index, topic in enumerate(topics.split(",")):
            for beat in range(len(BEATS)):
                language = "en" if (index + beat * 2) % 7 == 0 else "ja"
                work.append(dict(domain=domain, topic=topic, beat=beat,
                                 voice=(index + beat) % len(VOICES),
                                 language=language))
    random.Random(62).shuffle(work)
    return work


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("teacher", type=Path, help="Directory of the pinned local snapshot")
    parser.add_argument("output", type=Path)
    parser.add_argument("--prompts", type=int, default=240,
                        help="Maximum prompts in the seeded sequence")
    args = parser.parse_args()
    if args.prompts < 1:
        parser.error("--prompts must be positive")
    if args.teacher.name != REVISION or not (args.teacher / "config.json").is_file():
        raise ValueError(f"Provide the local teacher snapshot {REVISION}")
    work = jobs()[:args.prompts]
    mx.random.seed(62)
    started = perf_counter()
    model, tokenizer = load(args.teacher)
    with args.output.open("x", encoding="utf-8") as out:
        for offset in range(0, len(work), 16):
            batch = work[offset:offset + 16]
            prompts = [tokenizer.apply_chat_template(
                messages(row),
                tokenize=False, add_generation_prompt=True, enable_thinking=False,
            ) for row in batch]
            tokens = [tokenizer.encode(text, add_special_tokens=False) for text in prompts]
            result = batch_generate(model, tokenizer, tokens, max_tokens=400,
                                    completion_batch_size=16, prefill_batch_size=4,
                                    sampler=make_sampler(temp=0.50, top_p=0.9))
            for row, reply in zip(batch, result.texts, strict=True):
                print(json.dumps({**row, "draft": reply}, ensure_ascii=False), file=out)
            out.flush()
            print(f"{offset + len(batch)}/{len(work)} prompts, {perf_counter() - started:.1f}s, "
                  f"{result.stats.generation_tps:.1f} generated tokens/s", flush=True)


if __name__ == "__main__":
    main()
