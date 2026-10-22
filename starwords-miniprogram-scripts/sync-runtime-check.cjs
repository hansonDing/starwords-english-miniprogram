/**
 * 云同步自检：锁住「本地进度 / 云端进度 谁覆盖谁」这条规则。
 *
 * 为什么必须单独锁：同步坏掉是**完全静默**的 —— 界面一切正常，只是数据在某次冷启动
 * 或某台设备上被另一份旧档整份覆盖。用户看到的只是「我昨天学的词没了」。
 *
 * 已发生过的事故（2026-10-22 评审）：
 *   ① 判据用 `row.updated_at` vs 词条里的 `lastAttemptAt`，而 lastAttemptAt 只在学新词时变，
 *      于是「云端永远比本地新」→ 每次冷启动本地都被覆盖。
 *   ② 登录 / 打开「我的」页是**先推后拉**，新设备本地空档先推上去，再把空档拉回来。
 *
 * 现在的契约（改代码前先读完）：
 *   · 存档自带 `updatedAt`（本地最后一次主动改动的时间戳），只有主动改才推进；
 *   · 拉取：本地空档 → 一定拉；否则「两边都有 updatedAt 且云端更大」才拉；
 *     任一方缺 updatedAt → 保守起见不动本地（宁可少拉一次，不可覆盖丢数据）；
 *   · 推送：本地是空档而云端有词 → 拒绝推送（绝不拿空档覆盖云端）。
 *
 * 用法： node sync-runtime-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', 'starwords-miniprogram');
const storePath = path.join(ROOT, 'utils', 'store.js');
const storeSrc = fs.readFileSync(storePath, 'utf8');

let failed = 0;
function check(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}

/* ---------- 极简假数据库（只实现 store.js 用到的那几个算子）---------- */
function makeDb() {
  const db = { rows: [], seq: 0 };
  function run(q) {
    const match = (r) => q.filters.every((f) => r[f[0]] === f[1]);
    if (q.op === 'insert') {
      db.seq += 1;
      const row = Object.assign({ id: 'row-' + db.seq }, q.payload);
      db.rows.push(row);
      return [{ id: row.id }];
    }
    if (q.op === 'update') {
      const hit = db.rows.filter(match);
      hit.forEach((r) => Object.assign(r, q.payload));
      return hit.map((r) => ({ id: r.id }));
    }
    let rows = db.rows.filter(match).slice();
    if (q.orderBy) {
      const col = q.orderBy[0];
      const asc = q.orderBy[1] && q.orderBy[1].ascending;
      rows.sort((a, b) => {
        const av = String(a[col] || '');
        const bv = String(b[col] || '');
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (asc ? 1 : -1);
      });
    }
    if (q.lim) rows = rows.slice(0, q.lim);
    const cols = String(q.cols || '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return rows.map((r) => {
      if (cols.length === 1 && cols[0] === '*') return JSON.parse(JSON.stringify(r));
      const out = {};
      cols.forEach((c) => {
        out[c] = r[c];
      });
      return out;
    });
  }
  const database = {
    from: function () {
      const q = { op: 'select', cols: '*', filters: [], lim: null, orderBy: null, payload: null };
      const api = {
        select: function (cols) {
          q.cols = cols;
          return api;
        },
        eq: function (col, val) {
          q.filters.push([col, val]);
          return api;
        },
        limit: function (n) {
          q.lim = n;
          return api;
        },
        order: function (col, o) {
          q.orderBy = [col, o];
          return api;
        },
        update: function (p) {
          q.op = 'update';
          q.payload = p;
          return api;
        },
        insert: function (p) {
          q.op = 'insert';
          q.payload = p;
          return api;
        },
        // 真实 SDK 的 then 回调收的是 { data, error }，不是裸数组
        then: function (res, rej) {
          return Promise.resolve({ data: run(q), error: null }).then(res, rej);
        },
      };
      return api;
    },
  };
  return { db, database };
}

/** 起一份 store.js 实例（模块级 current 是独立的，所以每个场景都要重新加载） */
function boot(options) {
  const opts = options || {};
  const { db, database } = makeDb();
  (opts.rows || []).forEach((r) => db.rows.push(JSON.parse(JSON.stringify(r))));
  db.seq = db.rows.length;

  const storage = {};
  if (opts.local) storage['starwords-progress'] = JSON.stringify(opts.local);

  const cloud = {
    auth: {
      getSession: function () {
        return Promise.resolve({ data: opts.session === undefined ? { user: { id: 'u1' } } : opts.session });
      },
    },
    database: database,
  };

  const sandbox = {
    console: console,
    module: { exports: {} },
    exports: {},
    require: function (id) {
      if (id === './cloud') return { cloud: opts.noCloud ? null : cloud };
      if (id === './scheduler') return { localToday: () => '2026-10-22' };
      if (id === './avatar') return { findById: () => null, migrateId: () => '' };
      if (id === './words')
        return {
          getWordById: () => null,
          getWeekWords: () => [],
          getGradeWords: () => [],
          gradeById: () => ({ id: 'g1' }),
          gradeOfWeek: () => ({ id: 'g1' }),
          GRADES: [{ id: 'g1' }],
          MAX_WEEK: 40,
        };
      throw new Error('sync-runtime-check: 未预期的 require → ' + id);
    },
    wx: {
      getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : ''),
      setStorageSync: (k, v) => {
        storage[k] = v;
      },
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Date: Date,
    JSON: JSON,
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(storeSrc, sandbox, { filename: storePath });
  return { store: sandbox.module.exports, db, storage };
}

function words(n, prefix) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ wordId: (prefix || 'w') + i, learned: true, score: 90, reviewStage: 0 });
  return out;
}

