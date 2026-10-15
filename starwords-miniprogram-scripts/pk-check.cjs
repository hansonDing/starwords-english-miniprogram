/**
 * 单词 PK 挑战 —— 出题 / 计分 / 挑战 id / 可作答性 逻辑自检。
 *
 * 为什么需要：
 *   1. **答案位置必须随机**。如果 implementation 图省事把正确答案固定放第 1 个选项，
 *      孩子两天就能摸出规律（"总选第一个"），PK 变成送分游戏。这种退化靠人眼抽查
 *      5 道题根本看不出来 —— 而且它**不会报错**，界面一切正常。只能靠跑 200 次锁死。
 *   2. **挑战 id 必须唯一**。id 撞车 = 后发的挑战覆盖先发的，出题者白出一套题。
 *   3. **防刷的前提是 id 去重**（见 stars-check.cjs 的 creditPkStars 用例）。
 *   4. **未登录也要能玩**：isPlayable 在 myUid 为空时必须放行，否则孩子点开分享卡片
 *      直接被挡在门外（这是产品方明确确认的交互）。
 *
 * 用法： node pk-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', 'starwords-miniprogram');

// ⚠️ 工作区根有 "type":"module"，小程序目录里的 .js 必须按 CommonJS 显式加载
function loadCjs(file) {
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8'), file);
  return m.exports;
}

let failed = 0;
function check(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}
function uniq(arr) {
  return arr.filter(function (x, i) {
    return arr.indexOf(x) === i;
  });
}

/* ---------- 0. 加载模块（缺失即整体失败） ---------- */
console.log('[0] 加载 utils/pk.js');
const pkPath = path.join(ROOT, 'utils', 'pk.js');
if (!fs.existsSync(pkPath)) {
  failed++;
  console.error('  ✗ 缺少 utils/pk.js（PK 出题/计分逻辑模块）');
  console.error('\nPK 挑战自检失败：' + failed + ' 项 ✗');
  process.exit(1);
}
const pk = loadCjs(pkPath);
['shuffle', 'buildQuestions', 'scoreQuiz', 'makeChallengeId', 'isPlayable'].forEach(function (name) {
  check(typeof pk[name] === 'function', '导出 ' + name + '()');
});
if (!failed) {
  check(typeof pk.OPTION_COUNT === 'number' && pk.OPTION_COUNT === 4, 'OPTION_COUNT = 4');
  check(pk.MIN_QUESTIONS === 3, 'MIN_QUESTIONS = 3');
  check(pk.MAX_QUESTIONS === 10, 'MAX_QUESTIONS = 10');
} else {
  console.error('\nPK 挑战自检失败：接口缺失，后续用例无法进行 ✗');
  process.exit(1);
}

// 与真实词库同形状的 8 个词（id / word / phonetic / meaning）
const POOL = [
  { id: 'w1-1', word: 'Apple', phonetic: '/ˈæp.əl/', meaning: '苹果' },
  { id: 'w1-2', word: 'Banana', phonetic: '/bəˈnɑː.nə/', meaning: '香蕉' },
  { id: 'w1-3', word: 'Orange', phonetic: '/ˈɒr.ɪndʒ/', meaning: '橙子' },
  { id: 'w1-4', word: 'Grape', phonetic: '/ɡreɪp/', meaning: '葡萄' },
  { id: 'w1-5', word: 'Watermelon', phonetic: '/ˈwɔː.təˌmel.ən/', meaning: '西瓜' },
  { id: 'w2-1', word: 'Cat', phonetic: '/kæt/', meaning: '猫' },
  { id: 'w2-2', word: 'Dog', phonetic: '/dɒɡ/', meaning: '狗' },
  { id: 'w2-3', word: 'Bird', phonetic: '/bɜːrd/', meaning: '鸟' },
];
const PICK3 = ['w1-1', 'w1-2', 'w1-3'];

/* ---------- 1. 题目结构 ---------- */
console.log('[1] 题目结构');
{
  const frozen = JSON.stringify(POOL);
  const qs = pk.buildQuestions(PICK3, POOL);
  check(Array.isArray(qs) && qs.length === 3, '3 个 wordId → 3 道题');
  check(
    qs.every(function (q) {
      return Array.isArray(q.options) && q.options.length === pk.OPTION_COUNT;
    }),
    '每题恰好 4 个选项'
  );
  check(
    qs.every(function (q) {
      return q.options[q.answerIdx] === q.meaning;
    }),
    'options[answerIdx] 就是该词的正确含义'
  );
  check(
    qs.every(function (q) {
      return uniq(q.options).length === q.options.length;
    }),
    '同一题的 4 个选项互不相同（不会出现两个一样的）'
  );
  check(
    qs.every(function (q) {
      return (
        q.options.filter(function (o) {
          return o === q.meaning;
        }).length === 1
      );
    }),
    '每题恰好 1 个选项是正确答案（干扰项没混进同义词）'
  );
  check(
    qs.every(function (q) {
      const src = POOL.filter(function (w) {
        return w.id === q.wordId;
      })[0];
      return !!src && q.word === src.word && q.phonetic === src.phonetic && q.meaning === src.meaning;
    }),
    '每题的 word / phonetic / meaning 都取自词库原文'
  );
  check(
    uniq(
      qs.map(function (q) {
        return q.wordId;
      })
    ).length === 3,
    '3 道题对应 3 个不同的单词（没有重复出同一题）'
  );
  check(JSON.stringify(POOL) === frozen, 'buildQuestions 不修改传入的词库数组');
}

