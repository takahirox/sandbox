// Each relation describes a closed set of contrasts. A group pairs an answer
// with the subjects for which it is true. Only answers in that relation can
// be offered, so a missing fact elsewhere does not become a distractor.
const animals = {
  dog: ['いぬ', '🐕'], cat: ['ねこ', '🐈'], pig: ['ぶた', '🐖'], cow: ['うし', '🐄'],
  duck: ['あひる', '🦆'], sheep: ['ひつじ', '🐑'], rooster: ['おんどり', '🐓'],
  rabbit: ['うさぎ', '🐇'], owl: ['ふくろう', '🦉'], sparrow: ['すずめ', '🐦'],
  swallow: ['つばめ', '🐦'], chicken: ['にわとり', '🐔'], snake: ['へび', '🐍'],
  goldfish: ['きんぎょ', '🐟'], salmon: ['しゃけ', '🐟'], shark: ['さめ', '🦈'],
  dolphin: ['いるか', '🐬'], octopus: ['たこ', '🐙'], whale: ['くじら', '🐋'],
  carp: ['こい', '🐟'], mole: ['もぐら'], worm: ['みみず', '🪱'],
  caterpillar: ['あおむし', '🐛'], tadpole: ['おたまじゃくし'],
};
const vehicles = {
  train: ['でんしゃ', '🚃'], bullet: ['しんかんせん', '🚅'], freight: ['かもつれっしゃ', '🚃'],
  plane: ['ひこうき', '✈️'], helicopter: ['へりこぷたー', '🚁'], balloon: ['ききゅう'],
  sailboat: ['よっと', '⛵'], ferry: ['ふぇりー', '⛴️'], canoe: ['かぬー', '🛶'],
  bicycle: ['じてんしゃ', '🚲'], bus: ['ばす', '🚌'], taxi: ['たくしー', '🚕'],
  fire: ['しょうぼうしゃ', '🚒'], ambulance: ['きゅうきゅうしゃ', '🚑'],
  truck: ['ごみしゅうしゅうしゃ', '🚛'], patrol: ['ぱとかー', '🚓'],
};
const foods = {
  apple: ['りんご', '🍎'], banana: ['ばなな', '🍌'], peach: ['もも', '🍑'],
  grapes: ['ぶどう', '🍇'], pear: ['なし', '🍐'], orange: ['みかん', '🍊'],
  carrot: ['にんじん', '🥕'], cabbage: ['きゃべつ', '🥬'], broccoli: ['ぶろっこりー', '🥦'],
  cucumber: ['きゅうり', '🥒'], onion: ['たまねぎ', '🧅'], radish: ['だいこん'],
  milk: ['ぎゅうにゅう', '🥛'], tea: ['おちゃ', '🍵'], water: ['おみず', '💧'],
  tomatoJuice: ['とまとじゅーす', '🥤'], soy: ['だいず', '🫘'], rice: ['ごはん', '🍚'],
  potato: ['じゃがいも', '🥔'], corn: ['とうもろこし', '🌽'], tomato: ['とまと', '🍅'],
};
const shapes = [
  ['circle', 'まる', '●', 0], ['triangle', 'さんかく', '▲', 3], ['square', 'せいほうけい', '■', 4],
  ['oval', 'だえん', 'oval', 0], ['rectangle', 'ちょうほうけい', '▬', 4],
  ['pentagon', 'ごかくけい', '⬟', 5], ['hexagon', 'ろっかくけい', '⬢', 6],
  ['heart', 'はーと', '♥'], ['star', 'ほし', '★'],
];
const colors = [
  ['red', 'あか'], ['blue', 'あお'], ['yellow', 'きいろ'], ['green', 'みどり'],
  ['purple', 'むらさき'], ['orange', 'おれんじ'], ['pink', 'ぴんく'],
];

const entities = (catalog, keys) => keys.split(' ').map(key => [key, ...catalog[key]]);
const clues = rows => rows.map(([key, answer, icon, text]) => [[key, answer, icon], [[key, text]]]);
const groups = (catalog, rows) => rows.map(([key, label, icon, members]) =>
  [[key, label, icon], entities(catalog, members)]);
const keyedClues = (catalog, rows) => rows.map(([key, text]) => [[key, ...catalog[key]], [[key, text]]]);

