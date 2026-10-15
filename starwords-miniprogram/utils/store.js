// 学习进度存储：本地 wx.storage 为准，登录后自动同步到云数据库
const scheduler = require('./scheduler');
const avatar = require('./avatar');
const { cloud } = require('./cloud');

const STORAGE_KEY = 'starwords-progress';

const DEFAULT_PROGRESS = {
  progressVersion: 2,
  // ⚠️ 字段名叫 currentWeek，实际含义是「第几个学习日」：每完成一天的会话 +1（每天 5 个新词）。
  // 词库按 40 组 × 5 词组织（words.js 里叫 week），所以对外一律显示成「第 N 天」。
  // 改字段名会动到云端 learning_progress.data 的 schema，故保留旧名。
  currentWeek: 1,
  words: [],
  streakDays: 0,
  lastLearnedDate: null,
  achievements: [],
  // 跟读攒下的星星总数（账户余额）。只增不减地累积，未来做「消耗活动」时从这里扣。
  // 每条 word 上的 stars 记录「该词已计入的星数」，用于去重（同一个词只记一次最好成绩）。
  stars: 0,
  // PK 挑战的得星去重记录：存已结算过的挑战 id（每场 PK 只结算一次）。
  // ⚠️ 不能复用 word.stars 那套去重 —— PK 答的是**别人**学过的词，我自己可能还没学，
  //    强行建词条会把没学过的词标成 learned，污染学习进度。
  pkRewarded: [],
  // 孩子选的星星形象 id（见 utils/avatar.js）。'' = 还没选过，
  // 此时 getAvatar() 会兜底成默认形象，hasAvatar() 为 false 以便再引导一次。
  avatarId: '',
};

/** PK 去重记录的保留条数上限（云同步 payload 不能无限膨胀） */
const MAX_PK_REWARDED = 100;

/**
 * 把存档 / 云端数据归一成可用形状。
 * 每个字段都要能扛住脏数据：存档可能来自旧版本（缺字段），云端那份也可能被人手动改过。
 * 只做「类型修复」，不动业务语义。
 */
function normalizeProgress(p) {
  if (!Array.isArray(p.words)) p.words = [];
  // 旧存档没有 pkRewarded；云端也可能被改成 null → 一律归一化成数组
  if (!Array.isArray(p.pkRewarded)) p.pkRewarded = [];
  // 形象 id：缺失 / null / 数字 / 不存在的 id 一律回落成「未选择」
  // （由 hasAvatar() 判定；渲染走 getAvatar() 的兜底，不会空白）
  if (typeof p.avatarId !== 'string' || !avatar.findById(p.avatarId)) p.avatarId = '';
  return p;
}

function loadProgress() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_PROGRESS));
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return normalizeProgress(Object.assign({}, DEFAULT_PROGRESS, parsed));
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_PROGRESS));
  }
}

let current = loadProgress();
let cloudRowId = null;
let syncTimer = null;

function getProgress() {
  return current;
}

function notify() {
  // 各页面在 onShow 里重新读取；这里只负责持久化与云同步
  try {
    wx.setStorageSync(STORAGE_KEY, JSON.stringify(current));
  } catch (e) {
    /* 存储失败不影响学习 */
  }
  scheduleCloudSync();
}

function setProgress(updater) {
  const next = typeof updater === 'function' ? updater(current) : updater;
  current = next;
  notify();
}

function markWordLearned(wordId, score) {
  setProgress((prev) => {
    const idx = prev.words.findIndex((w) => w.wordId === wordId);
    const nowIso = new Date().toISOString();
    if (idx >= 0) {
      const words = prev.words.slice();
      const w = words[idx];
      words[idx] = Object.assign({}, w, {
        learned: true,
        score: Math.max(w.score, score),
        attempts: w.attempts + 1,
        lastAttemptAt: nowIso,
      });
      return Object.assign({}, prev, { words });
    }
    return Object.assign({}, prev, {
      words: prev.words.concat([
        {
          wordId: wordId,
          learned: true,
          score: score,
          attempts: 1,
          lastAttemptAt: nowIso,
          learnedDate: scheduler.localToday(),
          reviewStage: 0,
          nextReviewDate: null, // 学完当天由 completeDailySession 启动复习调度
          stars: 0, // 该词已计入的星数（由 creditStars 填）
        },
      ]),
    });
  });
}

/** 星星上限：跟读评分的最高档 */
const MAX_STARS_PER_WORD = 3;

/**
 * 结算一个单词的星星：**每个单词只记一次，取最好成绩**。
 * 只有刷新了更好成绩才把差额计入账户余额，所以重复调用不会重复加。
 *
 * ⚠️ 调用前必须已经 markWordLearned（需要词条存在）。返回本次实际加到的星数（0 表示没加）。
 */