/* ---------- 2. 硬约束：正确答案的位置必须随机 ---------- */
console.log('[2] 硬约束：答案位置必须随机（连跑 200 次单题）');
{
  const seen = {};
  for (let i = 0; i < 200; i++) {
    const qs = pk.buildQuestions(['w1-1'], POOL);
    seen[qs[0].answerIdx] = true;
  }
  const positions = Object.keys(seen).map(Number);
  check(
    positions.length === 4,
    '200 次出题，answerIdx 覆盖了全部 4 个位置（实际命中：' + positions.sort().join(',') + '）'
  );
  check(
    positions.every(function (p) {
      return p >= 0 && p < 4;
    }),
    'answerIdx 始终落在 [0,3]'
  );
}

/* ---------- 3. 题序被打乱 ---------- */
console.log('[3] 题序打乱（连跑 20 次）');
{
  let same = 0;
  for (let i = 0; i < 20; i++) {
    const qs = pk.buildQuestions(PICK3, POOL);
    const order = qs.map(function (q) {
      return q.wordId;
    });
    if (order.join() === PICK3.join()) same++;
  }
  check(same < 20, '20 次里至少有一次题序与入参顺序不同（避免出题者按学习顺序可预测）');
}

/* ---------- 4. 边界输入 ---------- */
console.log('[4] 边界输入');
{
  const mixed = pk.buildQuestions(['w1-1', '不存在的词', 'w1-2'], POOL);
  check(mixed.length === 2, '未知 id 被跳过（3 个入参 → 2 道题）');
  check(pk.buildQuestions(['nope-1', 'nope-2'], POOL).length === 0, '全部未知 → 空题目数组');
  check(pk.buildQuestions([], POOL).length === 0, '空数组 → 0 道题');

  let err = null;
  try {
    pk.buildQuestions(null, POOL);
    pk.buildQuestions(PICK3, null);
    pk.buildQuestions(undefined, undefined);
  } catch (e) {
    err = e;
  }
  check(!err, err ? 'null / undefined 抛异常：' + err.message : 'null / undefined 不抛异常');

  // 词库过小：干扰项凑不满 4 个 → 允许选项变少，但不能抛异常、也不能没有正确项
  const tiny = pk.buildQuestions(['t1'], [
    { id: 't1', word: 'A', phonetic: '', meaning: '甲' },
    { id: 't2', word: 'B', phonetic: '', meaning: '乙' },
  ]);
  check(tiny.length === 1, '小词库也能出题');
  check(
    tiny[0].options.length >= 2 && tiny[0].options.length <= 4,
    '小词库选项数在 2~4 之间（实际 ' + tiny[0].options.length + '）'
  );
  check(tiny[0].options[tiny[0].answerIdx] === '甲', '小词库里正确答案依然在位');

  // 同义词不能被当成干扰项（否则两个选项都是对的）
  const syn = pk.buildQuestions(['s1'], [
    { id: 's1', word: 'A', phonetic: '', meaning: '苹果' },
    { id: 's2', word: 'B', phonetic: '', meaning: '苹果' },
    { id: 's3', word: 'C', phonetic: '', meaning: '香蕉' },
  ]);
  check(
    syn[0].options.filter(function (o) {
      return o === '苹果';
    }).length === 1,
    '同义干扰项被排除（不会出现两个都是"苹果"）'
  );
}

/* ---------- 5. scoreQuiz ---------- */
console.log('[5] scoreQuiz 计分');
{
  const qs = pk.buildQuestions(PICK3, POOL);
  const allRight = qs.map(function (q) {
    return q.answerIdx;
  });
  const r1 = pk.scoreQuiz(qs, allRight);
  check(r1.total === 3, 'total = 3');
  check(r1.correctCount === 3, '全对 → correctCount = 3');
  check(r1.earnedStars === 3, '全对 → 得 3 颗星（答对 1 题 = 1 星）');
  check(r1.wrongList.length === 0, '全对 → 错题列表为空');

  const allWrong = qs.map(function (q) {
    return q.answerIdx === 0 ? 1 : 0;
  });
  const r2 = pk.scoreQuiz(qs, allWrong);
  check(r2.correctCount === 0 && r2.earnedStars === 0, '全错 → 0 分 0 星（不给「跳过」发星）');
  check(r2.wrongList.length === 3, '全错 → 错题列表 3 条');
  check(
    r2.wrongList.every(function (w) {
      return typeof w.word === 'string' && w.word.length > 0 && typeof w.meaning === 'string' && w.meaning.length > 0;
    }),
    '错题条目带 word + meaning（错题回顾要显示「单词 → 正确含义」）'
  );
  check(
    r2.wrongList.every(function (w) {
      return qs.some(function (q) {
        return q.wordId === w.wordId && q.meaning === w.meaning;
      });
    }),
    '错题里的含义是**正确**含义（不是孩子选错的那个）'
  );

  const mixed = qs.map(function (q, i) {
    return i === 0 ? q.answerIdx : q.answerIdx === 0 ? 1 : 0;
  });
  const r3 = pk.scoreQuiz(qs, mixed);
  check(r3.correctCount === 1 && r3.earnedStars === 1, '对 1 题 → 1 分 1 星');
  check(r3.wrongList.length === 2, '对 1 题 → 错 2 题');

  // 未作答（-1 / null）算错，不能让 undefined 混过去
  const r4 = pk.scoreQuiz(qs, [-1, null, undefined]);
  check(r4.correctCount === 0 && r4.wrongList.length === 3, '未作答一律算错（-1 / null / undefined）');

  const r5 = pk.scoreQuiz([], []);
  check(r5.total === 0 && r5.correctCount === 0 && r5.earnedStars === 0, '空题目 → 0/0，不抛异常');
}

