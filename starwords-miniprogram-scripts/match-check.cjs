/**
 * 配对闯关（learn 页 Step 4）逻辑自检。
 *
 * 为什么需要：出题逻辑里有一条**静默失败**的硬约束 —— 右列（中文含义）打乱后
 * 不能恰好等于左列（单词）的原顺序。否则孩子从上往下照着点就全对，游戏失去意义。
 * 这个概率是 1/120，靠人眼抽查根本发现不了，只能用测试锁住。
 *
 * 另外「打乱」依赖随机数，必须能注入 rng 才能复现最坏情况（恒定 rng）。
 *
 * 用法： node match-check.cjs
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
function ok(msg) {
  console.log('  ✓ ' + msg);
}
function check(cond, msg) {
  if (cond) ok(msg);
  else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}
function ids(arr) {
  return arr.map(function (x) {
    return x.id;
  });
}
function sameOrder(a, b) {
  const x = ids(a);
  const y = ids(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/* ---------- 0. 加载模块（缺失即整体失败） ---------- */
console.log('[0] 加载 utils/match.js');
const matchPath = path.join(ROOT, 'utils', 'match.js');
if (!fs.existsSync(matchPath)) {
  failed++;
  console.error('  ✗ 缺少 utils/match.js（配对出题逻辑模块）');
  console.error('\n配对闯关自检失败：' + failed + ' 项 ✗');
  process.exit(1);
}
const match = loadCjs(matchPath);
check(typeof match.buildPuzzle === 'function', '导出 buildPuzzle()');
check(typeof match.isMatch === 'function', '导出 isMatch()');
if (typeof match.buildPuzzle !== 'function' || typeof match.isMatch !== 'function') {
  console.error('\n配对闯关自检失败：' + failed + ' 项 ✗');
  process.exit(1);
}

// 与词库同形状的 5 个词（id / word / meaning）
const WORDS5 = [
  { id: 'w1-1', word: 'Apple', meaning: '苹果' },
  { id: 'w1-2', word: 'Banana', meaning: '香蕉' },
  { id: 'w1-3', word: 'Orange', meaning: '橙子' },
  { id: 'w1-4', word: 'Grape', meaning: '葡萄' },
  { id: 'w1-5', word: 'Watermelon', meaning: '西瓜' },
];

/* ---------- 1. 题目结构 ---------- */
console.log('[1] 题目结构');
{
  const frozen = JSON.stringify(WORDS5);
  const p = match.buildPuzzle(WORDS5);
  check(p && Array.isArray(p.left) && Array.isArray(p.right), 'buildPuzzle 返回 { left, right } 两个数组');
  check(p.left.length === 5 && p.right.length === 5, '左右两列各 5 项');
  check(
    p.left.every(function (x, i) {
      return x.text === WORDS5[i].word;
    }),
    '左列是单词、且保持词库原顺序'
  );
  check(
    ids(p.left).join() === ids(WORDS5).join(),
    '左列 id 顺序与词库一致'
  );
  check(
    p.right.every(function (x) {
      return WORDS5.some(function (w) {
        return w.id === x.id && w.meaning === x.text;
      });
    }),
    '右列是中文含义、id 对应正确'
  );
  check(
    ids(p.right).slice().sort().join() === ids(p.left).slice().sort().join(),
    '左右两列 id 集合完全一致（不多不少）'
  );
  check(JSON.stringify(WORDS5) === frozen, 'buildPuzzle 不修改传入的 words 数组');
}

/* ---------- 2. 硬约束：右列不能等于左列原序 ---------- */
console.log('[2] 硬约束：右列顺序 ≠ 左列顺序（连跑 200 次）');
{
  let identity = 0;
  for (let i = 0; i < 200; i++) {
    const p = match.buildPuzzle(WORDS5);
    if (sameOrder(p.left, p.right)) identity++;
  }
  check(identity === 0, '200 次随机出题，右列从未恰好等于左列原顺序（避免照顺序点即全对）');
}

/* ---------- 3. 最坏情况：注入恒定 rng ---------- */
console.log('[3] 最坏情况：注入恒定 rng');
{
  // rng 恒为 0 → Fisher-Yates 退化成循环移位，天然错开
  const p0 = match.buildPuzzle(WORDS5, function () {
    return 0;
  });
  check(!sameOrder(p0.left, p0.right), 'rng 恒为 0 时仍错开（右列 = ' + ids(p0.right).join(',') + '）');

  // rng 恒为 0.999… → j 恒等于 i，等于不交换 → 会打乱成「原序」，必须靠兜底错开
  const p1 = match.buildPuzzle(WORDS5, function () {
    return 0.999999;
  });
  check(!sameOrder(p1.left, p1.right), 'rng 恒为 0.999999（不交换）时靠兜底错开（右列 = ' + ids(p1.right).join(',') + '）');
  check(
    ids(p1.right).slice().sort().join() === ids(p1.left).slice().sort().join(),
    '兜底分支不会丢项或加项'
  );
}

/* ---------- 4. 边界输入 ---------- */
console.log('[4] 边界输入');
{
  let err = null;
  let empty = null;
  let one = null;
  try {
    empty = match.buildPuzzle([]);
    one = match.buildPuzzle([{ id: 'a', word: 'A', meaning: '甲' }]);
  } catch (e) {
    err = e;
  }
  check(!err, err ? '空数组 / 单元素抛异常：' + err.message : '空数组 / 单元素不抛异常');
  check(!!empty && empty.left.length === 0 && empty.right.length === 0, '空数组 → 左右都是空');
  check(!!one && one.left.length === 1 && one.right.length === 1, '单元素 → 左右各 1 项');
  let err2 = null;
  try {
    match.buildPuzzle(null);
  } catch (e) {
    err2 = e;
  }
  check(!err2, err2 ? '传入 null 抛异常：' + err2.message : '传入 null 不抛异常');
}

/* ---------- 5. isMatch ---------- */
console.log('[5] isMatch');
check(match.isMatch('w1-1', 'w1-1') === true, "同 id → true");
check(match.isMatch('w1-1', 'w1-2') === false, '异 id → false');
check(match.isMatch('', '') === false, "空值 → false（未选中时不能算配对成功）");
check(match.isMatch(undefined, 'w1-1') === false, 'undefined → false');

/* ---------- 6. 真实词库数据 ---------- */
console.log('[6] 真实词库（utils/words.js 的第 1 天 5 词）');
{
  let words = null;
  try {
    const wordsMod = loadCjs(path.join(ROOT, 'utils', 'words.js'));
    words = wordsMod.getWeekWords ? wordsMod.getWeekWords(1) : null;
  } catch (e) {
    words = null;
  }
  if (!words || words.length !== 5) {
    check(false, '未能从 utils/words.js 取到第 1 天的 5 个词');
  } else {
    const p = match.buildPuzzle(words);
    check(p.left.length === 5 && p.right.length === 5, '真实数据出题正常（5 左 / 5 右）');
    check(!sameOrder(p.left, p.right), '真实数据右列也不等于左列原序');
    check(
      p.left.every(function (x) {
        return typeof x.text === 'string' && x.text.length > 0;
      }) && p.right.every(function (x) {
        return typeof x.text === 'string' && x.text.length > 0;
      }),
      '左右文字均非空'
    );
    check(p.left[0].text === words[0].word, '左列首项 = 词库首词（' + p.left[0].text + '）');
  }
}

console.log(failed ? '\n配对闯关自检失败：' + failed + ' 项 ✗' : '\n配对闯关自检全部通过 ✓');
process.exit(failed ? 1 : 0);