function creditStars(wordId, starCount) {
  const n = Math.max(0, Math.min(MAX_STARS_PER_WORD, Math.floor(starCount || 0)));
  if (n === 0) return 0; // 0 星（完全没听到声音）不加星
  let gained = 0;
  setProgress((prev) => {
    const idx = prev.words.findIndex((w) => w.wordId === wordId);
    if (idx < 0) return prev; // 词条不存在 → 不加（防止绕过账本重复计星）
    const w = prev.words[idx];
    const credited = w.stars || 0;
    if (n <= credited) return prev; // 已有更好的成绩 → 不加
    gained = n - credited;
    const words = prev.words.slice();
    words[idx] = Object.assign({}, w, { stars: n });
    return Object.assign({}, prev, { words: words, stars: (prev.stars || 0) + gained });
  });
  return gained;
}

/** 账户星星余额 */
function getStarBalance() {
  return current.stars || 0;
}

/* ---------------- 星星形象（Avatar） ---------------- */

/**
 * 当前形象：一个可直接渲染的图块 { id, gender, name, col, row, tx, ty }。
 * **永不返回空** —— 没设置过 / 存档脏数据 → 默认形象，页面照常显示。
 */
function getAvatar() {
  return avatar.tileOf(current.avatarId);
}

/** 孩子是否真的选过形象。脏数据一律算「没选过」，好再引导一次 */
function hasAvatar() {
  return !!avatar.findById(current.avatarId);
}

/**
 * 设置形象。**非法 id 一律不写入**（返回当前值），
 * 免得脏数据把已经选好的形象冲掉。
 * @returns {string} 归一后的形象 id
 */
function setAvatar(id) {
  const item = avatar.findById(id);
  if (!item) return getAvatar().id;
  setProgress(Object.assign({}, current, { avatarId: item.id }));
  return item.id;
}

/**
 * PK 挑战得星：答对 1 题 = 1 颗星，**每场 PK 只结算一次**。
 *
 * 去重口径与 creditStars 不同（见 DEFAULT_PROGRESS.pkRewarded 的注释）：
 * 这里按「挑战 id」去重，不碰 word 词条 —— 所以不会污染学习进度。
 * 重复进入同一场 PK（重玩、退回再进）都只发一次星。
 *
 * @param {string} pkId  挑战 id
 * @param {number} count 本场答对的题数（= 应得星数）
 * @returns {number} 本次实际加到的星数（0 = 没加：重复结算 / 0 题 / id 非法）
 */
function creditPkStars(pkId, count) {
  const id = typeof pkId === 'string' ? pkId : '';
  const n = Math.floor(count || 0);
  if (!id || n <= 0) return 0;
  let gained = 0;
  setProgress((prev) => {
    const done = Array.isArray(prev.pkRewarded) ? prev.pkRewarded : [];
    if (done.indexOf(id) !== -1) return prev; // 这场已经结算过 → 一分不给
    let next = done.concat([id]);
    if (next.length > MAX_PK_REWARDED) next = next.slice(next.length - MAX_PK_REWARDED);
    gained = n;
    return Object.assign({}, prev, { stars: (prev.stars || 0) + n, pkRewarded: next });
  });
  return gained;
}

function recordReviewResult(wordId, correct, date) {
  const today = date || scheduler.localToday();
  setProgress((prev) =>
    Object.assign({}, prev, {
      words: prev.words.map((w) => (w.wordId === wordId ? scheduler.applyReviewResult(w, correct, today) : w)),
    })
  );
}

/** 当日学习完成：锁定今天、推进 streak 与「学习日」计数、启动复习调度 */
function completeDailySession(maxWeek, date) {
  const today = date || scheduler.localToday();
  setProgress((prev) => {
    const words = prev.words.map((w) =>
      w.learned && w.nextReviewDate === null && w.reviewStage < scheduler.GRADUATED_STAGE
        ? Object.assign({}, w, { nextReviewDate: scheduler.addDays(today, scheduler.REVIEW_INTERVALS[0]) })
        : w
    );
    const lastDate = prev.lastLearnedDate;
    let newStreak = prev.streakDays;
    if (!lastDate) {
      newStreak = 1;
    } else {
      const diffDays = Math.floor(
        (new Date(today).getTime() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24)
      );
      if (diffDays === 1) newStreak = prev.streakDays + 1;
      else if (diffDays === 0) newStreak = prev.streakDays;
      else newStreak = 1;
    }
    return Object.assign({}, prev, {
      words,
      streakDays: newStreak,
      lastLearnedDate: today,
      currentWeek: Math.min(prev.currentWeek + 1, maxWeek),
    });
  });
}

