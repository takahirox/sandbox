// Reuse the production prompt, including its JSON quoting and four viewer voices.
import { readFileSync } from 'node:fs';
import { messagesFor } from '../../projects/ai-livestream/config.mjs';

const rows = readFileSync(new URL('./train.jsonl', import.meta.url), 'utf8').trim().split('\n');
for (const row of rows) {
  const { language, voice, speech, earlier, avoid_repeating, reply } = JSON.parse(row);
  const messages = messagesFor(speech, language, { voice, context: earlier, recent: avoid_repeating });
  console.log(JSON.stringify({ messages, reply }));
}
