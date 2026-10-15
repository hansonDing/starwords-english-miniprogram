/**
 * 复习页「错题本 + 学习记录分页」运行时自检。
 *
 * 为什么需要：这两块逻辑都长在页面里（pages/review/review.js），坏掉是**静默**的 ——
 * 界面照样渲染，只是内容不对（错题列表漏词 / 没带答案、分页少一条 / 翻不动 / 切页后停在半截）。
 * 静态检查只能证明"元素还在"，证明不了"内容对、翻页对"。所以这里真跑一遍页面代码。
 *
 * 做法：把真实的 pages/review/review.js 放进 vm 沙箱执行，捕获 Page({...}) 的入参，
 * 桩掉词库 / store / 调度器 / 音频，再以假事件驱动整个复习流程。
 *
 * 用法： node review-runtime-check.cjs
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
function arr(x) {
  return Array.isArray(x) ? x : [];
}
function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/* ---------- 测试词库（25 词 = 5 组 × 5 词）---------- */
const ALL_WORDS = [];
for (let w = 1; w <= 5; w++) {
  for (let i = 1; i <= 5; i++) {
    ALL_WORDS.push({
      id: 'w' + w + '-' + i,
      word: 'Word' + w + i,
      meaning: '词' + w + '-' + i,
      phonetic: '/w' + w + i + '/',
      audio: '../../assets/audio/w' + w + '-' + i + '.mp3',
      imgTx: 0,
      imgTy: 0,
    });
  }
}
function wordById(id) {
  return ALL_WORDS.filter(function (x) {
    return x.id === id;
  })[0];
}

/* ---------- 沙箱：加载真实 review.js ---------- */
const reviewPath = path.join(ROOT, 'pages', 'review', 'review.js');
const reviewSrc = fs.readFileSync(reviewPath, 'utf8');

let pageDef = null;
const toasts = [];
let progressStub = { currentWeek: 1, words: [] };
let dueStub = [];

function makePage() {
  const p = Object.assign({}, pageDef);
  p.data = JSON.parse(JSON.stringify(pageDef.data));
  // 实例字段：浅拷贝会共享同一个数组，必须按实例重置
  p.sessionResults = [];
  p.allRecords = [];
  p.setData = function (patch) {
    Object.keys(patch).forEach(function (k) {
      p.data[k] = patch[k];
    });
  };
  return p;
}

const stubs = {
  '../../utils/words': {
    WORDS: ALL_WORDS,
    getWordById: wordById,
    WORDS_PER_WEEK: 5,
    MAX_WEEK: 40,
  },
  '../../utils/store': {
    getProgress: function () {
      return progressStub;
    },
    recordReviewResult: function () {},
    syncToCloud: function () {},
    refreshAchievements: function () {
      return [];
    },
    ACHIEVEMENTS: [],
  },
  '../../utils/scheduler': {
    localToday: function () {
      return '2026-10-15';
    },
    getDueReviews: function () {
      return dueStub;
    },
  },
  '../../utils/audio': {
    play: function () {
      return Promise.resolve();
    },
    playPhrase: function () {
      return Promise.resolve();
    },
    stop: function () {},
  },
};