/* ---------- 6. makeChallengeId ---------- */
console.log('[6] 挑战 id 唯一性（连跑 1000 次）');
{
  const seen = {};
  let dup = 0;
  let badShape = 0;
  for (let i = 0; i < 1000; i++) {
    const id = pk.makeChallengeId();
    if (typeof id !== 'string' || !/^pk[a-z0-9]+$/.test(id)) badShape++;
    if (seen[id]) dup++;
    seen[id] = true;
  }
  check(dup === 0, '1000 次生成无重复（id 撞车会覆盖别人的挑战）');
  check(badShape === 0, 'id 形状 = pk + [a-z0-9]，可直接放进分享链接');
  const sample = pk.makeChallengeId();
  check(sample.length <= 24, 'id 足够短（实际 ' + sample.length + ' 字符：' + sample + '）');
  // 同一毫秒也要能区分（真机上连点两次「生成挑战」是可能的）
  const a = pk.makeChallengeId(function () {
    return 0.1;
  }, 1700000000000);
  const b = pk.makeChallengeId(function () {
    return 0.9;
  }, 1700000000000);
  check(a !== b, '同一毫秒 + 不同随机数 → 两个不同 id');
}

/* ---------- 7. isPlayable ---------- */
console.log('[7] isPlayable 可作答性');
{
  const pending = { id: 'pk1', status: 'pending', challenger_id: 'u1' };
  const done = { id: 'pk2', status: 'done', challenger_id: 'u1' };

  const r1 = pk.isPlayable(pending, 'u2');
  check(r1.ok === true, '别人发的待作答挑战 → 可以玩');

  const r2 = pk.isPlayable(pending, '');
  check(r2.ok === true, '★未登录（myUid 为空）也能玩 —— 不能被登录墙挡住');

  const r3 = pk.isPlayable(pending, null);
  check(r3.ok === true, 'myUid = null 也放行');

  const r4 = pk.isPlayable(pending, 'u1');
  check(r4.ok === false && r4.reason === 'own', '自己发起的挑战 → 不放行，reason = own');

  const r5 = pk.isPlayable(done, 'u2');
  check(r5.ok === false && r5.reason === 'finished', '已结束（先到先得）→ 不放行，reason = finished');

  const r6 = pk.isPlayable(null, 'u2');
  check(r6.ok === false && r6.reason === 'not_found', '挑战不存在 → 不放行，reason = not_found');

  const r7 = pk.isPlayable({}, 'u2');
  check(r7.ok === false && r7.reason === 'not_found', '没有 id 的行 → 当作不存在');

  const r8 = pk.isPlayable({ id: 'pk9', challenger_id: 'u1' }, 'u2');
  check(r8.ok === true, 'status 字段缺失时按「待作答」处理');
}

/* ---------- 8. 真实词库 ---------- */
console.log('[8] 真实词库（utils/words.js）');
{
  let words = null;
  try {
    const wordsMod = loadCjs(path.join(ROOT, 'utils', 'words.js'));
    words = wordsMod.WORDS || null;
  } catch (e) {
    words = null;
  }
  if (!words || words.length < 10) {
    check(false, '未能从 utils/words.js 读到词库');
  } else {
    const ids = words.slice(0, 5).map(function (w) {
      return w.id;
    });
    const qs = pk.buildQuestions(ids, words);
    check(qs.length === 5, '真实词库出 5 道题');
    check(
      qs.every(function (q) {
        return q.options.length === 4 && q.options[q.answerIdx] === q.meaning;
      }),
      '真实词库每题 4 选项且答案位置正确'
    );
    check(
      qs.every(function (q) {
        return q.phonetic && q.phonetic.length > 0;
      }),
      '真实词库每题都带音标（答题页要显示）'
    );
  }
}

console.log(failed ? '\nPK 挑战自检失败：' + failed + ' 项 ✗' : '\nPK 挑战自检全部通过 ✓');
process.exit(failed ? 1 : 0);
