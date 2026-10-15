// 单词 PK 挑战：出题 / 计分 / 挑战 id / 可作答性判断
//
// 纯逻辑、零依赖、不碰 wx —— 便于本地自检（starwords-miniprogram-scripts/pk-check.cjs）。
//
// 规则（详见 docs/superpowers/specs/2026-10-15-pk-challenge-design.md）：
//   题干 = 单词 + 音标（不配图、不播发音：看图猜义会绕过认词）
//   选项 = 1 个正确含义 + 3 个干扰含义（从全词库抽，排除同义与重复）
//   ⚠️ 硬约束 1：正确答案的位置必须随机。固定放第 1 位 → 孩子两天就摸出「总选第一个」。
//                这个退化不报错、界面正常，只有跑 200 次单测才抓得住。
//   ⚠️ 硬约束 2：题序要打乱，否则出题者按学习顺序勾选会导致题序可预测。
//   题目的「对错判定」「错题回顾数据」「得星数」统一由 scoreQuiz 产出。

// 每题选项数（1 正确 + 3 干扰）
var OPTION_COUNT = 4;
// 出题数量上下限（由 pages/pk-create 强制）
var MIN_QUESTIONS = 3;
var MAX_QUESTIONS = 10;
// makeChallengeId 的随机后缀长度（36^8 ≈ 2.8e12，1000 次内碰撞概率 ~1.8e-7）
var ID_RANDOM_LEN = 8;
var ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Fisher-Yates 洗牌。rng 可注入（默认 Math.random），便于测试复现最坏情况。
function shuffle(arr, rng) {
  var rand = typeof rng === 'function' ? rng : Math.random;
  var a = Array.isArray(arr) ? arr.slice() : [];
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// 按 id 从词库取词（词库 200 条，线性查找足够）
function findWord(pool, id) {
  for (var i = 0; i < pool.length; i++) {
    if (pool[i] && pool[i].id === id) return pool[i];
  }
  return null;
}

/**
 * 出一套题。
 *
 * @param {string[]} wordIds   出题者勾选的单词 id（顺序会被打乱）
 * @param {Array}    allWords  全词库（既作题源，也作干扰项来源）
 * @param {Function} [rng]     可注入随机源
 * @returns {Array} [{ wordId, word, phonetic, meaning, options, answerIdx }]
 *          ⚠️ 查不到的 wordId 直接跳过（词库版本不一致时不该崩），全查不到 → []
 */
function buildQuestions(wordIds, allWords, rng) {
  var ids = Array.isArray(wordIds) ? wordIds : [];
  var pool = Array.isArray(allWords) ? allWords : [];
  var rand = typeof rng === 'function' ? rng : Math.random;

  // 先按出参顺序取词，再打乱题序（先在池子里找，保证"未知 id 跳过"）
  var pickedWords = [];
  for (var i = 0; i < ids.length; i++) {
    var w = findWord(pool, ids[i]);
    if (w) pickedWords.push(w);
  }
  pickedWords = shuffle(pickedWords, rand);

  var questions = [];
  for (var k = 0; k < pickedWords.length; k++) {
    var word = pickedWords[k];

    // 干扰项：从全词库随机抽，排除「自己」与「与正确答案同义」以及「已选过的干扰项」
    var options = [word.meaning];
    var candidates = shuffle(pool, rand);
    for (var m = 0; m < candidates.length && options.length < OPTION_COUNT; m++) {
      var c = candidates[m];
      if (!c || c.id === word.id) continue;
      if (c.meaning === word.meaning) continue; // 同义词会让两个选项都对
      if (options.indexOf(c.meaning) !== -1) continue;
      options.push(c.meaning);
    }

    // 打乱选项 → 正确答案的位置随之随机（硬约束 1）
    var shuffled = shuffle(options, rand);
    questions.push({
      wordId: word.id,
      word: word.word,
      phonetic: word.phonetic || '',
      meaning: word.meaning,
      options: shuffled,
      answerIdx: shuffled.indexOf(word.meaning),
    });
  }
  return questions;
}

/**
 * 计分。
 *
 * @param {Array} questions buildQuestions 的产物
 * @param {Array} pickedIdxs 每题选中的选项下标（未作答传 -1 / null / undefined）
 * @returns {{ total, correctCount, wrongList, earnedStars }}
 *          wrongList = [{ wordId, word, phonetic, meaning }]，含义是**正确**含义，
 *          供结算页的「错题回顾」直接渲染。
 *          earnedStars === correctCount（答对 1 题 = 1 颗星）
 */
function scoreQuiz(questions, pickedIdxs) {
  var qs = Array.isArray(questions) ? questions : [];
  var picks = Array.isArray(pickedIdxs) ? pickedIdxs : [];
  var correctCount = 0;
  var wrongList = [];

  for (var i = 0; i < qs.length; i++) {
    var q = qs[i];
    var picked = picks[i];
    // 用严格相等：undefined / null / -1 都落进 else（未作答 = 错）
    if (picked === q.answerIdx) {
      correctCount++;
    } else {
      wrongList.push({
        wordId: q.wordId,
        word: q.word,
        phonetic: q.phonetic,
        meaning: q.meaning,
      });
    }
  }

  return {
    total: qs.length,
    correctCount: correctCount,
    wrongList: wrongList,
    earnedStars: correctCount,
  };
}

/**
 * 生成挑战 id。
 * 形如 pk + 毫秒时间戳(base36) + 8 位随机 → 短、可直接放进分享链接 path。
 * rng / now 可注入，便于测试「同一毫秒也不撞车」。
 */
function makeChallengeId(rng, now) {
  var rand = typeof rng === 'function' ? rng : Math.random;
  var stamp = typeof now === 'number' ? now : Date.now();
  var suffix = '';
  for (var i = 0; i < ID_RANDOM_LEN; i++) {
    suffix += ID_CHARS.charAt(Math.floor(rand() * ID_CHARS.length));
  }
  return 'pk' + stamp.toString(36) + suffix;
}

/**
 * 这场挑战还能不能被作答。
 *
 * ⚠️ myUid 为空（未登录）时**必须放行** —— 孩子点开分享卡片不能被登录墙挡住。
 *    这也是「自己不能答自己的」判定的前提：没登录就无从判断是谁。
 *
 * @returns {{ ok: boolean, reason: 'not_found'|'finished'|'own'|'' }}
 */
function isPlayable(challenge, myUid) {
  if (!challenge || !challenge.id) return { ok: false, reason: 'not_found' };
  // status 缺失按「待作答」处理（兼容早期写入的行）
  if (challenge.status === 'done') return { ok: false, reason: 'finished' };
  if (myUid && challenge.challenger_id === myUid) return { ok: false, reason: 'own' };
  return { ok: true, reason: '' };
}

module.exports = {
  OPTION_COUNT: OPTION_COUNT,
  MIN_QUESTIONS: MIN_QUESTIONS,
  MAX_QUESTIONS: MAX_QUESTIONS,
  shuffle: shuffle,
  buildQuestions: buildQuestions,
  scoreQuiz: scoreQuiz,
  makeChallengeId: makeChallengeId,
  isPlayable: isPlayable,
};