const sandbox = {
  console: console,
  module: { exports: {} },
  exports: {},
  require: function (id) {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    throw new Error('review-runtime-check: 未预期的 require → ' + id);
  },
  Page: function (o) {
    pageDef = o;
  },
  wx: {
    nextTick: function (fn) {
      fn();
    },
    showToast: function (o) {
      toasts.push(o && o.title);
    },
  },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(reviewSrc, sandbox, { filename: reviewPath });

check(!!pageDef, '[0] 成功捕获真实 pages/review/review.js 的 Page 定义');
if (!pageDef) {
  console.error('\n复习页自检失败：Page 定义缺失 ✗');
  process.exit(1);
}

/** 点「加载更多」；方法缺失时报告失败而不是抛栈，便于看清 RED */
function loadMore(p, label) {
  if (typeof p.onLoadMoreRecords !== 'function') {
    check(false, (label || '') + ' onLoadMoreRecords 未定义');
    return;
  }
  p.onLoadMoreRecords();
}

/** 作答一题并推进到下一题（按真实流程：选 → 下一步）*/
function answer(p, correct) {
  const q = p.data.quiz;
  if (!q) return;
  const ans = q.answerIdx;
  const idx = correct ? ans : (ans + 1) % q.options.length;
  p.onPickOption({ currentTarget: { dataset: { idx: idx } } });
  p.onNextReview();
}

/* ================= 一、到期复习的错题本 ================= */
console.log('[1] 到期复习 · 做错后有错题列表和答案');
{
  const dueIds = ['w1-1', 'w1-2', 'w1-3'];
  dueStub = dueIds.map(function (id) {
    return { wordId: id };
  });
  progressStub = {
    currentWeek: 1,
    streakDays: 1,
    achievements: [],
    words: dueIds.map(function (id, i) {
      return {
        wordId: id,
        learned: true,
        score: 90,
        attempts: 1,
        lastAttemptAt: '2026-10-10T00:00:0' + i + '.000Z',
        learnedDate: '2026-10-10',
        reviewStage: 0,
        nextReviewDate: '2026-10-15',
        stars: 0,
      };
    }),
  };

  const p = makePage();
  p.refresh();
  check(arr(p.data.dueWords).length === 3, '3 个到期词进入复习队列');
  check(!!p.data.quiz, '复习已开始（第一题已就绪）');

  // 第 1 题答错，第 2、3 题答对
  answer(p, false);
  answer(p, true);
  answer(p, true);

  check(p.data.reviewDone === true, '全部答完 → reviewDone');
  const wrong = arr(p.data.wrongList);
  check(wrong.length === 1, '错题列表只有 1 条（实际 ' + wrong.length + '）');
  check(wrong[0] && wrong[0].id === 'w1-1', '错的那条就是答错的 w1-1');
  check(wrong[0] && wrong[0].meaning === '词1-1', '错题列表带了**正确含义**（' + (wrong[0] && wrong[0].meaning) + '）');
  check(wrong[0] && !!wrong[0].phonetic, '错题列表带了音标');
  check(wrong[0] && typeof wrong[0].imgTx === 'number', '错题列表带了取图偏移（可显示配图）');
  check(p.data.reviewedCount === 2 && p.data.totalReviewed === 3, '答对数统计仍正确（2/3）');
}

console.log('[2] 全对时不出错题列表');
{
  const dueIds = ['w2-1', 'w2-2'];
  dueStub = dueIds.map(function (id) {
    return { wordId: id };
  });
  progressStub = {
    currentWeek: 1,
    streakDays: 1,
    achievements: [],
    words: dueIds.map(function (id) {
      return { wordId: id, learned: true, score: 90, attempts: 1, lastAttemptAt: '2026-10-10T00:00:00.000Z', learnedDate: '2026-10-10', reviewStage: 0, nextReviewDate: '2026-10-15', stars: 0 };
    }),
  };
  const p = makePage();
  p.refresh();
  answer(p, true);
  answer(p, true);
  check(p.data.reviewDone === true, '全部答完 → reviewDone');
  check(arr(p.data.wrongList).length === 0, '全对 → 错题列表为空（界面不渲染错题卡）');
}

/* ================= 二、学习记录分页 ================= */
console.log('[3] 学习记录 · 全量 + 加载更多');
const TOTAL = 25;
{
  dueStub = []; // 不进入复习流程，避免干扰
  progressStub = {
    currentWeek: 6,
    streakDays: 4,
    achievements: [],
    words: ALL_WORDS.slice(0, TOTAL).map(function (w, i) {
      return {
        wordId: w.id,
        learned: true,
        score: 80 + (i % 15),
        attempts: 1,
        // lastAttemptAt 递增 → 倒序后第 1 条应是最新的 w5-5
        lastAttemptAt: '2026-10-01T00:00:' + pad2(i) + '.000Z',
        learnedDate: '2026-10-01',
        reviewStage: 0,
        nextReviewDate: null,
        stars: 1,
      };
    }),
  };

  const p = makePage();
  p.refresh();
  check(p.data.recordsTotal === TOTAL, 'recordsTotal = 25（学过的**所有**单词）');
  check(arr(p.data.records).length === 10, '首屏显示 10 条（实际 ' + arr(p.data.records).length + '）');
  check(p.data.recordsHasMore === true, '还有更多 → recordsHasMore');
  check(arr(p.data.records)[0] && arr(p.data.records)[0].id === 'w5-5', '按最近学习倒序（第 1 条是最新的 w5-5）');
  check(arr(p.data.records)[0].word === 'Word55' && arr(p.data.records)[0].meaning === '词5-5', '记录项带单词与含义');

  loadMore(p, '第二次');
  check(arr(p.data.records).length === 20, '点「加载更多」→ 20 条');
  check(p.data.recordsHasMore === true, '仍有剩余');

  loadMore(p, '第三次');
  check(arr(p.data.records).length === TOTAL, '再点一次 → 25 条（全部显示）');
  check(p.data.recordsHasMore === false, '加载完 → recordsHasMore = false（按钮换成「已显示全部」）');

  loadMore(p, '第四次');
  check(arr(p.data.records).length === TOTAL, '已加载完后再点不会越界 / 不重复追加');

  console.log('[4] 切页回来分页要重置');
  loadMore(p, '第五次');
  p.refresh();
  check(arr(p.data.records).length === 10, 'refresh() 后回到第一页 10 条');
  check(p.data.recordsHasMore === true, 'recordsHasMore 同步回到 true');
  check(arr(p.data.wrongList).length === 0, 'refresh() 后清空上一轮的错题列表');
}

console.log(failed ? '\n复习页自检失败：' + failed + ' 项 ✗' : '\n复习页自检全部通过 ✓');
process.exit(failed ? 1 : 0);
