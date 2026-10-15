/**
 * 星星账户「账本」运行时自检。
 *
 * 为什么需要：星星结算长在 utils/store.js 里（creditStars），坏掉是**静默**的 ——
 * 界面照样显示星数，只是数字不对（重复加、低星覆盖高星、掉字段导致重复计）。
 * 静态检查只能证明"函数还在"，证明不了"账算得对"。所以这里加载真实 store.js 真跑一遍。
 *
 * 做法：用 vm 沙箱 + 自定义 require，把真实的 utils/store.js 放进去执行，
 * wx.storage 换成内存实现，cloud 桩掉（纯本地），再逐条断言账本行为。
 *
 * 用法： node stars-check.cjs
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

const STORE_PATH = path.join(ROOT, 'utils', 'store.js');
const STORE_SRC = fs.readFileSync(STORE_PATH, 'utf8');
const realScheduler = loadCjs(path.join(ROOT, 'utils', 'scheduler.js'));
const realAvatar = loadCjs(path.join(ROOT, 'utils', 'avatar.js'));

/**
 * 用同一份内存 storage 造一个 store 实例。
 * 传入同一个 storage 对象两次 = 模拟「App 重启后从本机存储读回」。
 */
function makeStore(storage) {
  const mod = { exports: {} };
  const sandbox = {
    console: console,
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
      // cloud 桩掉：store 会退化成纯本地（getSession 直接 resolve(null)）
      if (id === './cloud') return { cloud: null, cloudError: '', available: false };
      throw new Error('stars-check: 未预期的 require → ' + id);
    },
    // 云同步用 setTimeout 防抖：换成空实现，避免测试进程被挂起的定时器拖住
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

function wordOf(store, id) {
  const p = store.getProgress();
  return p.words.filter(function (w) {
    return w.wordId === id;
  })[0];
}

/* ---------- 0. 模块接口 ---------- */
console.log('[0] utils/store.js 星星账户接口');
const storage = {};
let store = makeStore(storage);
if (typeof store.creditStars !== 'function') {
  check(false, 'store 未导出 creditStars（星星结算入口）');
}
if (typeof store.getStarBalance !== 'function') {
  check(false, 'store 未导出 getStarBalance（账户余额读取）');
}
if (typeof store.creditStars !== 'function' || typeof store.getStarBalance !== 'function') {
  console.error('\n星星账户自检失败：接口缺失，后续用例无法进行 ✗');
  process.exit(1);
}
check(true, '导出 creditStars / getStarBalance');
check(store.getStarBalance() === 0, '新用户初始余额为 0');

/* ---------- 1. 首次计星 ---------- */
console.log('[1] 首次计星');
store.markWordLearned('w1-1', 95);
let gained = store.creditStars('w1-1', 3);
check(gained === 3, 'creditStars(id, 3) 返回增量 3（实际 ' + gained + '）');
check(store.getStarBalance() === 3, '余额 = 3');
check(wordOf(store, 'w1-1').stars === 3, '词条上记录了已计入星数 3');

/* ---------- 2. 同一个词不重复计 ---------- */
console.log('[2] 同一个词只记一次');
check(store.creditStars('w1-1', 3) === 0, '再得同样 3 星 → 增量 0（不重复加）');
check(store.getStarBalance() === 3, '余额仍是 3');
check(store.creditStars('w1-1', 1) === 0, '再得 1 星 → 增量 0（低星不覆盖高星）');
check(store.getStarBalance() === 3, '余额仍是 3');

/* ---------- 3. 只有刷新更好成绩才补差额 ---------- */
console.log('[3] 刷新更好成绩 → 只补差额');
check(store.creditStars('w1-1', 2) === 0, '2 星仍低于已有 3 星 → 增量 0');
store.markWordLearned('w1-2', 80);
check(store.creditStars('w1-2', 1) === 1, '新词得 1 星 → 增量 1');
check(store.getStarBalance() === 4, '余额 = 4');
check(store.creditStars('w1-2', 3) === 2, '同一词刷新到 3 星 → 只补 +2');
check(store.getStarBalance() === 6, '余额 = 6（不是 1+3=4 的重复叠加）');
check(wordOf(store, 'w1-2').stars === 3, '词条已计入星数更新为 3');

/* ---------- 4. 边界：0 星 / 不存在的词 ---------- */
console.log('[4] 边界');
check(store.creditStars('w1-1', 0) === 0, '0 星（完全没听到声音）→ 不加星');
store.markWordLearned('w1-3', 70);
check(store.creditStars('w1-3', 0) === 0, '新词 0 星 → 不加星');
check(store.getStarBalance() === 6, '余额不变');
check(store.creditStars('不存在-的-词', 3) === 0, '词条不存在 → 不加星（防止绕过账本重复计）');
check(store.getStarBalance() === 6, '余额不变');
check(store.creditStars('w1-1', 9) === 0, '超出上限的星数被夹到 3，等于已有 → 增量 0');

/* ---------- 5. 持久化：重启后读回 ---------- */
console.log('[5] 持久化（模拟 App 重启）');
const store2 = makeStore(storage);
check(store2.getStarBalance() === 6, '从本机存储读回余额 6');
check(wordOf(store2, 'w1-2').stars === 3, '每词已计入星数也一起持久化了');

/* ---------- 6. 复习不丢星星字段 ---------- */
console.log('[6] 复习调度不能丢掉星星字段');
store2.recordReviewResult('w1-1', true);
check(wordOf(store2, 'w1-1').stars === 3, 'applyReviewResult 之后 word.stars 仍是 3（透传）');
store2.recordReviewResult('w1-1', false);
check(wordOf(store2, 'w1-1').stars === 3, '答错走另一分支后仍是 3');
check(store2.getStarBalance() === 6, '复习不影响账户余额');

/* ---------- 7. 重置归零 ---------- */
console.log('[7] 重置进度');
store2.resetProgress();
check(store2.getStarBalance() === 0, 'resetProgress() 后余额归 0');

/* ---------- 8. PK 星星账本（creditPkStars） ---------- */
// PK 星星和跟读星星进的是**同一个**账户余额（progress.stars），
// 但去重口径不同：跟读按「每个词只记一次最好成绩」，PK 按「每场 PK 只结算一次」。
// 为什么不能用跟读那套：PK 答的是**别人**学过的词，我自己可能还没学，
// 强行建词条会把没学过的词标成 learned，污染学习进度。
console.log('[8] PK 星星账本（同一余额，按场次去重）');
// 接口缺失时后续用例用短路保护，避免整个脚本崩在第 9 节只留一个 TypeError
const hasPk = typeof store2.creditPkStars === 'function';
if (!hasPk) {
  check(false, 'store 未导出 creditPkStars（PK 得星入口）');
} else {
  check(store2.creditPkStars('pkA', 3) === 3, '答对 3 题 → 得 3 星');
  check(store2.getStarBalance() === 3, '余额 = 3');
  check(store2.creditPkStars('pkA', 3) === 0, '同一场 PK 再进一次 → 0 星（防刷）');
  check(store2.creditPkStars('pkA', 5) === 0, '同一场 PK 答得更「好」也是 0 星（一场只结算一次）');
  check(store2.getStarBalance() === 3, '余额仍是 3');
  check(store2.creditPkStars('pkB', 2) === 2, '换一场 PK → 正常得 2 星');
  check(store2.getStarBalance() === 5, '余额 = 5（PK 星与跟读星同一个池子）');
  check(store2.creditPkStars('pkC', 0) === 0, '全错（0 星）→ 不加星');
  check(store2.getStarBalance() === 5, '余额仍是 5');
  check(store2.creditPkStars('pkD', -3) === 0, '负数星被夹到 0，不会倒扣余额');
  check(store2.getStarBalance() === 5, '余额仍是 5');
  check(store2.creditPkStars('', 3) === 0, '空 pkId → 不加星（防绕过账本）');
  check(store2.creditPkStars(null, 3) === 0, 'null pkId → 不加星');
  check(store2.getStarBalance() === 5, '余额仍是 5');
}

/* ---------- 9. PK 去重记录的持久化 ---------- */
console.log('[9] PK 去重记录要能持久化');
{
  const store3 = makeStore(storage);
  check(store3.getStarBalance() === 5, '重启后读回余额 5');
  check(hasPk && store3.creditPkStars('pkA', 3) === 0, '重启后同一场 PK 依然不重复发星（去重记录已落盘）');
  check(hasPk && store3.creditPkStars('pkE', 1) === 1, '重启后新 PK 正常发星');
  check(!hasPk || store3.getStarBalance() === 6, '余额 = 6');
}

/* ---------- 10. 旧存档（无 pkRewarded 字段）不能崩 ---------- */
console.log('[10] 旧存档兼容');
{
  const legacy = {};
  legacy['starwords-progress'] = JSON.stringify({
    progressVersion: 2,
    currentWeek: 1,
    words: [],
    streakDays: 0,
    achievements: [],
    stars: 7,
  });
  const store4 = makeStore(legacy);
  check(store4.getStarBalance() === 7, '旧存档余额保留为 7');
  check(Array.isArray(store4.getProgress().pkRewarded), '缺失的 pkRewarded 被补成空数组');
  check(hasPk && store4.creditPkStars('pkX', 2) === 2, '旧存档（字段缺失）也能正常计星');
  check(!hasPk || store4.getStarBalance() === 9, '余额 = 9');
  check(hasPk && store4.creditPkStars('pkX', 2) === 0, '旧存档升级后依然去重');

  // 值被写坏（云端脏数据 / 手动改过存档）
  const broken = {};
  broken['starwords-progress'] = JSON.stringify({
    progressVersion: 2,
    words: [],
    stars: 1,
    pkRewarded: null,
  });
  const store6 = makeStore(broken);
  check(hasPk && store6.creditPkStars('pkY', 2) === 2, 'pkRewarded 被写成 null 时仍能计星（归一化兜底）');
  check(!hasPk || store6.getStarBalance() === 3, '余额 = 3');
}

/* ---------- 11. 去重记录不会无限膨胀 ---------- */
console.log('[11] pkRewarded 上限（云同步 payload 不能无限增长）');
{
  const store5 = makeStore({});
  if (hasPk) {
    for (let i = 0; i < 105; i++) store5.creditPkStars('pkk' + i, 1);
  }
  const kept = store5.getProgress().pkRewarded || [];
  check(hasPk && kept.length === 100, '只保留最近 100 条（实际 ' + kept.length + '）');
  check(hasPk && kept.indexOf('pkk104') !== -1, '最新一场还在记录里');
  check(hasPk && kept.indexOf('pkk0') === -1, '最旧一场已被裁掉');
  check(hasPk && store5.getStarBalance() === 105, '余额是完整的 105（裁剪记录不影响已发的星）');
}

console.log(failed ? '\n星星账户自检失败：' + failed + ' 项 ✗' : '\n星星账户自检全部通过 ✓');
process.exit(failed ? 1 : 0);
