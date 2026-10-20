/**
 * PK 挑战运行时自检：真跑 pages/pk-create/pk-create.js 与 pages/pk-play/pk-play.js。
 *
 * 为什么需要：这三件事全是**静默**的，静态检查一个字都看不出来 ——
 *   ① **防刷**。同一场 PK 重复进入（孩子返回再进、重开小程序）不能重复发星，
 *      否则星星余额可以无限刷。星星数错了界面完全正常。
 *   ② **未登录也能答**。孩子点开分享卡片时大概率没登录。要是被登录墙挡住，
 *      验收时用登录号一测是通的，真机上却是「点开就出不来」。
 *   ③ **答错后小人必须复原**。变黑状态要是没清掉，后面每道题的小人都是黑的。
 *
 * 做法：把真实页面放进 vm 沙箱执行，捕获 Page({...})，
 * 云端（cloud / pkCloud）换成可控桩，**store 与 pk 用真实模块**（否则测的是替身不是产品）。
 * setTimeout 收进队列手动推进（答对/答错的延迟推进是流程的一部分，不能让它同步跑完）。
 *
 * 用法： node pk-runtime-check.cjs
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
function flush() {
  // 让页面里的 Promise 链（fetch → isPlayable → startPlay）走完
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}
function flushTwice() {
  return flush().then(flush);
}

/* ---------- 测试词库（25 词，够抽干扰项） ---------- */
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
  return (
    ALL_WORDS.filter(function (x) {
      return x.id === id;
    })[0] || null
  );
}

const realPk = loadCjs(path.join(ROOT, 'utils', 'pk.js'));
const realScheduler = loadCjs(path.join(ROOT, 'utils', 'scheduler.js'));
const realAvatar = loadCjs(path.join(ROOT, 'utils', 'avatar.js'));
const STORE_PATH = path.join(ROOT, 'utils', 'store.js');
const STORE_SRC = fs.readFileSync(STORE_PATH, 'utf8');

/**
 * 造一个**真实** store 实例（纯本地模式，cloud 桩掉）。
 * 星星账本必须跑真代码 —— 防刷逻辑在它里面。
 */
