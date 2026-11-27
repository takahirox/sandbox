"""Curate a frozen local draft file and check transcript separation."""

import argparse
from collections import Counter, defaultdict
from hashlib import sha256
import json
import math
from pathlib import Path
import re
import unicodedata

SOURCE = Path(__file__).resolve().parent
FIXTURES = SOURCE.parents[1] / "tests/fixtures/ai-livestream"
JA = re.compile(r"[ぁ-ヿ一-龯]")
KANA = re.compile(r"[ぁ-ヿ]")
OTHER_SCRIPT = re.compile(r"[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3\u0400-\u052f]")
UNSUITABLE = re.compile(
    r"https?://|@|\b(?:password|kill|nude|porn|suicide|fuck|idiot|stupid|doxx)\b|"
    r"住所|電話番号|個人情報|本名|死ね|殺す|エロ|裸|バカ|馬鹿|自殺|クソ", re.I,
)
BOILERPLATE = re.compile(
    r"^(?:コメント|視聴者|返答|配信者|発言|reaction|reply|comment|viewer)\s*[:：]|"
    r"^.{0,70}(?:ですね[!！。?？]*$|でしょうか[?？。]*$|(?:素晴らしい|すばらしい)ですね)|"
    r"^(?:なるほど|いいね|すごい|おお+|楽しそう|確かに)[ wｗ!！？?。]*$|"
    r"^(?:nice|cool|great|awesome|interesting|wow)[!. ]*$", re.I,
)
UNSUPPORTED_VIEW = re.compile(
    r"^looks? (?:like|[a-z]+)|\byou look\b|\bI can see (?:you|your)\b|"
    r"\byour (?:face|outfit)\b|顔が|髪型|笑顔|画面に映", re.I,
)
DECORATION = re.compile(r"^\s*(?:\d+[.)、:]\s*|[-*•](?!\s*\|)\s+)")


def key(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum())


def shingles(text):
    return frozenset(text[i:i + 3] for i in range(max(1, len(text) - 2))) if text else frozenset()


class SimilarityIndex:
    """Find exact character-trigram Jaccard matches using an ordered prefix index."""

    def __init__(self, texts, threshold):
        self.threshold = threshold
        self.frequency = Counter(gram for text in texts for gram in shingles(text))
        self.prefixes = defaultdict(list)

    def prefix(self, grams):
        return sorted(grams, key=lambda gram: (self.frequency[gram], gram))[
            :len(grams) - math.ceil(self.threshold * len(grams)) + 1
        ]

    def matches(self, text):
        if not text:
            return False
        grams = shingles(text)
        seen = set()
        for gram in self.prefix(grams):
            for other in self.prefixes[gram]:
                if other not in seen:
                    seen.add(other)
                    if min(len(grams), len(other)) >= self.threshold * max(len(grams), len(other)):
                        if len(grams & other) / len(grams | other) >= self.threshold:
                            return True
        return False

    def add(self, text):
        grams = shingles(text)
        for gram in self.prefix(grams):
            self.prefixes[gram].append(grams)


def reserved_transcripts():
    for name in ("tuning-holdout.json", "follow-up-holdout.json", "expanded-holdout.json"):
        for row in json.loads((FIXTURES / name).read_text()):
            yield from (turn for turn in row["turns"] if turn)
    for name in ("topics.json", "tuning-audio.json"):
        for fixture in json.loads((FIXTURES / name).read_text()):
            yield fixture["text"]


def teacher_rows(path, rejected):
    for index, line in enumerate(path.read_text().splitlines()):
        draft = json.loads(line)
        for line_index, line in enumerate(draft["draft"].splitlines()):
            if not line.strip():
                continue
            fields = DECORATION.sub("", line).strip().split("|")
            if len(fields) == 5 and not fields[0] and not fields[-1]:
                fields = fields[1:-1]
            if len(fields) != 3:
                rejected["format"] += 1
                continue
            earlier, speech, reply = (part.strip().strip('「」"').strip() for part in fields)
            if earlier in {"-", "－", "—", "なし", "None"}:
                earlier = ""
            yield dict(id=f"draft-{index:03}-{line_index:02}", source="gemma-4-31b",
                       topic=draft["topic"], domain=draft["domain"], beat=draft["beat"],
                       language=draft["language"], voice=draft["voice"],
                       earlier=earlier, speech=speech, reply=reply)


def jsonl(rows):
    return "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows)


