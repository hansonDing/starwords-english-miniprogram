/**
 * 配对闯关「交互状态机」运行时自检。
 *
 * 为什么需要：配对逻辑的另一半在页面里（learn.js）——单选、锁定、配错复位、
 * 只在最后一个词之后出现一次。这些坏掉都是**静默**的：界面照样渲染，只是行为不对
 * （比如已配对的还能再点、配错后把新选择一起抹掉、配对重复出现两次）。
 * 静态检查只能证明"接线还在"，证明不了"行为还对"。所以这里真跑一遍页面代码。
 *
 * 做法：把真实的 pages/learn/learn.js 放进 vm 沙箱执行，捕获 Page({...}) 的入参，
 * 用真实的 utils/match.js 生成题目，再以假 wx / 假依赖驱动整个配对流程。
 *
 * 用法： node match-runtime-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
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
function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

const WORDS5 = [
  { id: 'w1-1', word: 'Apple', meaning: '苹果', audio: '../../assets/audio/w1-1.mp3' },
  { id: 'w1-2', word: 'Banana', meaning: '香蕉', audio: '../../assets/audio/w1-2.mp3' },
  { id: 'w1-3', word: 'Orange', meaning: '橙子', audio: '../../assets/audio/w1-3.mp3' },
  { id: 'w1-4', word: 'Grape', meaning: '葡萄', audio: '../../assets/audio/w1-4.mp3' },
  { id: 'w1-5', word: 'Watermelon', meaning: '西瓜', audio: '../../assets/audio/w1-5.mp3' },
];

/* ---------- 0. 在沙箱里执行真实 learn.js，拿到 Page 定义 ---------- */
console.log('[0] 加载真实 pages/learn/learn.js');
const realMatch = loadCjs(path.join(ROOT, 'utils', 'match.js'));
const learnPath = path.join(ROOT, 'pages', 'learn', 'learn.js');
const learnSrc = fs.readFileSync(learnPath, 'utf8');

let pageDef = null;
const toasts = [];
let playCalls = 0;
let vibrateCalls = 0;
const daySettled = [];
// 星星结算调用记录（learn.js 每学完一个词会调 store.creditStars）
const starCredits = [];

// onLoad 会读 store.getProgress() 决定从第几个词开始，所以这必须是可替换的桩
let progressStub = { currentWeek: 1, words: [] };

const stubs = {
  '../../utils/words': { getWeekWords: function () { return WORDS5; }, WORDS: WORDS5, WORDS_PER_WEEK: 5, MAX_WEEK: 40 },
  '../../utils/store': {
    getProgress: function () { return progressStub; },
    markWordLearned: function () {},
    // 星星账本：本自检只关心配对流程，这里桩掉并记录调用次数供断言
    creditStars: function (wordId, starCount) { starCredits.push({ wordId: wordId, starCount: starCount }); return 0; },
    getStarBalance: function () { return 0; },
    refreshAchievements: function () { return []; },
    completeDailySession: function (a, b) { daySettled.push(b); },
    syncToCloud: function () {},
    ACHIEVEMENTS: [],
  },
  '../../utils/scheduler': { localToday: function () { return '2026-10-15'; } },
  '../../utils/audio': {
    play: function () { playCalls++; return Promise.resolve(); },
    playPhrase: function () { return Promise.resolve(); },
    stop: function () {},
  },
  '../../utils/record-score': { gradeFile: function () { return Promise.resolve(null); } },
  '../../utils/match': realMatch,
  '../../utils/leaderboard': { push: function () {} },
};

const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  require: function (id) {
    return Object.prototype.hasOwnProperty.call(stubs, id) ? stubs[id] : {};
  },
  Page: function (o) {
    pageDef = o;
  },
  wx: {
    showToast: function (o) { toasts.push(o && o.title); },
    vibrateShort: function () { vibrateCalls++; },
    nextTick: function (fn) { fn(); },
    getRecorderManager: function () {
      return { onStart: function () {}, onStop: function () {}, onError: function () {}, start: function () {}, stop: function () {} };
    },
  },
};
sandbox.global = sandbox;