export const relations = [
  ['animals', 'call', '{subject} なくのは？', '♪', keyedClues(animals, [
    ['dog', 'わんわん'], ['cat', 'にゃあにゃあ'], ['pig', 'ぶうぶう'], ['cow', 'もーもー'],
    ['duck', 'があがあ'], ['sheep', 'めえめえ'], ['rooster', 'こけこっこー'],
  ])],
  ['animals', 'coat', '{subject}の せなかを おおうのは？', '🔍', groups(animals, [
    ['fur', 'け', '', 'dog cat sheep rabbit'],
    ['feathers', 'はね', '', 'owl sparrow swallow chicken duck'],
    ['scales', 'うろこ', '', 'goldfish salmon snake carp'],
  ])],
  ['animals', 'move', '{subject}は どうやって すすむ？', '🐾', groups(animals, [
    ['fly', 'つばさで とぶ', '', 'swallow owl sparrow'],
    ['swim', 'ひれで およぐ', '', 'salmon goldfish dolphin whale'],
    ['crawl', 'からだを くねらせて はう', '', 'snake worm'],
  ])],
  ['animals', 'home', '{subject}が くらす ところは？', '🔍', groups(animals, [
    ['ocean', 'うみ', '🌊', 'octopus dolphin whale'],
    ['soil', 'つちの なか', '🟫', 'mole worm'],
    ['pond', 'いけ', '🪷', 'tadpole carp'],
    ['leaf', 'はっぱの うえ', '🍃', 'caterpillar'],
  ])],
  ['objects', 'use', '{subject}とき つかうのは？', '🧺', clues([
    ['brush', 'はぶらし', '🪥', 'はを みがく'], ['umbrella', 'かさ', '☂️', 'あめを よける'],
    ['spoon', 'すぷーん', '🥄', 'すーぷを すくう'], ['towel', 'たおる', '▰', 'ぬれた からだを ふく'],
    ['scissors', 'はさみ', '✂️', 'かみを ちょきちょき きる'],
    ['clock', 'とけい', '🕒', 'いまの じかんを しらべる'],
    ['broom', 'ほうき', '🧹', 'ゆかの ごみを はく'],
    ['pencil', 'えんぴつ', '✏️', 'あとで けせる じを かく'],
    ['glue', 'のり', '', 'かみと かみを はりあわせる'],
    ['comb', 'くし', '', 'かみのけを とかす'],
    ['flashlight', 'かいちゅうでんとう', '🔦', 'くらい みちを てらす'],
    ['thermometer', 'たいおんけい', '🌡️', 'からだの あつさを はかる'],
  ])],
  ['objects', 'wear', '{subject}に つけるのは？', '🧺', clues([
    ['hat', 'ぼうし', '🧢', 'あたまの てっぺん'], ['shoes', 'くつ', '👟', 'あし'],
    ['gloves', 'てぶくろ', '🧤', 'て'], ['scarf', 'まふらー', '🧣', 'くび'],
    ['belt', 'べると', '', 'こし'], ['glasses', 'めがね', '👓', 'めの まえ'],
  ])],
  ['routines', 'next', '{subject}。なにを する？', '☀️', clues([
    ['cold', 'うわぎを きる', '🧥', 'そとに でるよ。そとは さむいよ'],
    ['dirt', 'てを あらう', '🧼', 'つちで てが よごれたよ'],
    ['plant', 'みずを あげる', '🪴', 'うえきばちの つちが からからだよ'],
    ['thirsty', 'みずを のむ', '💧', 'のどが かわいたよ'],
    ['yawn', 'ふとんで ねる', '🛏️', 'よるだよ。ねむく なったよ'],
    ['toy', 'おもちゃを かたづける', '🧸', 'あそび おわったよ。ゆかに おもちゃが あるよ'],
    ['tissue', 'てぃっしゅを つかう', '🧻', 'はなみずが でてきたよ'],
    ['paper', 'なまえを かく', '✏️', 'おえかきしたよ。だれの えか わかるように したいよ'],
  ])],
  ['places', 'place', '{subject}のは どこ？', '📍', clues([
    ['library', 'としょかん', '📚', 'おうちで よむ ほんを かりる'],
    ['station', 'えき', '🚉', 'でんしゃに のる'], ['pool', 'ぷーる', '🏊', 'みずぎで およぐ'],
    ['park', 'こうえん', '🛝', 'そとの すべりだいで あそぶ'],
    ['bakery', 'ぱんやさん', '🥖', 'やきたての ぱんを かう'],
    ['zoo', 'どうぶつえん', '🦒', 'きりんや ぞうを みに いく'],
    ['dentist', 'はいしゃさん', '🦷', 'むしばを みてもらう'],
    ['cinema', 'えいがかん', '🎥', 'おおきな がめんで えいがを みる'],
  ])],
  ['food', 'kind', '{subject}は どの なかま？', '🍴', groups(foods, [
    ['fruit', 'くだもの', '🍑', 'apple banana peach grapes pear orange'],
    ['vegetable', 'やさい', '🥦', 'carrot cabbage broccoli cucumber onion radish'],
    ['drink', 'のみもの', '🥛', 'milk tea water tomatoJuice'],
  ])],
  ['food', 'ingredient', '{subject}を つくる もとに なるのは？', '🍴', keyedClues(foods, [
    ['rice', 'おにぎり'], ['milk', 'ばたー'], ['soy', 'とうふ'], ['potato', 'ぽてとちっぷす'],
    ['corn', 'ぽっぷこーん'], ['tomato', 'とまとじゅーす'],
  ])],
  ['vehicles', 'travel', '{subject}は どこを すすむ？', '🛞', groups(vehicles, [
    ['rail', 'せんろ', '🛤️', 'train bullet freight'],
    ['air', 'そら', '☁️', 'plane helicopter balloon'],
    ['water', 'みずの うえ', '🌊', 'sailboat ferry canoe'],
    ['road', 'みち', '', 'bicycle bus taxi'],
  ])],
  ['vehicles', 'job', '{subject}のは どれ？', '🛞', keyedClues(vehicles, [
    ['fire', 'かじの ひを けしに いく'], ['ambulance', 'けがを した ひとを びょういんへ はこぶ'],
    ['bus', 'ばすていで ひとを のせる'], ['truck', 'まちの ごみを あつめて はこぶ'],
    ['patrol', 'おまわりさんが のって まちを みまわる'], ['bicycle', 'ぺだるを こいで すすむ'],
  ])],
  ['shapes', 'shape', 'おなじ かたちは どれ？', '', shapes.map(([id, label, icon]) =>
    [[id, label, icon, 'shape'], [[id, label, icon]]])],
  ['shapes', 'corners', 'かどは いくつ？', '', [0, 3, 4, 5, 6].map(count =>
    [[String(count), String(count), '', 'number'], shapes.filter(shape => shape[3] === count)])],
  ['colors', 'color', 'おなじ いろは どれ？', '', colors.map(([id, label]) =>
    [[id, label, id, 'swatch'], [[id, label, id]]])],
];