function tick(fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => new Promise((r) => setTimeout(r, 0)));
}

(async function main() {
  console.log('[1] 新设备（本地空档）不会被空档覆盖云端');
  {
    const rows = [
      { id: 'row-9', data: { progressVersion: 3, words: words(3, 'c'), updatedAt: 5000, stars: 7 }, updated_at: '2026-10-20T00:00:00.000Z' },
    ];
    const a = boot({ rows: rows });
    await a.store.syncToCloud();
    const after = a.db.rows[0].data;
    check(Array.isArray(after.words) && after.words.length === 3, '空本地 syncToCloud 不覆盖云端已有词条（现在是 ' + (after.words || []).length + ' 条）');
    check(after.stars === 7, '空本地 syncToCloud 不覆盖云端星星余额');

    const b = boot({ rows: JSON.parse(JSON.stringify(rows)) });
    const r = await b.store.pullFromCloud();
    check(r === 'pulled', '空本地 pullFromCloud 会拉取云端（返回 ' + r + '）');
    check(b.store.getProgress().words.length === 3, '空本地拉取后拿到云端 3 个词');
    check(b.store.getProgress().stars === 7, '空本地拉取后拿到云端星星余额');
  }

  console.log('[2] 本地较新 → 不覆盖本地');
  {
    const local = { progressVersion: 3, words: words(5), updatedAt: 2000, stars: 3 };
    const rows = [
      { id: 'row-1', data: { progressVersion: 3, words: words(3, 'c'), updatedAt: 1000, stars: 9 }, updated_at: '2026-10-20T00:00:00.000Z' },
    ];
    const a = boot({ local: local, rows: rows });
    const r = await a.store.pullFromCloud();
    check(r === null, '云端较旧 → 不拉取（返回 ' + r + '）');
    check(a.store.getProgress().words.length === 5, '本地 5 个词仍在');

    await a.store.syncToCloud();
    check(a.db.rows[0].data.words.length === 5, '推送把本地 5 个词写回云端');
    check(a.db.rows[0].data.updatedAt === 2000, '推送保留本地 updatedAt（不被服务端时间污染）');
  }

  console.log('[3] 云端较新 → 覆盖本地');
  {
    const local = { progressVersion: 3, words: words(5), updatedAt: 1000, stars: 3 };
    const rows = [
      { id: 'row-1', data: { progressVersion: 3, words: words(4, 'c'), updatedAt: 9000, stars: 11 }, updated_at: '2026-10-21T00:00:00.000Z' },
    ];
    const a = boot({ local: local, rows: rows });
    const r = await a.store.pullFromCloud();
    check(r === 'pulled', '云端较新 → 拉取（返回 ' + r + '）');
    check(a.store.getProgress().words.length === 4, '本地被替换成云端 4 个词');
    check(a.store.getProgress().stars === 11, '星星余额也一起换');
    check(a.store.getProgress().updatedAt === 9000, '拉取后本地 updatedAt 与云端对齐（不能变成本地现在）');
  }

  console.log('[4] 主动改动会推进 updatedAt');
  {
    const a = boot({ local: { progressVersion: 3, words: [], updatedAt: 1000 } });
    a.store.setProgress(Object.assign({}, a.store.getProgress(), { currentWeek: 3 }));
    const t = a.store.getProgress().updatedAt;
    check(typeof t === 'number' && t > 1000, 'setProgress 推进 updatedAt（现在 ' + t + '）');
  }

  console.log('[5] 老存档（没有 updatedAt）保持保守');
  {
    const local = { progressVersion: 3, words: words(5), stars: 3 };
    const rows = [
      { id: 'row-1', data: { progressVersion: 3, words: words(2, 'c'), updatedAt: 8000 }, updated_at: '2026-10-21T00:00:00.000Z' },
    ];
    const a = boot({ local: local, rows: rows });
    const r = await a.store.pullFromCloud();
    check(r === null, '本地缺 updatedAt → 不覆盖本地（返回 ' + r + '）');
    check(a.store.getProgress().words.length === 5, '老存档的 5 个词没被云端的 2 个词盖掉');
  }

  console.log('[6] 未登录 / 无云服务时安静跳过');
  {
    const a = boot({ local: { progressVersion: 3, words: words(2), updatedAt: 1 }, session: null });
    const r = await a.store.pullFromCloud();
    check(r === null, '无 session 时 pullFromCloud 返回 null 而不报错');
    check(a.store.getProgress().words.length === 2, '本地数据未受影响');
    const b = boot({ local: { progressVersion: 3, words: words(2), updatedAt: 1 }, noCloud: true });
    const r2 = await b.store.pullFromCloud();
    check(r2 === null, '没有云 SDK 时不崩');
  }

  console.log('[7] 主动重置进度：允许清空云端，且不会被拉回来');
  {
    const rows = [
      { id: 'row-1', data: { progressVersion: 3, words: words(5), updatedAt: 2000, stars: 9 }, updated_at: '2026-10-20T00:00:00.000Z' },
    ];
    const a = boot({ local: { progressVersion: 3, words: words(5), updatedAt: 2000, stars: 9 }, rows: rows });
    a.store.resetProgress();
    await a.store.syncToCloud();
    check(a.db.rows[0].data.words.length === 0, '★重置后推送把云端也清空（不被「空档拒推」拦下）');
    await a.store.pullFromCloud();
    check(
      a.store.getProgress().words.length === 0 && a.store.getProgress().stars === 0,
      '重置后拉取不会把旧进度 / 旧星星拉回来'
    );
  }

  console.log(failed ? '\n云同步自检失败：' + failed + ' 项 ✗' : '\n云同步自检全部通过 ✓');
  process.exit(failed ? 1 : 0);
})();