function makeRealStore(storage) {
  const mod = { exports: {} };
  const sandbox = {
    console: { log: function () {}, error: console.error },
    wx: {
      getStorageSync: function (k) {
        return storage[k];
      },
      setStorageSync: function (k, v) {
        storage[k] = v;
      },
    },
    module: mod,
    exports: mod.exports,
    require: function (id) {
      if (id === './scheduler') return realScheduler;
      if (id === './avatar') return realAvatar;
      if (id === './cloud') return { cloud: null, cloudError: '', available: false };
      // 年级功能之后 store 也依赖词库（gradeOfWeek / getWeekWords）—— 纯数据，直接加载真实文件
      if (id === './words') return loadCjs(path.join(ROOT, 'utils', 'words.js'));
      throw new Error('pk-runtime-check: store 未预期的 require → ' + id);
    },
    // 云同步防抖的定时器：回空实现，避免挂起的定时器拖住测试进程
    setTimeout: function () {
      return 0;
    },
    clearTimeout: function () {},
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(STORE_SRC, sandbox, { filename: STORE_PATH });
  return sandbox.module.exports;
}

/* ---------- 可控云端桩 ---------- */
let sessionStub = null; // { user: { id } } 或 null
let fetchResult = null;
let createOk = true;
let submitOk = true;
const submitted = [];
const created = [];

const fakeCloud = {
  auth: {
    getSession: function () {
      return Promise.resolve({ data: sessionStub });
    },
  },
};
const fakePkCloud = {
  create: function (payload) {
    created.push(payload);
    return Promise.resolve(createOk);
  },
  fetch: function () {
    return Promise.resolve(fetchResult);
  },
  submitResult: function (id, payload) {
    submitted.push({ id: id, payload: payload });
    return Promise.resolve(submitOk);
  },
  listMine: function () {
    return Promise.resolve([]);
  },
};
const fakeLeaderboard = {
  getNickname: function () {
    return '星星学员';
  },
  setNickname: function (x) {
    return x;
  },
  DEFAULT_NICKNAME: '星星学员',
  NICKNAME_KEY: 'starwords-nickname',
};

/* ---------- wx 桩 + 可控定时器 ---------- */
const toasts = [];
const navigations = [];
let timers = [];
function runTimers() {
  const pending = timers;
  timers = [];
  for (let i = 0; i < pending.length; i++) pending[i].fn();
}
const wxStub = {
  showToast: function (o) {
    toasts.push(o && o.title);
  },
  showLoading: function () {},
  hideLoading: function () {},
  setNavigationBarTitle: function () {},
  switchTab: function (o) {
    navigations.push(o && o.url);
  },
  redirectTo: function (o) {
    navigations.push(o && o.url);
  },
  navigateTo: function (o) {
    navigations.push(o && o.url);
  },
  vibrateShort: function () {},
  getAccountInfoSync: function () {
    return { miniProgram: { appId: 'touristappid' } };
  },
};

function loadPage(pagePath, stubs) {
  let def = null;
  const sandbox = {
    console: console,
    module: { exports: {} },
    exports: {},
    require: function (id) {
      if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
      throw new Error('pk-runtime-check: 未预期的 require（' + pagePath + '）→ ' + id);
    },
    Page: function (o) {
      def = o;
    },
    wx: wxStub,
    setTimeout: function (fn) {
      timers.push({ fn: fn });
      return timers.length;
    },
    clearTimeout: function () {},
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(pagePath, 'utf8'), sandbox, { filename: pagePath });
  return def;
}

function makePage(def) {
  const p = Object.assign({}, def);
  p.data = JSON.parse(JSON.stringify(def.data));
  p.setData = function (patch) {
    Object.keys(patch).forEach(function (k) {
      p.data[k] = patch[k];
    });
  };
  return p;
}

const CREATE_PATH = path.join(ROOT, 'pages', 'pk-create', 'pk-create.js');
const PLAY_PATH = path.join(ROOT, 'pages', 'pk-play', 'pk-play.js');

// 两个页面的 store 各自独立（出题方读进度 / 答题方记星星）
const createStore = makeRealStore({});
const playStore = makeRealStore({});
// 给答题方预置一点学习记录，避免干扰（PK 星星走独立账本，不该碰 words）
playStore.markWordLearned('w1-1', 90);

const createStubs = {
  '../../utils/words': { getWordById: wordById, WORDS: ALL_WORDS },
  '../../utils/cloud': { cloud: fakeCloud, cloudError: '', available: true },
  '../../utils/store': createStore,
  '../../utils/avatar': realAvatar,
  '../../utils/pk': realPk,
  '../../utils/pkCloud': fakePkCloud,
  '../../utils/leaderboard': fakeLeaderboard,
};
const playStubs = {
  '../../utils/words': { WORDS: ALL_WORDS, getWordById: wordById },
  '../../utils/cloud': { cloud: fakeCloud, cloudError: '', available: true },
  '../../utils/store': playStore,
  '../../utils/avatar': realAvatar,
  '../../utils/pk': realPk,
  '../../utils/pkCloud': fakePkCloud,
  '../../utils/leaderboard': fakeLeaderboard,
};

const createDef = loadPage(CREATE_PATH, createStubs);
const playDef = loadPage(PLAY_PATH, playStubs);

check(!!createDef, '[0] 捕获真实 pages/pk-create/pk-create.js 的 Page 定义');
check(!!playDef, '[0] 捕获真实 pages/pk-play/pk-play.js 的 Page 定义');
if (!createDef || !playDef) {
  console.error('\nPK 运行时自检失败：Page 定义缺失 ✗');
  process.exit(1);
}

/** 作答一道题；correct=false 时故意选别的选项 */
function answerOne(p, correct) {
  const q = p.data.current;
  if (!q) return;
  const idx = correct ? q.answerIdx : (q.answerIdx + 1) % q.options.length;
  p.onPickOption({ currentTarget: { dataset: { idx: idx } } });
}
/** 推进所有挂起的延迟（答对/答错后的自动进下一题） */
function advance() {
  runTimers();
}

/** 生成一场可作答的挑战行 */
function challenge(id, wordIds, extra) {
  return Object.assign(
    {
      id: id,
      status: 'pending',
      challenger_id: 'u1',
      challenger_name: '小明',
      word_ids: wordIds,
    },
    extra || {}
  );
}

async function main() {
  /* ================= 一、出题页 ================= */
  console.log('[1] 出题页：选人 → 勾词 → 生成挑战 → 分享卡片');
  {
    const p = makePage(createDef);
    p.onLoad({ target: 'u2', name: encodeURIComponent('小明') });
    check(p.data.targetName === '小明', '指定对象 → targetName 解码正确（小明）');
    check(p.data.targetId === 'u2', 'targetId 传入正确');
    check(p.data.headTitle === '挑战 小明', '标题带上了对方名字');

    // 昵称含 & % 等字符：框架可能已解码，也可能没解码，两种都不能崩
    const p2 = makePage(createDef);
    p2.onLoad({ target: 'u3', name: encodeURIComponent('A&B%2') });
    check(p2.data.targetName === 'A&B%2', '编码过的特殊昵称 A&B%2 解码正确');
    const p3 = makePage(createDef);
    p3.onLoad({ target: 'u4', name: 'A&B%2' }); // 已被框架解码过的形态
    check(p3.data.targetName === 'A&B%2', '已解码的特殊昵称不被二次解码搞坏（safeDecode 兜住）');

    // 没学过词 → 不许出题
    const empty = makePage(createDef);
    empty.onLoad({});
    check(arr(empty.data.candidates).length === 0, '没学过的词时候选为空');
    check(empty.data.canCreate === false, '候选为空 → 不能生成挑战');
    empty.onCreate();
    check(empty.data.mode === 'pick', '候选不足时 onCreate 不进入分享态（提前返回）');

    // 学 5 个词
    const ids = ['w1-1', 'w1-2', 'w1-3', 'w1-4', 'w1-5'];
    ids.forEach(function (id) {
      createStore.markWordLearned(id, 90);
    });
    const q = makePage(createDef);
    q.onLoad({});
    check(arr(q.data.candidates).length === 5, '列出我学过的 5 个单词（实际 ' + arr(q.data.candidates).length + '）');
    check(arr(q.data.candidates)[0].meaning === '词1-1', '候选带中文含义');
    check(arr(q.data.candidates)[0].phonetic === '/w11/', '候选带音标');

    q.onToggle({ currentTarget: { dataset: { id: 'w1-1' } } });
    q.onToggle({ currentTarget: { dataset: { id: 'w1-2' } } });
    check(q.data.pickedCount === 2, '点选 2 个 → pickedCount = 2');
    check(q.data.canCreate === false, '只选 2 个（< 3）→ 仍不能生成');
    q.onToggle({ currentTarget: { dataset: { id: 'w1-1' } } });
    check(q.data.pickedCount === 1, '再点一次取消勾选 → 1 个');

    q.onSelectAll();
    check(q.data.pickedCount === 5, '全选 → 5 个');
    check(q.data.canCreate === true, '选够了 → 可以生成');
    q.onClearAll();
    check(q.data.pickedCount === 0, '清空 → 0 个');

    // 生成挑战：必须先登录（出题者身份要写进挑战行）
    sessionStub = null;
    const anon = makePage(createDef);
    anon.onLoad({});
    anon.onSelectAll();
    anon.onCreate();
    await flushTwice();
    check(anon.data.mode === 'fail', '未登录时生成挑战 → 走失败态而不是静默无反应');
    check(String(anon.data.failText).indexOf('登录') !== -1, '失败文案明确要求先登录');

    sessionStub = { user: { id: 'u1' } };
    created.length = 0;
    const ok = makePage(createDef);
    ok.onLoad({ target: 'u2', name: encodeURIComponent('小明') });
    ok.onSelectAll();
    ok.onCreate();
    await flushTwice();
    check(ok.data.mode === 'ready', '已登录 + 选够词 → 进入待分享态');
    check(created.length === 1, '挑战已写入云端（create 被调用 1 次）');
    check(!!created[0] && created[0].wordIds.length === 5, '写入的题目是勾选的 5 个词');
    check(!!created[0] && created[0].challengerId === 'u1', '挑战行带上了出题者 uid');
    check(!!created[0] && created[0].targetId === 'u2', '挑战行带上了挑战对象');
    check(!!ok.data.pkId && ok.data.pkId === created[0].id, '挑战 id 与云端写入的一致');

    const share = ok.onShareAppMessage();
    check(
      share.path === '/pages/pk-play/pk-play?id=' + ok.data.pkId,
      '★分享卡片 path 指向这场 PK（' + share.path + '）'
    );
    check(String(share.title).indexOf('星星学员') !== -1, '分享标题带出题者昵称');
    check(!!ok.data.pkId, 'pkId 非空（为空的话卡片 path 会失效）');

    // 云端写入失败 → 明确失败，不要给一个「看着能分享其实没人能打开」的卡片
    createOk = false;
    const bad = makePage(createDef);
    bad.onLoad({});
    bad.onSelectAll();
    bad.onCreate();
    await flushTwice();
    check(bad.data.mode === 'fail', '云端写入失败 → 失败态（不暴露无效分享按钮）');
    createOk = true;
  }

  /* ================= 二、答题页 ================= */
  console.log('[2] 答题页：全对 → 得星 + 回传');
  {
    sessionStub = { user: { id: 'u2' } };
    fetchResult = challenge('pk-a', ['w1-1', 'w1-2', 'w1-3']);
    submitted.length = 0;

    const p = makePage(playDef);
    p.onLoad({ id: 'pk-a' });
    await flushTwice();
    check(p.data.mode === 'playing', '加载成功 → 答题中');
    check(p.data.total === 3, '3 道题（实际 ' + p.data.total + '）');
    check(p.data.challengerName === '小明', '带出题者昵称');
    check(arr(p.data.current.options).length === 4, '每题 4 个选项');

    const before = playStore.getStarBalance();
    for (let i = 0; i < 3; i++) {
      answerOne(p, true);
      advance();
    }
    check(p.data.mode === 'done', '答完 → 结算页');
    check(p.data.correctCount === 3, '全对 3/3');
    check(p.data.earnedStars === 3, '★得 3 颗星（答对 1 题 = 1 星）');
    check(playStore.getStarBalance() === before + 3, '★星星进了账户余额（' + before + ' → ' + playStore.getStarBalance() + '）');
    check(arr(p.data.wrongList).length === 0, '全对 → 无错题');

    await flushTwice();
    check(submitted.length === 1, '成绩已回传云端');
    check(!!submitted[0] && submitted[0].payload.result.correctCount === 3, '回传的分数正确');
    check(!!submitted[0] && submitted[0].payload.playedBy === 'u2', '回传带上作答者 uid');
    check(p.data.resultSent === true, '界面显示「成绩已告诉小明」');
  }

  console.log('[3] 防刷：同一场 PK 二次进入不能再得星');
  {
    const p = makePage(playDef);
    p.onLoad({ id: 'pk-a' }); // 同一个 id
    await flushTwice();
    check(p.data.mode === 'playing', '同一场 PK 仍可重玩（只是不给星）');
    const before = playStore.getStarBalance();
    for (let i = 0; i < 3; i++) {
      answerOne(p, true);
      advance();
    }
    check(p.data.mode === 'done', '重玩也能走完');
    check(p.data.correctCount === 3, '重玩仍显示 3/3（成绩照算）');
    check(p.data.earnedStars === 0, '★本次得星 = 0（一场 PK 只结算一次）');
    check(playStore.getStarBalance() === before, '★账户余额没有被重复加星（仍是 ' + before + '）');
  }

  console.log('[4] ★未登录也能作答（不被登录墙挡住）');
  {
    sessionStub = null;
    fetchResult = challenge('pk-b', ['w1-1', 'w1-2']);
    const p = makePage(playDef);
    p.onLoad({ id: 'pk-b' });
    await flushTwice();
    check(p.data.mode === 'playing', '★未登录 → 直接进入答题，而不是 blocked');
    const before = playStore.getStarBalance();
    answerOne(p, true);
    advance();
    answerOne(p, false);
    advance();
    check(p.data.mode === 'done', '未登录也能答完');
    check(p.data.earnedStars === 1, '答对 1 题 → 得 1 颗星');
    check(playStore.getStarBalance() === before + 1, '★未登录也照样入账（星星记在本机）');
    check(p.data.correctCount === 1 && arr(p.data.wrongList).length === 1, '1 对 1 错，错题列表 1 条');
  }

  console.log('[5] 答错的雷击与变黑（小程序人必须复原）');
  {
    sessionStub = { user: { id: 'u2' } };
    fetchResult = challenge('pk-c', ['w1-1', 'w1-2', 'w1-3']);
    const p = makePage(playDef);
    p.onLoad({ id: 'pk-c' });
    await flushTwice();

    const q0 = p.data.current;
    const wrongIdx = (q0.answerIdx + 1) % q0.options.length;
    p.onPickOption({ currentTarget: { dataset: { idx: wrongIdx } } });
    // 延迟推进还没跑，此时应该正处于「刚被雷劈」的状态
    check(p.data.figureDark === true, '★答错瞬间 → 小人变黑（figureDark）');
    check(p.data.figureHit === true, '★答错瞬间 → 触发雷击动画（figureHit）');
    check(p.data.flashing === true, '★答错瞬间 → 全屏白闪（flashing）');
    check(p.data.pickedIdx === wrongIdx && p.data.pickedCorrect === false, '选中项标记为「错」');
    check(p.data.answered === true, '已作答（连点不会重复触发）');

    advance();
    check(p.data.figureDark === false, '★进下一题时小人已复原（不清掉的话后面每题都是黑的）');
    check(p.data.figureHit === false && p.data.flashing === false, '雷击 / 白闪状态也已复位');
    check(p.data.qi === 1, '已推进到第 2 题');
    check(arr(p.data.dots)[0].done === true, '第 1 题进度点点亮');

    // 答对：跳跃 + 飘星
    const q1 = p.data.current;
    p.onPickOption({ currentTarget: { dataset: { idx: q1.answerIdx } } });
    check(p.data.figureHappy === true, '答对 → 小人跳起来');
    check(p.data.floatStar === true, '答对 → 飘出 +1 ⭐');
    check(p.data.pickedCorrect === true, '选中项标记为「对」');
    advance();

    // 最后一题
    const q2 = p.data.current;
    p.onPickOption({ currentTarget: { dataset: { idx: q2.answerIdx } } });
    advance();
    check(p.data.mode === 'done', '答完 → 结算');
    check(p.data.correctCount === 2, '对 2 题');
    check(arr(p.data.wrongList).length === 1, '错题列表 1 条');
    // ⚠️ 不能假设第 1 题就是某个词 —— buildQuestions 会打乱题序。
    // 用「第 1 题实际选的错误选项」对照，才是真正在验「给的是正确含义」。
    const w0 = arr(p.data.wrongList)[0];
    const wrongOptionText = q0.options[wrongIdx];
    check(!!w0 && w0.wordId === q0.wordId, '错题就是刚才答错的那道题');
    check(!!w0 && w0.word === q0.word, '错题带着该题的正确单词（' + (w0 && w0.word) + '）');
    check(!!w0 && w0.meaning !== wrongOptionText, '★错题带的是**正确**含义，而不是孩子点错的那个（' + (w0 && w0.meaning) + ' ≠ ' + wrongOptionText + '）');
    check(!!w0 && w0.meaning === wordById(w0.wordId).meaning, '错题含义与词库一致');
    check(!!arr(p.data.wrongList)[0].phonetic, '错题带音标');
    check(p.data.earnedStars === 2, '得 2 颗星');
  }

  console.log('[6] 答错后不再重复判题（连点保护）');
  {
    fetchResult = challenge('pk-d', ['w1-1', 'w1-2']);
    const p = makePage(playDef);
    p.onLoad({ id: 'pk-d' });
    await flushTwice();
    const q0 = p.data.current;
    const wrongIdx = (q0.answerIdx + 1) % q0.options.length;
    p.onPickOption({ currentTarget: { dataset: { idx: wrongIdx } } });
    p.onPickOption({ currentTarget: { dataset: { idx: q0.answerIdx } } }); // 立刻再点正确答案
    check(p.data.pickedIdx === wrongIdx, '★连点第二次被忽略（第一判即终判，不能靠连点改答案）');
    check(p.data.answered === true, 'answered 保持 true');
    advance();
  }

  /* ================= 三、放行规则 ================= */
  console.log('[7] 不能作答的情况要有明确说法');
  {
    sessionStub = { user: { id: 'u2' } };

    fetchResult = challenge('pk-e', ['w1-1'], { status: 'done', played_by: 'u3' });
    const a = makePage(playDef);
    a.onLoad({ id: 'pk-e' });
    await flushTwice();
    check(a.data.mode === 'blocked', '已被答过的挑战 → blocked（先到先得）');
    check(String(a.data.blockedTitle).indexOf('结束') !== -1, '文案说明「已经结束」：' + a.data.blockedTitle);

    sessionStub = { user: { id: 'u1' } };
    fetchResult = challenge('pk-f', ['w1-1']);
    const b = makePage(playDef);
    b.onLoad({ id: 'pk-f' });
    await flushTwice();
    check(b.data.mode === 'blocked', '自己发起的挑战 → blocked');
    check(String(b.data.blockedTitle).indexOf('自己') !== -1, '文案说明「这是你自己发起的」：' + b.data.blockedTitle);

    sessionStub = { user: { id: 'u2' } };
    fetchResult = null;
    const c = makePage(playDef);
    c.onLoad({ id: 'pk-gone' });
    await flushTwice();
    check(c.data.mode === 'blocked', '挑战不存在 → blocked（而不是白屏）');
    check(!!c.data.blockedText, '给了兜底说明文案');

    const d = makePage(playDef);
    d.onLoad({}); // 没有 id
    check(d.data.mode === 'blocked', '链接缺 id → blocked（不发起网络请求）');

    // 词库对不上（出题者用了新词 / 老客户端）：说清楚，不要静默空白
    fetchResult = challenge('pk-h', ['nope-1', 'nope-2']);
    const e = makePage(playDef);
    e.onLoad({ id: 'pk-h' });
    await flushTwice();
    check(e.data.mode === 'blocked', '题目一个都还原不出来 → blocked');
    check(String(e.data.blockedTitle).indexOf('加载') !== -1, '文案指向「题目加载不出来」：' + e.data.blockedTitle);
  }

  console.log('[8] 断网也要能拿星（本地入账先于回传）');
  {
    sessionStub = { user: { id: 'u2' } };
    fetchResult = challenge('pk-i', ['w2-1', 'w2-2']);
    submitOk = false; // 回传失败
    const p = makePage(playDef);
    p.onLoad({ id: 'pk-i' });
    await flushTwice();
    const before = playStore.getStarBalance();
    answerOne(p, true);
    advance();
    answerOne(p, true);
    advance();
    await flushTwice();
    check(p.data.mode === 'done', '回传失败也能正常进结算页');
    check(p.data.earnedStars === 2, '★回传失败照样得 2 颗星（先本地入账再回传）');
    check(playStore.getStarBalance() === before + 2, '★星星确实进了账户（不依赖网络）');
    check(p.data.resultSent === false, '界面如实显示「成绩会先记在本机」');
    submitOk = true;
  }

  console.log(failed ? '\nPK 运行时自检失败：' + failed + ' 项 ✗' : '\nPK 运行时自检全部通过 ✓');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
  console.error('\nPK 运行时自检异常终止：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
