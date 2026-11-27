// Independent rubric for rendered questions. The first two fields identify the
// topic and the evidence shown to the player. The remaining labels all satisfy it.
export const benchmarkAnswers = {
  cat: ['animals', 'にゃあにゃあ', 'ねこ'],
  sheep: ['animals', 'めえめえ', 'ひつじ'],
  strawberry: ['food', 'あかくて つぶつぶ', 'いちご'],
  corn: ['food', 'きいろい つぶが ならんだ', 'とうもろこし'],
  plane: ['vehicles', 'つばさで そらを とぶ', 'ひこうき'],
  'fire-engine': ['vehicles', 'みちを はしって かじの ひを けしに いく', 'しょうぼうしゃ'],
  yellow: ['colors', 'yellow', 'きいろ'],
  purple: ['colors', 'purple', 'むらさき'],
  triangle: ['shapes', '▲', 'さんかく'],
  oval: ['shapes', 'oval', 'だえん'],
  'apples-4': ['counting', 4, '4'],
  'apples-7': ['counting', 7, '7'],
  umbrella: ['routines', 'あめの ひに さす', 'かさ'],
  clock: ['routines', 'いまの じかんが わかる', 'とけい'],
};

const rules = [
  ...Object.values(benchmarkAnswers),
  ['routines', 'けって あそぶ', 'ぼーる', 'くつ'],
  ['routines', 'けると ころがる まるい', 'ぼーる'],
];

export function independentAnswers(item) {
  const rule = rules.find(([topic, evidence]) => {
    if (topic !== item.topic) return false;
    if (topic === 'counting') return item.clue.count === evidence;
    if (topic === 'colors' || topic === 'shapes') return item.clue.icon === evidence;
    return item.question.includes(evidence);
  });
  const labels = rule?.slice(2) ?? [];
  return item.choices.filter(choice => labels.includes(choice.label));
}
