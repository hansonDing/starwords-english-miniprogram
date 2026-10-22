/**
 * 学习页运行时自检：录音「点一下就松手」+ 朗读链在页面卸载后的行为。
 *
 * 为什么必须真跑：这两个 bug 都是**静默**的 ——
 *   ① 孩子点一下麦克风就松手，停止信号比 onStart 先到，被丢弃 → 录音一路录满 6 秒 →
 *     落进「时长 > 3.2s」分支 → 啥也没说也拿 2 星（线上真实投诉：「读得不对但声音大也三星」的邻居问题）。
 *   ② audio.stop() 会主动 resolve 上一段的 Promise，所以 `playWord().then(playPhrase)` 里的
 *      **例句会等到页面卸载之后才播**，声音串到下一个页面。
 *
 * 用法： node learn-runtime-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', 'starwords-miniprogram');
const learnPath = path.join(ROOT, 'pages', 'learn', 'learn.js');
const learnSrc = fs.readFileSync(learnPath, 'utf8');

let failed = 0;
function check(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}

const WORDS5 = [];
for (let i = 1; i <= 5; i++) {
  WORDS5.push({ id: 'w1-' + i, word: 'Word' + i, meaning: '词' + i, audio: 'w1-' + i, phraseAudio: 'p1-' + i, phrase: 'p' + i });
}

/* ---------- 可控的音频桩：play 的 Promise 由 finishCurrent() 决定何时 resolve ---------- */
let segResolve = null;
const phraseCalls = [];
const audioStub = {
  play: function () {
    return new Promise((resolve) => {
      segResolve = resolve;
    });
  },
  playPhrase: function (id) {
    phraseCalls.push(id);
    return Promise.resolve();
  },
  stop: function () {
    // 真实实现：destroyCtx → clearStopTimer → 立刻 resolve 上一段
    if (segResolve) {
      const r = segResolve;
      segResolve = null;
      r();
    }
  },
};
function finishCurrent() {
  if (segResolve) {
    const r = segResolve;
    segResolve = null;
    r();
  }
}

/* ---------- 本地录音器桩 ---------- */
const rec = {
  stopped: 0,
  starting: false,
  onStartCb: null,
  onStopCb: null,
  onErrorCb: null,
  start: function () {
    rec.starting = true;
  },
  stop: function () {
    rec.stopped++;
    rec.starting = false;
  },
  onStart: function (cb) {
    rec.onStartCb = cb;
  },
  onStop: function (cb) {
    rec.onStopCb = cb;
  },
  onError: function (cb) {
    rec.onErrorCb = cb;
  },
  // 模拟 start → onStart 的真实延迟
  fireStart: function () {
    if (rec.onStartCb) rec.onStartCb();
  },
};