// Extra contrasts for the language model and its factual checker. Distinct
// wrong options are chosen from the same verified contrast as the right one.
export const modelRelations = [
  ...relations,
  ['animals', 'legs', '{subject}の あしは なんぼん？', '🐾', [
    [['two', '2', '', 'number'], entities(animals, 'chicken owl duck sparrow')],
    [['four', '4', '', 'number'], entities(animals, 'dog cat cow rabbit')],
    [['six', '6', '', 'number'], [['ant', 'あり'], ['bee', 'はち'], ['beetle', 'かぶとむし']]],
    [['eight', '8', '', 'number'], [['spider', 'くも']]],
  ]],
  ['objects', 'sound', '{subject}のは どれ？', '🎵', clues([
    ['drum', 'たいこ', '🥁', 'たたいて どんどん なる'],
    ['whistle', 'ふえ', '', 'ふくと ぴーっと なる'],
    ['bell', 'すず', '🔔', 'ふると りんりん なる'],
    ['piano', 'ぴあの', '🎹', 'しろと くろの けんばんを おす'],
  ])],
  ['routines', 'care', '{subject}。どうする？', '☀️', clues([
    ['shoes', 'くつを ぬぐ', '👟', 'そとから かえって げんかんに いるよ'],
    ['light', 'でんきを つける', '💡', 'おへやが くらくて よく みえないよ'],
    ['pat', 'やさしく なでる', '🐈', 'ねこを びっくり させずに さわりたいよ'],
    ['socks', 'せんたくに だす', '🧺', 'くつしたが どろんこだよ'],
    ['wet', 'たおるで ふく', '', 'おふろから あがって からだが ぬれて いるよ'],
  ])],
  ['places', 'buy', '{subject}を かうのは どこ？', '📍', clues([
    ['flower', 'はなやさん', '💐', 'はなたば'], ['book', 'ほんやさん', '📚', 'あたらしい えほん'],
    ['fish', 'さかなやさん', '🐟', 'おさしみ'], ['shoe', 'くつやさん', '👟', 'うんどうぐつ'],
    ['cake', 'けーきやさん', '🍰', 'おたんじょうびの けーき'],
  ])],
  ['food', 'part', '{subject}のは どれ？', '🍴', clues([
    ['banana', 'ばなな', '🍌', 'かわを むくと なかが しろくて ながい'],
    ['strawberry', 'いちご', '🍓', 'そとに ちいさな つぶが たくさん ある'],
    ['melon', 'すいか', '🍉', 'みどりの しまの なかが あかい'],
    ['grape', 'ぶどう', '🍇', 'ちいさな まるい つぶが ふさに なって いる'],
    ['chestnut', 'くり', '🌰', 'とげとげの いがに はいって いる'],
  ])],
  ['vehicles', 'parts', '{subject}が あるのは どれ？', '🛞', clues([
    ['bucket', 'しょべるかー', '', 'つちを すくう ばけっと'],
    ['ladder', 'はしごしゃ', '🚒', 'たかい ところに のぼる ながい はしご'],
    ['sail', 'よっと', '⛵', 'かぜを うける ほ'],
    ['rotor', 'へりこぷたー', '🚁', 'うえで ぐるぐる まわる はね'],
  ])],
];