def draft_issue(row):
    earlier, speech, reply = (row[k] for k in ("earlier", "speech", "reply"))
    context = earlier + " " + speech
    if not (6 <= len(key(speech)) <= 165 and 2 <= len(key(reply)) <= 90 and len(earlier) <= 180):
        return "length"
    if any(re.search(r"[<>\[\]{}]|\*\*|\ufffd", value) for value in (earlier, speech, reply)):
        return "format"
    if OTHER_SCRIPT.search(context + reply):
        return "language"
    if row["language"] == "ja":
        if any(value and not KANA.search(value) for value in (earlier, speech, reply)) or len(reply) > 48:
            return "language_or_length"
    elif JA.search(context + reply) or len(reply.split()) > 17:
        return "language_or_length"
    if BOILERPLATE.search(reply) or re.search(r"(?i)^(?:SKIP|N/A)$", reply):
        return "chat_style"
    if UNSUITABLE.search(context + reply):
        return "inappropriate"
    if UNSUPPORTED_VIEW.search(reply) or set(re.findall(r"\d+", reply)) - set(re.findall(r"\d+", context)):
        return "unsupported"
    if key(reply) in key(context) and len(key(reply)) >= 6:
        return "echo"
    if row["voice"] == 0 and not re.search(r"[?？]|(?:かな|の|か)$", reply):
        return "question_style"
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("drafts", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--review", type=Path, help="Audited draft IDs with verdicts")
    parser.add_argument("--screen", type=Path, help="Offline screening results for the first curation pass")
    args = parser.parse_args()
    rejected = Counter()
    authored = []
    for index, line in enumerate((SOURCE / "expanded-authored.txt").read_text().splitlines(), 1):
        language, voice, domain, earlier, speech, reply = line.split("|")
        authored.append(dict(id=f"authored-{index:02}", source="authored", domain=domain,
                             language=language, voice=int(voice), earlier=earlier, speech=speech, reply=reply))
    teachers = list(teacher_rows(args.drafts, rejected))
    old_speech = [row["speech"] for name in ("train.jsonl", "follow-up.jsonl")
                  for row in map(json.loads, (SOURCE / name).read_text().splitlines())]
    reserved = {key(speech) for speech in reserved_transcripts()}
    indexing_text = [key(row["speech"]) for row in authored + teachers]
    overlap = SimilarityIndex([*indexing_text, *reserved], 0.70)
    for text in reserved:
        overlap.add(text)

    existing = SimilarityIndex([*indexing_text, *map(key, old_speech)], 0.76)
    for text in old_speech:
        existing.add(key(text))
    replies = Counter()
    reply_index = SimilarityIndex([key(row["reply"]) for row in teachers], 0.86)
    rows = []
    reviewed = {}
    if args.review:
        audit = json.loads(args.review.read_text())
        if audit["draftsSha256"] != sha256(args.drafts.read_bytes()).hexdigest():
            raise ValueError("Audit refers to a different teacher draft file")
        reviewed = audit["verdicts"]
    if not reviewed.keys() <= {row["id"] for row in teachers}:
        raise ValueError("Review refers to missing draft IDs")
    for row in authored + teachers:
        speech = key(row["speech"])
        earlier = key(row["earlier"])
        reply = key(row["reply"])
        if speech in reserved or earlier in reserved or overlap.matches(speech) or overlap.matches(earlier):
            if row["source"] == "authored":
                raise ValueError(f"Authored row overlaps reserved transcripts: {row['id']}")
            rejected["evaluation_overlap"] += 1
            continue
        if row["source"] != "authored":
            issue = draft_issue(row)
            if issue:
                rejected[issue] += 1
                continue
            if existing.matches(speech):
                rejected["speech_near_duplicate"] += 1
                continue
            if replies[reply] >= 2 or len(reply) >= 12 and reply_index.matches(reply):
                rejected["reply_near_duplicate"] += 1
                continue
        rows.append(row)
        existing.add(speech)
        replies[reply] += 1
        if len(reply) >= 12:
            reply_index.add(reply)

    screened = {}
    if args.screen:
        screen = json.loads(args.screen.read_text())
        if screen["curatedSha256"] != sha256(jsonl(rows).encode()).hexdigest():
            raise ValueError("Screening results refer to a different curated file")
        screened = screen["verdicts"]
        teacher_ids = [row["id"] for row in rows if row["source"] != "authored"]
        if sorted(screened) != sorted(teacher_ids[:len(screened)]) or not set(screened.values()) <= set("PFSI?"):
            raise ValueError("Screening results must cover the first curated teacher rows")
    chosen = []
    for row in rows:
        if row["id"] in reviewed and reviewed[row["id"]] != "pass":
            rejected["manual_review"] += 1
        elif row["id"] not in reviewed and screened.get(row["id"], "P") != "P":
            rejected["teacher_screen"] += 1
        else:
            chosen.append(row)
    rows = chosen
    final_replies = {key(row["reply"]) for row in rows if row["reply"] != "SKIP"}

    args.output.write_text(jsonl(rows), encoding="utf-8")

    print(json.dumps({
        "draft_parsed": len(teachers), "rejected": rejected, "retained": len(rows),
        "source": Counter(row["source"] for row in rows),
        "language": Counter(row["language"] for row in rows),
        "domains": Counter(row["domain"] for row in rows),
        "topics": len({row["topic"] for row in rows if "topic" in row}),
        "voices": Counter(row["voice"] for row in rows),
        "context_rows": sum(bool(row["earlier"]) for row in rows),
        "questions": sum(bool(re.search(r"[?？]", row["reply"])) for row in rows),
        "skips": sum(row["reply"] == "SKIP" for row in rows),
        "distinct_speech": len({key(row["speech"]) for row in rows}),
        "distinct_non_skip_replies": len(final_replies),
        "reserved_transcripts": len(reserved),
        "audit": Counter(reviewed.values()),
        "screen": Counter(screened.values()),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