let pageDef = null;
const sandbox = {
  console: console,
  module: { exports: {} },
  exports: {},
  require: function (id) {
    if (id === '../../utils/words')
      return {
        WORDS: WORDS5,
        WORDS_PER_WEEK: 5,
        getWeekWords: function () {
          return WORDS5;
        },
      };
    if (id === '../../utils/store')
      return {
        getProgress: function () {
          return { words: [], currentWeek: 1 };
        },
        currentGrade: function () {
          return { id: 'g1', name: '一年级' };
        },
        nextUnitInGrade: function () {
          return 1;
        },
        gradeStats: function () {
          return { total: 5, learned: 0, available: true };
        },
        markWordLearned: function () {},
        creditStars: function () {
          return 0;
        },
        refreshAchievements: function () {
          return [];
        },
        completeDailySession: function () {},
        currentGradeMaxUnit: function () {
          return 40;
        },
        advanceGrade: function () {
          return null;
        },
        syncToCloud: function () {
          return Promise.resolve();
        },
        ACHIEVEMENTS: [],
      };
    if (id === '../../utils/scheduler') return { localToday: () => '2026-10-22' };
    if (id === '../../utils/audio') return audioStub;
    if (id === '../../utils/record-score')
      return {
        gradeFile: function () {
          return Promise.resolve(null);
        },
        gradeBySoe: function () {
          return { starCount: 0, level: 'none', message: '' };
        },
      };
    if (id === '../../utils/match') return { buildPuzzle: function () {} };
    if (id === '../../utils/leaderboard')
      return {
        push: function () {},
        getNickname: function () {
          return '星星学员';
        },
      };
    throw new Error('learn-runtime-check: 未预期的 require → ' + id);
  },
  Page: function (o) {
    pageDef = o;
  },
  wx: {
    nextTick: function (fn) {
      fn();
    },
    getRecorderManager: function () {
      return rec;
    },
    showToast: function () {},
    vibrateShort: function () {},
    createInnerAudioContext: function () {
      return { play: function () {}, stop: function () {}, destroy: function () {} };
    },
  },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Promise: Promise,
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(learnSrc, sandbox, { filename: learnPath });

check(!!pageDef, '[0] 成功捕获真实 pages/learn/learn.js 的 Page 定义');
if (!pageDef) {
  console.error('\n学习页自检失败：Page 定义缺失 ✗');
  process.exit(1);
}

function makePage() {
  const p = Object.assign({}, pageDef);
  p.data = JSON.parse(JSON.stringify(pageDef.data));
  p.wordScores = {};
  p.wordBestStars = 0;
  p.sessionStars = 0;
  p.matchPlayed = false;
  p.matchWords = [];
  p.matchTimer = null;
  p.recorder = null;
  p.recordPath = null;
  p.playbackCtx = null;
  p.setData = function (patch) {
    Object.keys(patch).forEach(function (k) {
      p.data[k] = patch[k];
    });
  };
  return p;
}

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

(async function main() {
  console.log('[1] 点一下就松手：停止信号不能被丢掉');
  {
    rec.stopped = 0;
    const p = makePage();
    p.onLoad();
    finishCurrent(); // 卡片自动朗读先结束，避免干扰
    await flush();

    rec.stopped = 0;
    p.onStartRecord(); // 按下麦克风：start 已调用，但 onStart 还没回调
    check(!!rec.starting, '按下后录音器已 start');
    check(p.data.recording === false, '此刻 recording 仍为 false（onStart 还没到）');

    p.onStopRecord(); // 松手
    check(rec.stopped === 0, '松手时不会直接 stop（录音器还没真正开始）');
    check(p.pendingStop === true, '记下了「松手」这件事');

    rec.fireStart(); // onStart 终于到达
    check(p.data.recording === true, 'onStart 后进入录音态');
    check(rec.stopped === 1, '★onStart 一到立刻补停（不会一路录满 6 秒）');
    check(p.pendingStop === false, '补停后标记清掉，不影响下一次录音');
  }

  console.log('[2] 正常录音不被打断');
  {
    rec.stopped = 0;
    const p = makePage();
    p.onLoad();
    finishCurrent();
    await flush();

    p.onStartRecord();
    rec.fireStart();
    check(rec.stopped === 0, '正常按住时不会被误停');
    p.onStopRecord();
    check(rec.stopped === 1, '松手后 stop 恰好调用一次');
  }

  console.log('[3] 页面卸载后不能补播例句');
  {
    phraseCalls.length = 0;
    const p = makePage();
    p.onLoad(); // autoRead：先读单词（Promise 挂着）
    p.onUnload(); // 卸载 → audio.stop() 会 resolve 上一段
    await flush();
    check(p.alive === false, '卸载后 alive 变 false');
    check(phraseCalls.length === 0, '★卸载后没有例句被补播（声音不会串到下一页面）');
  }

  console.log('[4] 正常流程仍然「先单词后例句」');
  {
    phraseCalls.length = 0;
    const p = makePage();
    p.onLoad();
    check(phraseCalls.length === 0, '单词还没播完时不抢先读例句');
    finishCurrent();
    await flush();
    check(phraseCalls.length === 1, '单词播完后自动读例句（正常流程没被破坏）');
  }

  console.log('[5] 卸载时收掉还在进行的录音');
  {
    rec.stopped = 0;
    const p = makePage();
    p.onLoad();
    finishCurrent();
    await flush();
    p.onStartRecord();
    rec.fireStart();
    check(p.data.recording === true, '正在录音');
    p.onUnload();
    check(p.data.recording === false, '卸载后录音态被清掉');
    check(rec.stopped >= 1, '★卸载时调用了 recorder.stop（录音器不会在后台一直录）');
  }

  console.log('[6] 换词时收掉录音');
  {
    rec.stopped = 0;
    const p = makePage();
    p.onLoad();
    finishCurrent();
    await flush();
    p.onStartRecord();
    rec.fireStart();
    p.onNextWord();
    check(rec.stopped >= 1, '★点「下一个」时停掉上一条录音');
  }

  console.log('[7] 换词后迟到的录音结果不能算到新词上');
  {
    rec.stopped = 0;
    const p = makePage();
    p.onLoad();
    finishCurrent();
    await flush();

    p.onStartRecord();
    rec.fireStart();
    const oldWord = p.data.word.id;
    p.onNextWord(); // 换词（会 stopRecorder）
    check(p.data.word.id !== oldWord, '已切换到下一个词');
    check(p.wordBestStars === 0, '新词的「最好星级」从 0 开始');

    // 旧录音的 onStop 迟到
    if (rec.onStopCb) rec.onStopCb({ tempFilePath: 'stale.wav' });
    check(p.data.recordPath === '', '★迟到的旧录音不写进新词的回放路径');
    check(p.wordBestStars === 0, '★迟到的旧录音不会把星算到新词上');
  }

  console.log(failed ? '\n学习页自检失败：' + failed + ' 项 ✗' : '\n学习页自检全部通过 ✓');
  process.exit(failed ? 1 : 0);
})();
