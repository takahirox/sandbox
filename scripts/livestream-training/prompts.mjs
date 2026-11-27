// Reuse the production prompt, including its JSON quoting and four viewer voices.
import { readFileSync } from 'node:fs';
import { messagesFor } from '../../projects/ai-livestream/config.mjs';

const readRows = file => readFileSync(new URL(file, import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
const original = readRows('./train.jsonl');
const rows = process.argv[2] === '--follow-up'
  ? [...readRows('./follow-up.jsonl'), ...original.filter(row => row.language === 'en' || row.reply === 'SKIP')]
  : original;
for (const { language, voice, speech, earlier, avoid_repeating, reply } of rows) {
  const messages = messagesFor(speech, language, { voice, context: earlier, recent: avoid_repeating });
  console.log(JSON.stringify({ messages, reply }));
}
