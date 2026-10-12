// 学习进度存储：本地 wx.storage 为准，登录后自动同步到云数据库
const scheduler = require('./scheduler');
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
};

function loadProgress() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_PROGRESS));
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const merged = Object.assign({}, DEFAULT_PROGRESS, parsed);
    if (!Array.isArray(merged.words)) merged.words = [];
    return merged;
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
        },
      ]),
    });
  });
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
              current = Object.assign(JSON.parse(JSON.stringify(DEFAULT_PROGRESS)), remote);
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
  recordReviewResult,
  completeDailySession,
  resetProgress,
  refreshAchievements,
  ACHIEVEMENTS,
  syncToCloud,
  pullFromCloud,
};
