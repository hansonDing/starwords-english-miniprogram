#!/usr/bin/env node
/**
 * 年级进度沙箱自检。
 *
 * 覆盖 store.js 里跟「年级」有关的全部行为。核心不变量：
 *   1. 年级内进度**从 words 推导**，不存第二份真相 → 跳级 / 回头补学自动成立
 *   2. `nextUnitInGrade` **不能跳过「学到一半」的单元**
 *   3. 「学习日指针」**不超过当前年级的末单元**（否则会跨年级跳到还没解锁的区域）
 *
 * ⚠️ 为什么必须沙箱跑：`store.js` 顶层就会调 `wx.getStorageSync` 读存档，
 * 而预览环境里没有任何 storage / 定时器可以观察。本机唯一能验的就是这里。
 *
 * 用法：node grade-runtime-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const HERE = __dirname;
const PKG = path.join(HERE, '..', 'starwords-miniprogram');
const UTILS = path.join(PKG, 'utils');
const STORE_JS = path.join(UTILS, 'store.js');

let pass = 0;
const failures = [];
const ok = (n) => {
  pass++;
  console.log('  ✓ ' + n);
};
const bad = (n, d) => {
  failures.push(n + (d ? ' —— ' + d : ''));
  console.log('  ✗ ' + n + (d ? ' —— ' + d : ''));
};
const eq = (n, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(n + ' = ' + e);
  else bad(n, '实际 ' + a + ' / 应为 ' + e);
};
const is = (n, cond, d) => {
  if (cond) ok(n);
  else bad(n, d || '');
};

/** 按 CommonJS 加载小程序目录里的真实模块（工作区根有 "type":"module"，不能直接 require） */
function loadReal(file) {
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8'), file);
  return m.exports;
}

const REAL_WORDS = loadReal(path.join(UTILS, 'words.js'));

/**
 * 造一个独立沙箱 + 一份全新存档的 store。
 *
 * @param {object} [opts]
 * @param {object} [opts.saved]       预置的本地存档（模拟老版本 / 脏数据）
 * @param {number} [opts.fakeMaxWeek] 覆盖 words.js 的 MAX_WEEK（用来制造「内容比年级多」的场景）
 */
