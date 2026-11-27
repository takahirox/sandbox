// Original, closed vocabulary. Each topic's choices represent distinct answers.
// A clue refers to exactly one of those choices in the context of that topic.
export const topics = [
  {
    id: 'animals', picture: '♪', forms: [
      '{clue} なくのは？', '「{clue}」って なくのは だれ？', '{clue}！ だれの こえ？',
      '「{clue}」と鳴く動物はどれですか？', '鳴き声「{clue}」に当てはまる動物を選びなさい。', '次のうち「{clue}」と鳴くのはどの動物でしょうか。',
    ],
    facts: [
      ['dog', 'いぬ', '🐕', 'わんわん', 'pet'],
      ['cat', 'ねこ', '🐈', 'にゃあにゃあ', 'pet'],
      ['pig', 'ぶた', '🐖', 'ぶうぶう', 'barn'],
      ['cow', 'うし', '🐄', 'もーもー', 'barn'],
      ['duck', 'あひる', '🦆', 'があがあ', 'bird'],
      ['sheep', 'ひつじ', '🐑', 'めえめえ', 'barn'],
      ['rooster', 'にわとり', '🐓', 'こけこっこー', 'bird'],
    ],
  },
  {
    id: 'food', picture: '🍴', forms: [
      '{clue}は どれ？', '{clue}。なんの たべもの？', 'どれかな？ {clue}。',
      '「{clue}」に当てはまる食品はどれですか？', '次の説明に該当する食品を選びなさい。{clue}。', '「{clue}」とはどの食品を指すでしょうか。',
    ],
    facts: [
      ['banana', 'ばなな', '🍌', 'かわが きいろくて ながい くだもの', 'fruit'],
      ['apple', 'りんご', '🍎', 'きに なる しゃりしゃりの くだもの', 'fruit'],
      ['rice-ball', 'おにぎり', '🍙', 'ごはんを ぎゅっと にぎった たべもの', 'savory'],
      ['pizza', 'ぴざ', '🍕', 'ちーずを のせて やく まるい たべもの', 'savory'],
      ['doughnut', 'どーなつ', '🍩', 'まんなかに あなが ある おかし', 'snack'],
      ['strawberry', 'いちご', '🍓', 'あかくて つぶつぶの くだもの', 'fruit'],
      ['corn', 'とうもろこし', '🌽', 'きいろい つぶが ならんだ やさい', 'savory'],
    ],
  },
  {
    id: 'vehicles', picture: '🛞', forms: [
      '{clue}のは？', '{clue} のりものは どれ？', 'どれが {clue}？',
      '「{clue}」乗り物はどれですか？', '次のうち「{clue}」乗り物を選びなさい。', '「{clue}」乗り物はどれでしょうか。',
    ],
    facts: [
      ['train', 'でんしゃ', '🚃', 'せんろを はしる', 'road'],
      ['plane', 'ひこうき', '✈️', 'つばさで そらを とぶ', 'travel'],
      ['boat', 'ふね', '⛵', 'みずに うかんで すすむ', 'travel'],
      ['bicycle', 'じてんしゃ', '🚲', 'ぺだるを こいで すすむ', 'road'],
      ['bus', 'ばす', '🚌', 'まちの みちで たくさんの ひとを のせる', 'road'],
      ['fire-engine', 'しょうぼうしゃ', '🚒', 'かじの ひを けしに いく', 'help'],
      ['ambulance', 'きゅうきゅうしゃ', '🚑', 'けがを した ひとを びょういんへ はこぶ', 'help'],
    ],
  },
  {
    id: 'colors', forms: [
      'おなじ いろは どれ？', 'おなじ いろを さがそう。', 'これと おなじ いろは？',
      '同じ色の選択肢を選びなさい。', '見本と一致する色はどれですか？', '提示された色と同一のものはどれでしょうか。',
    ],
    facts: [
      ['red', 'あか', 'red', '', 'warm'],
      ['blue', 'あお', 'blue', '', 'cool'],
      ['yellow', 'きいろ', 'yellow', '', 'warm'],
      ['green', 'みどり', 'green', '', 'cool'],
      ['purple', 'むらさき', 'purple', '', 'cool'],
      ['orange', 'おれんじ', 'orange', '', 'warm'],
      ['pink', 'ぴんく', 'pink', '', 'warm'],
    ],
  },
  {
    id: 'shapes', forms: [
      'おなじ かたちは どれ？', 'おなじ かたちを さがそう。', 'これと おなじ かたちは？',
      '同じ形の選択肢を選びなさい。', '見本と一致する図形はどれですか？', '提示された図形と同一のものはどれでしょうか。',
    ],
    facts: [
      ['circle', 'まる', '●', '', 'round'],
      ['triangle', 'さんかく', '▲', '', 'corner'],
      ['square', 'しかく', '■', '', 'corner'],
      ['star', 'ほし', '★', '', 'point'],
      ['heart', 'はーと', '♥', '', 'point'],
      ['diamond', 'ひしがた', '◆', '', 'corner'],
      ['oval', 'だえん', 'oval', '', 'round'],
    ],
  },
  {
    id: 'counting', forms: [
      'りんごは いくつ？', 'りんごは なんこ ある？', 'りんごを かぞえよう。',
      'りんごの個数はいくつですか？', '提示されたりんごの個数を選びなさい。', '表示された果実の総数を求めなさい。',
    ],
    facts: Array.from({ length: 7 }, (_, index) => {
      const number = String(index + 1);
      return ['apples-' + number, number, '', '', index < 3 ? 'low' : 'high'];
    }),
  },
  {
    id: 'routines', picture: '☀️', forms: [
      '{clue}のに つかうのは？', '{clue}とき、なにを つかう？', '{clue}よ。どれを つかう？',
      '「{clue}」際に用いる道具は何ですか？', '「{clue}」用途に適した物を選びなさい。', '次のうち「{clue}」ための道具はどれでしょうか。',
    ],
    facts: [
      ['toothbrush', 'はぶらし', '🪥', 'はを みがく', 'wash'],
      ['umbrella', 'かさ', '☂️', 'あめを よける', 'out'],
      ['spoon', 'すぷーん', '🥄', 'すーぷを すくう', 'home'],
      ['towel', 'たおる', '▰', 'ぬれた からだを ふく', 'wash'],
      ['shoes', 'くつ', '👟', 'そとで あしを まもる', 'out'],
      ['ball', 'ぼーる', '⚽', 'けって あそぶ', 'out'],
      ['clock', 'とけい', '🕒', 'いまの じかんを しる', 'home'],
    ],
  },
].map(({ facts, ...topic }, topicIndex) => ({
  ...topic,
  facts: facts.map(([id, label, icon, clue, family]) => ({ id, label, icon, clue, family, topic: topicIndex })),
}));

export const facts = topics.flatMap(topic => topic.facts);
export const starter = topics[0].facts[0];

export function distractorPool(fact) {
  const sameTopic = topics[fact.topic].facts;
  const index = sameTopic.indexOf(fact);
  const rotated = [...sameTopic.slice(index + 1), ...sameTopic.slice(0, index)];
  // Prefer a related subgroup, or a nearby number in a counting question.
  const distance = other => fact.topic === 5 ? Math.abs(fact.label - other.label) : Number(fact.family !== other.family);
  const related = rotated.sort((a, b) => distance(a) - distance(b)).slice(0, 5);
  const crossTopic = [1, 2].map(offset => topics[(fact.topic + offset) % topics.length].facts[index]);
  return [...related, ...crossTopic, fact];
}