function resetProgress() {
  cloudRowId = null;
  setProgress(JSON.parse(JSON.stringify(DEFAULT_PROGRESS)));
}

/* ---------------- 成就 ---------------- */
const ACHIEVEMENTS = [
  { id: 'first-word', name: '初次启航', icon: '✨', description: '完成第一个单词的学习', condition: (p) => p.words.filter((w) => w.score > 0).length >= 1 },
  { id: 'first-perfect', name: '完美发音', icon: '🏆', description: '获得一次 90 分以上的成绩', condition: (p) => p.words.some((w) => w.score >= 90) },
  { id: 'week-completed', name: '五词通关', icon: '🥇', description: '学完当天的 5 个单词', condition: (p) => p.words.filter((w) => w.score > 0).length >= 5 },
  { id: 'five-words', name: '词汇达人', icon: '📖', description: '累计学习 5 个单词', condition: (p) => p.words.filter((w) => w.score > 0).length >= 5 },
  { id: 'ten-words', name: '学霸之路', icon: '🎓', description: '累计学习 10 个单词', condition: (p) => p.words.filter((w) => w.score > 0).length >= 10 },
  { id: 'streak-3', name: '坚持不懈', icon: '🔥', description: '连续学习 3 天', condition: (p) => p.streakDays >= 3 },
];

function refreshAchievements() {
  const unlocked = ACHIEVEMENTS.filter((a) => a.condition(current)).map((a) => a.id);
  const before = current.achievements.slice();
  const added = unlocked.filter((id) => before.indexOf(id) === -1);
  if (added.length > 0) {
    setProgress(Object.assign({}, current, { achievements: unlocked.concat() }));
  }
  return added;
}

/* ---------------- 云同步 ---------------- */
function getSession() {
  if (!cloud) return Promise.resolve(null);
  return cloud.auth.getSession().then(({ data }) => data || null).catch(() => null);
}

function scheduleCloudSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(syncToCloud, 1500);
}

/** 登录后把本地进度推到云数据库（每用户一行）；未登录时静默跳过 */
function syncToCloud() {
  return getSession()
    .then((session) => {
      if (!session) return null;
      const payload = { data: current, updated_at: new Date().toISOString() };
      const findRow = cloudRowId
        ? Promise.resolve({ data: [{ id: cloudRowId }] })
        : cloud.database.from('learning_progress').select('id').limit(1);
      return findRow.then(({ data, error }) => {
        if (error) return null;
        const rows = Array.isArray(data) ? data : [];
        if (rows.length > 0) {
          cloudRowId = rows[0].id;
          return cloud.database
            .from('learning_progress')
            .update(payload)
            .eq('id', cloudRowId)
            .select('id')
            .then(({ data: updated }) => {
              if (Array.isArray(updated) && updated.length === 0) {
                // RLS 拦截或行不存在：重置行缓存，下次重新查询
                cloudRowId = null;
              }
            });
        }
        return cloud.database.from('learning_progress').insert(payload).select('id').then(({ data: created }) => {
          if (Array.isArray(created) && created.length > 0) cloudRowId = created[0].id;
        });
      });
    })
    .catch(() => null);
}

/** 登录后拉取云端进度：仅当云端比本地新时覆盖 */
function pullFromCloud() {
  return getSession()
    .then((session) => {
      if (!session) return null;
      return cloud.database
        .from('learning_progress')
        .select('id, data, updated_at')
        .order('updated_at', { ascending: false })
        .limit(1)
        .then(({ data, error }) => {
          if (error || !Array.isArray(data) || data.length === 0) return null;
          const row = data[0];
          cloudRowId = row.id;
          const remote = row.data;
          if (remote && remote.progressVersion && remote.words) {
            const remoteAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
            const localAt = current.words.length
              ? Math.max.apply(null, current.words.map((w) => (w.lastAttemptAt ? new Date(w.lastAttemptAt).getTime() : 0)))
              : 0;
            if (remoteAt > localAt) {
              current = normalizeProgress(Object.assign(JSON.parse(JSON.stringify(DEFAULT_PROGRESS)), remote));
              notify();
              return 'pulled';
            }
          }
          return null;
        });
    })
    .catch(() => null);
}

module.exports = {
  getProgress,
  setProgress,
  markWordLearned,
  creditStars,
  getStarBalance,
  creditPkStars,
  getAvatar,
  hasAvatar,
  setAvatar,
  recordReviewResult,
  completeDailySession,
  resetProgress,
  refreshAchievements,
  ACHIEVEMENTS,
  syncToCloud,
  pullFromCloud,
};