function makeStore(opts) {
  opts = opts || {};
  const storage = {};
  if (opts.saved) storage['starwords-progress'] = JSON.stringify(opts.saved);
  const warns = [];
  const timers = [];

  const ctx = vm.createContext({
    console: {
      log() {},
      warn(m) {
        warns.push(String(m));
      },
      error() {},
    },
    // 假定时器：只记录不执行 —— store 的 setTimeout 只用于延迟云同步，
    // 真定时器会拖住进程退出，而且测试里不需要推进它。
    setTimeout(fn, ms) {
      timers.push({ fn: fn, ms: ms });
      return timers.length;
    },
    clearTimeout(id) {
      if (id) timers[id - 1] = null;
    },
    wx: {
      getStorageSync(k) {
        return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : '';
      },
      setStorageSync(k, v) {
        storage[k] = v;
      },
      removeStorageSync(k) {
        delete storage[k];
      },
    },
  });

  const cache = {};
  const deps = {};
  if (opts.fakeMaxWeek) {
    // 真实词库 + 人为放大的 MAX_WEEK。用来验证「指针上限取的是当前年级末单元，
    // 不是全库末单元」—— 当前内容下两者恰好都是 40，不注入就没有区分力。
    deps['./words'] = Object.assign({}, REAL_WORDS, { MAX_WEEK: opts.fakeMaxWeek });
  }

  function fakeRequire(request) {
    if (request === './cloud') return { cloud: null }; // 纯本地模式，不触发任何网络
    if (deps[request]) return deps[request];
    if (cache[request]) return cache[request];
    const file = path.join(UTILS, request.replace(/^\.\//, '') + '.js');
    const v = loadReal(file);
    cache[request] = v;
    return v;
  }

  const src = fs.readFileSync(STORE_JS, 'utf8');
  const factory = vm.runInContext('(function (module, exports, require) {\n' + src + '\n})', ctx, {
    filename: STORE_JS,
  });
  const mod = { exports: {} };
  factory(mod, mod.exports, fakeRequire);
  return { store: mod.exports, storage, warns, timers };
}

/** 把某个单元的词全部标记为已学 */
function learnUnit(store, unit) {
  for (const w of REAL_WORDS.getWeekWords(unit)) store.markWordLearned(w.id, 80);
}

/** 把整个年级学完 */
function learnGrade(store, gradeId) {
  for (const w of REAL_WORDS.getGradeWords(gradeId)) store.markWordLearned(w.id, 80);
}

function main() {
  console.log('年级进度沙箱自检\n');

  /* ---------------- [1] 全新存档 ---------------- */
  console.log('[1] 全新存档');
  {
    const S = makeStore();
    eq('激活年级', S.store.currentGrade().id, 'g1');
    eq('progressVersion', S.store.getProgress().progressVersion, 3);
    eq('g1 的第一个待学单元', S.store.nextUnitInGrade('g1'), 1);
    eq('缺省参数用当前激活年级', S.store.nextUnitInGrade(), 1);
    eq('当前年级末单元', S.store.currentGradeMaxUnit(), REAL_WORDS.MAX_WEEK);
    const st = S.store.gradeStats('g1');
    eq('g1 总词数', st.total, 200);
    eq('g1 已学词数', st.learned, 0);
    eq('g1 是否已开放', st.available, true);
    eq('g1 是否完成', st.completed, false);
    eq('未知年级的统计不崩', S.store.gradeStats('g-nope').total, 0);
  }

  /* ---------------- [2] 单元推进 ---------------- */
  console.log('\n[2] 单元推进');
  {
    const S = makeStore();
    learnUnit(S.store, 1);
    eq('单元 1 学完 5 词 → 指向单元 2', S.store.nextUnitInGrade('g1'), 2);
    learnUnit(S.store, 2);
    eq('单元 2 也学完 → 指向单元 3', S.store.nextUnitInGrade('g1'), 3);
  }
  {
    const S = makeStore();
    const five = REAL_WORDS.getWeekWords(1);
    for (const w of five.slice(0, 3)) S.store.markWordLearned(w.id, 80);
    eq('单元 1 只学 3 词 → 仍指向单元 1（绝不跳过没学完的单元）', S.store.nextUnitInGrade('g1'), 1);
    S.store.markWordLearned(five[3].id, 80);
    eq('学到第 4 个 → 仍指向单元 1', S.store.nextUnitInGrade('g1'), 1);
    S.store.markWordLearned(five[4].id, 80);
    eq('第 5 个也学完 → 才指向单元 2', S.store.nextUnitInGrade('g1'), 2);
  }

  /* ---------------- [3] 年级学完 ---------------- */
  console.log('\n[3] 整年级学完');
  {
    const S = makeStore();
    learnGrade(S.store, 'g1');
    eq('g1 全学完 → nextUnitInGrade 返回 null', S.store.nextUnitInGrade('g1'), null);
    const st = S.store.gradeStats('g1');
    eq('g1 已学 = 总数', st.learned, st.total);
    eq('g1 completed', st.completed, true);
    eq('g1 percent', st.percent, 100);
    eq('未灌内容的 g2 → 返回 null 而不是 g2 的第一个单元', S.store.nextUnitInGrade('g2'), null);
    eq('g2 未开放', S.store.gradeStats('g2').available, false);
  }

  /* ---------------- [4] 切年级 / 跳级 ---------------- */
  console.log('\n[4] 切年级与跳级');
  {
    const S = makeStore();
    learnUnit(S.store, 1);
    eq('切到 g3 前，g1 进度在单元 2', S.store.nextUnitInGrade('g1'), 2);

    eq('setGrade(g3) 返回新年级 id', S.store.setGrade('g3'), 'g3');
    eq('激活年级已变', S.store.currentGrade().id, 'g3');
    eq('g3 没有内容 → null', S.store.nextUnitInGrade(), null);
    eq('切年级不会动已学记录条数', S.store.getProgress().words.length, 5);
    eq('g1 的进度仍在（互不干扰）', S.store.nextUnitInGrade('g1'), 2);

    eq('切回 g1', S.store.setGrade('g1'), 'g1');
    eq('切回后待学单元仍是 2', S.store.nextUnitInGrade(), 2);

    eq('非法 id 不生效，返回当前年级', S.store.setGrade('g-nope'), 'g1');
    eq('非法 id 后年级没变', S.store.currentGrade().id, 'g1');
  }

  /* ---------------- [5] 自动前移 ---------------- */
  console.log('\n[5] 年级自动前移');
  {
    const S = makeStore();
    eq('下一级（g2）还没灌内容 → advanceGrade 返回 null', S.store.advanceGrade(), null);
    eq('年级仍留在 g1', S.store.currentGrade().id, 'g1');

    const list = S.store.gradeList();
    eq('年级卡片数量', list.length, 9);
    eq('第 1 张是 g1 且已开放', [list[0].id, list[0].available], ['g1', true]);
    eq('第 2 张是 g2 且未开放', [list[1].id, list[1].available], ['g2', false]);
    eq('恰好 1 张卡片是激活态', list.filter((g) => g.active).length, 1);
    eq('激活的是 g1', list.filter((g) => g.active)[0].id, 'g1');
    eq('g1 卡片词数', list[0].total, 200);
  }

  /* ---------------- [6] 老存档兼容 ---------------- */
  console.log('\n[6] 老存档 / 脏数据');
  {
    const S = makeStore({ saved: { progressVersion: 2, currentWeek: 1, words: [] } });
    eq('缺 currentGrade → 反推 g1', S.store.currentGrade().id, 'g1');
    eq('progressVersion 补到 3', S.store.getProgress().progressVersion, 3);
  }
  {
    // 关键区分力用例：学习日已经累加到 200（跨了多个年级的量级），
    // 但实际只学过第 5 单元的词 → 必须按**已学词的最大单元号**反推成 g1，
    // 而不是拿 currentWeek 去撞出 g6。这正是「currentWeek 不再等于单元号」的体现。
    const S = makeStore({
      saved: {
        progressVersion: 2,
        currentWeek: 200,
        words: [{ wordId: 'w5-1', learned: true, score: 90 }],
      },
    });
    eq('按已学词反推年级（不是按学习日）', S.store.currentGrade().id, 'g1');
    is(
      '用例前提：200 天真会被算成 g6，所以本用例有区分力',
      REAL_WORDS.gradeOfWeek(200).id === 'g6',
      'gradeOfWeek(200) = ' + REAL_WORDS.gradeOfWeek(200).id
    );
  }
  {
    const S = makeStore({ saved: { progressVersion: 3, currentWeek: 1, currentGrade: 'g-typo', words: [] } });
    eq('非法 currentGrade 被修正', S.store.currentGrade().id, 'g1');
  }
  {
    const S = makeStore({ saved: { progressVersion: 3, currentWeek: 1, currentGrade: 123, words: null } });
    eq('currentGrade 是数字 → 反推', S.store.currentGrade().id, 'g1');
    eq('words 是 null → 归一成数组', Array.isArray(S.store.getProgress().words), true);
  }

  /* ---------------- [7] 学习日指针不跨年级 ---------------- */
  console.log('\n[7] completeDailySession 不跨年级');
  {
    // 注入 MAX_WEEK = 100（模拟「已经灌了更多内容」）。
    // 此时 g1 的末单元是 40，全库末单元是 100 —— 两者不同，用例才有区分力。
    const S = makeStore({ fakeMaxWeek: 100 });
    is(
      '用例前提：MAX_WEEK(100) ≠ 当前年级末单元(40)',
      S.store.currentGradeMaxUnit() === 40,
      'currentGradeMaxUnit() = ' + S.store.currentGradeMaxUnit()
    );
    S.store.setProgress(
      Object.assign({}, S.store.getProgress(), { currentWeek: 40, lastLearnedDate: null })
    );
    S.store.completeDailySession(S.store.currentGradeMaxUnit(), '2026-10-16');
    eq('指针停在 40（当前年级末单元），没有跳到 41', S.store.getProgress().currentWeek, 40);
    S.store.completeDailySession(S.store.currentGradeMaxUnit(), '2026-10-17');
    eq('再结算一次仍停在 40', S.store.getProgress().currentWeek, 40);
  }
  {
    const S = makeStore();
    S.store.setProgress(
      Object.assign({}, S.store.getProgress(), { currentWeek: 10, lastLearnedDate: null })
    );
    S.store.completeDailySession(S.store.currentGradeMaxUnit(), '2026-10-16');
    eq('还没到末单元时指针正常 +1', S.store.getProgress().currentWeek, 11);
  }

  /* ---------------- [8] 汇总 ---------------- */
  console.log('\n[8] 汇总口径');
  {
    const S = makeStore();
    learnUnit(S.store, 1);
    const t = S.store.totalStats();
    eq('totalStats.total', t.total, 200);
    eq('totalStats.learned', t.learned, 5);
    eq('totalStats.gradeName', t.gradeName, '一年级');
    eq('totalStats.days', t.days, 1);
    eq('totalStats.streak', t.streak, 0);
    eq('gradeList 的已学合计 = 学过的词数', S.store.gradeList().reduce((a, g) => a + g.learned, 0), 5);
  }

  report();
}

function report() {
  console.log('\n────────────────────────────────────────');
  if (failures.length === 0) {
    console.log('全部通过（' + pass + ' 项）');
    process.exit(0);
  }
  console.log('通过 ' + pass + ' 项，失败 ' + failures.length + ' 项：');
  for (const f of failures.slice(0, 25)) console.log('  - ' + f);
  if (failures.length > 25) console.log('  …还有 ' + (failures.length - 25) + ' 项');
  process.exit(1);
}

main();