let loadErr = null;
try {
  vm.runInContext(learnSrc, vm.createContext(sandbox), { filename: learnPath });
} catch (e) {
  loadErr = e;
}
check(!loadErr, loadErr ? '加载 learn.js 报错：' + loadErr.message : 'learn.js 顶层执行无异常');
check(!!pageDef && typeof pageDef.onPickMatchLeft === 'function', 'Page({...}) 已注册且含配对方法');
if (!pageDef || typeof pageDef.onPickMatchLeft !== 'function') {
  console.error('\n配对运行时自检失败：' + failed + ' 项 ✗');
  process.exit(1);
}

/* ---------- 造一个可驱动的页面实例 ---------- */
function makePage() {
  const inst = Object.assign({}, pageDef);
  inst.data = JSON.parse(JSON.stringify(pageDef.data));
  inst.setData = function (patch) {
    const keys = Object.keys(patch);
    for (let i = 0; i < keys.length; i++) inst.data[keys[i]] = patch[keys[i]];
    return inst;
  };
  inst.wordScores = {};
  inst.matchTimer = null;
  inst.matchWords = [];
  inst.rewardStage = 0;
  inst.rewardTimers = [];
  return inst;
}
const tap = function (id) {
  return { currentTarget: { dataset: { id: id } } };
};
const find = function (arr, id) {
  return arr.filter(function (x) {
    return x.id === id;
  })[0];
};

