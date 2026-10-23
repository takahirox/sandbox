Synthetic speech fixtures, generated locally with macOS `say` (no microphone):

- `japanese.wav`: Kyoko, “今日は公園で猫を見ました。猫はとてもかわいいです。”
- `english.wav`: Samantha, “Today I made a cup of coffee. I love the smell of fresh coffee.”
- `ja-discovery.wav`: Kyoko, “コーヒーの苦味が減りました。温度を下げたのが理由かな。皆さんはどう思いますか？”
- `en-discovery.wav`: Samantha, “Lowering the water temperature fixed my bitter coffee! Why does that work? What would you try next?”
- `ja-quiet.wav`: Kyoko, “今日は静かにお茶を飲んでいます。少し休みます。”
- `en-quiet.wav`: Samantha, “I am having some tea today. I will take a little break.”

16 kHz, mono, signed 16-bit PCM WAV. They contain no user recordings or personal
information. The original two fixtures are unchanged. The four new fixtures use
Kyoko/Samantha at 190 words/minute:

```sh
say -v Kyoko -r 190 --file-format=WAVE --data-format=LEI16@16000 -o ja-discovery.wav 'コーヒーの苦味が減りました。温度を下げたのが理由かな。皆さんはどう思いますか？'
```

`topics.json` contains the exact speech, language, topic patterns and activity
categories. Tests use the first six seconds, matching the production audio window.
The quiet fixtures are real speech; silence tests use zero-filled audio.

`baseline/` snapshots `config.mjs` and `inference.mjs` from repository commit
`fdacade` (before issue #50). These are evaluation-only, never shipped in the demo.
`compare-worker.mjs` runs that baseline and the production inference code against
pinned public model assets. `comparison*.json` records synthetic transcripts, raw
model replies, filtered replies, load/inference timings and sampled browser RSS.
Only the benchmark records transcripts; the production Worker never sends them to
the UI or persists them. The opt-in scripts never request camera/microphone access.

See `projects/ai-livestream/MODEL-EVALUATION.md` for the interpretation, exact
model pins, limitations and reproduction commands. Model outputs are stochastic;
the final revised run seeds sampling with 42. Some earlier exploratory runs were
unseeded. Scheduler randomness is injected separately to exercise all six topics.