(async function main() {
  /* ---------- 1. 出题 ---------- */
  console.log('[1] startMatch 出题');
  const p = makePage();
  p.startMatch(WORDS5);
  check(p.data.matchLeft.length === 5 && p.data.matchRight.length === 5, '左右两列各 5 项');
  check(p.data.matchTotal === 5 && p.data.matchSolved === 0, 'matchTotal=5 / matchSolved=0');
  check(p.data.matchAllDone === false, '初始未完成');
  check(
    p.data.matchLeft.every(function (x) {
      return x.picked === false && x.done === false && x.wrong === false;
    }),
    '左列初始无选中 / 未配对 / 无错误态'
  );
  const leftIds = p.data.matchLeft.map(function (x) { return x.id; });
  const rightIds = p.data.matchRight.map(function (x) { return x.id; });
  check(leftIds.join() !== rightIds.join(), '右列顺序 ≠ 左列（照顺序点无法全对）');
  check(
    leftIds.slice().sort().join() === rightIds.slice().sort().join(),
    '左右 id 集合一致'
  );

  /* ---------- 2. 单选与配错复位 ---------- */
  console.log('[2] 单选 / 配错复位');
  const pSel = makePage();
  pSel.startMatch(WORDS5);

  const beforePlay = playCalls;
  pSel.onPickMatchLeft(tap('w1-1'));
  check(pSel.data.matchLeft.filter(function (x) { return x.picked; }).length === 1, '左列同时只有 1 个选中');
  check(find(pSel.data.matchLeft, 'w1-1').picked === true, '被点的左项进入选中态');
  check(playCalls === beforePlay + 1, '点左列单词会播放读音');

  pSel.onPickMatchLeft(tap('w1-2'));
  check(
    find(pSel.data.matchLeft, 'w1-2').picked === true && find(pSel.data.matchLeft, 'w1-1').picked === false,
    '改点另一项后旧选中被取消'
  );

  // 此时左列选中的是 w1-2；点右列 w1-1 → 错配
  pSel.onPickMatchRight(tap('w1-1'));
  check(pSel.data.matchSolved === 0, '左右不是同一项时不计分');
  check(
    pSel.data.matchRight.filter(function (x) { return x.wrong; }).length === 1 &&
      find(pSel.data.matchRight, 'w1-1').wrong === true,
    '右列只有被点的那一项进入错误态（单选生效）'
  );
  check(
    find(pSel.data.matchLeft, 'w1-2').wrong === true && find(pSel.data.matchRight, 'w1-1').wrong === true,
    '配错的两项进入抖动态'
  );
  check(
    find(pSel.data.matchLeft, 'w1-2').picked === false && find(pSel.data.matchRight, 'w1-1').picked === false,
    '配错时清掉选中态（避免残留选择让下一次点击被白白判错）'
  );

  // 抖动的 600ms 内孩子又点了新的左项：复位不能把他的新选择一起抹掉
  pSel.onPickMatchLeft(tap('w1-3'));
  await sleep(800);
  check(
    find(pSel.data.matchLeft, 'w1-2').wrong === false && find(pSel.data.matchLeft, 'w1-2').picked === false,
    '600ms 后左列错误项自动复位（可重试）'
  );
  check(
    find(pSel.data.matchRight, 'w1-1').wrong === false && find(pSel.data.matchRight, 'w1-1').picked === false,
    '600ms 后右列错误项也复位'
  );
  check(find(pSel.data.matchLeft, 'w1-3').picked === true, '复位只清错误项，不抹掉孩子刚点的新选择');

  /* ---------- 3. 配对成功与锁定 ---------- */
  console.log('[3] 配对成功 / 已配对锁定');
  const pOk = makePage();
  pOk.startMatch(WORDS5);
  const pv = vibrateCalls;
  pOk.onPickMatchLeft(tap('w1-2'));
  pOk.onPickMatchRight(tap('w1-2'));
  check(pOk.data.matchSolved === 1, 'id 相同 → 计 1 组');
  check(
    find(pOk.data.matchLeft, 'w1-2').done === true && find(pOk.data.matchRight, 'w1-2').done === true,
    '两侧都进入 done（变绿锁定）'
  );
  check(find(pOk.data.matchLeft, 'w1-2').picked === false, '配对成功后清掉选中态');
  check(vibrateCalls === pv, '未全部完成时不震动');

  pOk.onPickMatchLeft(tap('w1-2'));
  check(find(pOk.data.matchLeft, 'w1-2').picked === false, '已配对的项再点无效（锁定）');
  pOk.onPickMatchRight(tap('w1-2'));
  check(pOk.data.matchSolved === 1, '已配对的右项再点不会重复计分');

  /* ---------- 4. 左列未选时点右列 ---------- */
  console.log('[4] 左列未选时点右列');
  const p2 = makePage();
  p2.startMatch(WORDS5);
  const t0 = toasts.length;
  p2.onPickMatchRight(tap('w1-3'));
  check(toasts.length === t0 + 1 && toasts[t0] === '先点左边的单词哦', '弹出引导提示');
  check(p2.data.matchRight.filter(function (x) { return x.picked; }).length === 0, '右列未被选中');

  /* ---------- 5. 走完全部 5 组 ---------- */
  console.log('[5] 全部配对完成');
  const p3 = makePage();
  p3.startMatch(WORDS5);
  const v0 = vibrateCalls;
  for (let i = 0; i < WORDS5.length; i++) {
    p3.onPickMatchLeft(tap(WORDS5[i].id));
    p3.onPickMatchRight(tap(WORDS5[i].id));
  }
  check(p3.data.matchSolved === 5, '5 组全部配对（matchSolved=5）');
  check(p3.data.matchAllDone === true, 'matchAllDone 置真 → 界面出现「看奖励动画」');
  check(vibrateCalls === v0 + 1, '全部完成时轻震动一次');

  p3.onMatchFinish();
  check(p3.data.phase === 'celebrate', 'onMatchFinish 接进庆祝三幕');
  check(p3.data.rewardStage === 1, '奖励动画第 1 幕已启动');
  p3.clearRewardTimers();

  /* ---------- 6. 配对只出现一次 ---------- */
  console.log('[6] 第 5 个词之后的流程接入');
  const p4 = makePage();
  p4.data.week = 1;
  p4.data.wordIndex = 4;
  p4.data.word = WORDS5[4];
  p4.data.weekWordsView = WORDS5.map(function (w) { return { id: w.id, learned: false }; });
  const d0 = daySettled.length;
  p4.onNextWord();
  check(daySettled.length === d0 + 1, '日会话在进配对**之前**就结算（中途退出不丢当天进度）');
  check(p4.data.step === 4, '第 5 个词测完后进入第 4 步（配对），而不是直接庆祝');
  check(p4.data.phase === 'learning', '此时还没进 celebrate');
  check(p4.data.maxStep === 4, '步数上限切到 4（标签显示 第 4/4 步）');
  check(p4.data.matchLeft.length === 5, '配对题目已生成');
  check(p4.matchPlayed === true, 'matchPlayed 已置位（防止重复出现）');
  check(
    starCredits.length > 0 && starCredits[starCredits.length - 1].wordId === 'w1-5',
    '学完一个词会结算星星（store.creditStars 被调用）'
  );

  const p5 = makePage();
  p5.data.week = 1;
  p5.data.wordIndex = 4;
  p5.data.word = WORDS5[4];
  p5.data.weekWordsView = WORDS5.map(function (w) { return { id: w.id, learned: false }; });
  p5.matchPlayed = true;
  p5.onNextWord();
  check(p5.data.phase === 'celebrate', '已玩过配对时，直接进庆祝（不会出现第二次）');
  check(p5.data.step === 1, '不会退回配对步骤');
  p5.clearRewardTimers();

  /* ---------- 7. 步数上限随词推进切换 ---------- */
  console.log('[7] 步数上限 maxStep');
  const p6 = makePage();
  p6.data.week = 1;
  p6.data.wordIndex = 0;
  p6.data.word = WORDS5[0];
  p6.data.weekWordsView = WORDS5.map(function (w) { return { id: w.id, learned: false }; });
  p6.onNextWord();
  check(p6.data.wordIndex === 1 && p6.data.maxStep === 3, '第 2 个词仍是 3 步（第 ' + p6.data.step + '/3 步）');

  const p7 = makePage();
  p7.data.week = 1;
  p7.data.wordIndex = 3;
  p7.data.word = WORDS5[3];
  p7.data.weekWordsView = WORDS5.map(function (w) { return { id: w.id, learned: false }; });
  p7.onNextWord();
  check(p7.data.wordIndex === 4 && p7.data.step === 1, '从第 4 个词推进到第 5 个词');
  check(p7.data.maxStep === 4, '进入第 5 个词时步数上限立刻切到 4（否则会显示「第 4/3 步」）');
  check(p7.data.phase === 'learning', '只是进入第 5 个词，还没到配对/庆祝');

  const p8 = makePage();
  p8.data.week = 1;
  progressStub = {
    currentWeek: 1,
    words: WORDS5.map(function (w, i) { return { wordId: w.id, learned: i < 4 }; }),
  };
  p8.onLoad();
  check(p8.data.wordIndex === 4, '中途恢复：前 4 个词已学 → 从第 5 个词开始');
  check(p8.data.maxStep === 4, '中途恢复：直接从第 5 个词开始 → 4 步');

  const p9 = makePage();
  p9.data.week = 1;
  progressStub = {
    currentWeek: 1,
    words: WORDS5.map(function (w, i) { return { wordId: w.id, learned: i < 2 }; }),
  };
  p9.onLoad();
  check(p9.data.wordIndex === 2, '中途恢复：前 2 个词已学 → 从第 3 个词开始');
  check(p9.data.maxStep === 3, '中途恢复：从中间的词开始 → 仍是 3 步');

  console.log(failed ? '\n配对运行时自检失败：' + failed + ' 项 ✗' : '\n配对运行时自检全部通过 ✓');
  process.exit(failed ? 1 : 0);
})();
