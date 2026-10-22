// 学习进度存储：本地 wx.storage 为准，登录后自动同步到云数据库
const scheduler = require('./scheduler');
const avatar = require('./avatar');
const wordLib = require('./words');
const { cloud } = require('./cloud');

const STORAGE_KEY = 'starwords-progress';

const DEFAULT_PROGRESS = {
  progressVersion: 3,
  // ⚠️ 名叫 currentWeek，实际是「第几个学习日」（每天 +1），对外显示「第 N 天」。
  // 年级化后只是纯天数：「今天学哪个单元」改由 nextUnitInGrade() 从 words 推导。
  currentWeek: 1,
  // ⚠️ 不存「每个年级各自的进度」—— 那是第二份真相；年级内进度从 words 推导。
  currentGrade: 'g1',
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
  // 本地最后一次**主动改动**的时间戳（ms），云同步靠它判断「谁更新」。0 = 老存档（未知）。
  // ⚠️ 不能用词条上的 lastAttemptAt：那只在学新词时变，得星 / 换形象 / 换年级都不动它。
  updatedAt: 0,
};

/** PK 去重记录的保留条数上限（云同步 payload 不能无限膨胀） */
const MAX_PK_REWARDED = 100;

/**
 * 反推年级（老存档 / 脏数据缺 currentGrade 时用）。
 * ⚠️ 不能只看 currentWeek —— 它是「学习日」，多年级时代与单元号不再相等，
 * 所以优先用已学词的最大单元号。
 */
function inferGradeId(p) {
  let maxUnit = 0;
  for (const rec of p.words) {
    const meta = wordLib.getWordById(rec.wordId);
    if (meta && rec.learned && meta.week > maxUnit) maxUnit = meta.week;
  }
  if (maxUnit > 0) return wordLib.gradeOfWeek(maxUnit).id;
  // 一条学习记录都没有：此时学习日与单元号等价，反推安全；再不行回落第一个年级。
  const day = Math.max(1, Number(p.currentWeek) || 1);
  const g = wordLib.gradeOfWeek(day);
  return g ? g.id : wordLib.GRADES[0].id;
}

/**
 * 把存档 / 云端数据归一成可用形状。每个字段都要扛住脏数据（旧版本缺字段、云端被手改过）。
 * 只做「类型修复」，不动业务语义。
 */
function normalizeProgress(p) {
  if (!Array.isArray(p.words)) p.words = [];
  if (!Array.isArray(p.pkRewarded)) p.pkRewarded = [];
  // 形象 id：先按老 id 迁移（曾每性别 6 个现 4 个 —— girl-6 → girl-1，**同性别**兜底，
  // 别让女孩突然变男孩）；迁移不了才回落成「未选择」，由 hasAvatar() 判定。
  if (typeof p.avatarId === 'string' && p.avatarId && !avatar.findById(p.avatarId)) {
    p.avatarId = avatar.migrateId(p.avatarId) || '';
  }
  if (typeof p.avatarId !== 'string') p.avatarId = '';
  // 年级：缺失 / 非法 → 反推（必须在 words 归一之后）
  if (typeof p.currentGrade !== 'string' || !wordLib.gradeById(p.currentGrade)) {
    p.currentGrade = inferGradeId(p);
  }
  // 版本号只升不降 —— 否则云端那份（已是 3）会被本地老档的版本号拉回去
  if (!(Number(p.progressVersion) >= 3)) p.progressVersion = 3;
  // 时间戳只认数字；脏数据一律当「未知」（0），交给 pullFromCloud 的保守分支处理
  p.updatedAt = Number(p.updatedAt) > 0 ? Number(p.updatedAt) : 0;
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
// 家长主动「重置进度」时置 true：这一次允许把空档推上云端。
// 否则下面的「空档拒推」保险会把重置拦下来，下次启动又把旧进度拉回来 —— 重置等于没做。
let allowEmptyPush = false;

function getProgress() {
  return current;
}

function notify(opts) {
  // 只有**本地主动改动**才推进 updatedAt；从云端拉回来的不算（传 { remote: true }），
  // 否则拉完时间戳变成"现在"，之后永远判本地更新，云端再也不会被采纳。
  const remote = !!(opts && opts.remote);
  if (!remote) current.updatedAt = Date.now();
  // 各页面在 onShow 里重新读取；这里只负责持久化与云同步
  try {
    wx.setStorageSync(STORAGE_KEY, JSON.stringify(current));
  } catch (e) {
    /* 存储失败不影响学习 */
  }
  if (!remote) scheduleCloudSync();
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

/* ---------------- 年级 ---------------- */

/** 已学词 id 集合 —— 年级进度的**唯一事实来源**（所以不需要第二份进度表） */
function learnedIds() {
  const set = Object.create(null);
  for (const rec of current.words) {
    if (rec.learned || (typeof rec.score === 'number' && rec.score > 0)) set[rec.wordId] = true;
  }
  return set;
}

/** 当前激活的年级。存档脏成非法 id 时兜底第一个年级，**永不返回空** */
function currentGrade() {
  return wordLib.gradeById(current.currentGrade) || wordLib.GRADES[0];
}

/**
 * 该年级第一个「还有没学完的词」的单元号；全学完 / 未灌内容 → null。
 * ⚠️ 绝不跳过「学到一半」的单元。
 */
function nextUnitInGrade(gradeId) {
  const g = wordLib.gradeById(gradeId || current.currentGrade);
  if (!g) return null;
  const set = learnedIds();
  for (let u = g.firstUnit; u <= g.lastUnit; u++) {
    const list = wordLib.getWeekWords(u);
    if (list.length === 0) break; // 内容只灌到这里，后面的单元还不存在
    for (let i = 0; i < list.length; i++) {
      if (!set[list[i].id]) return u; // ← 有词没学就停在这一单元，绝不跳过
    }
  }
  return null;
}

/** 年级进度 `{ total, learned, percent, completed, available }` —— 从 words 推导 */
function gradeStats(gradeId) {
  const list = wordLib.getGradeWords(gradeId);
  const set = learnedIds();
  let learned = 0;
  for (const w of list) if (set[w.id]) learned++;
  const total = list.length;
  return {
    total: total,
    learned: learned,
    percent: total > 0 ? Math.round((learned / total) * 100) : 0,
    completed: total > 0 && learned === total,
    available: total > 0, // 该年级是否已经灌了内容（未灌 → 页面显示「未开放」）
  };
}

/** 切换年级。跳级的家长确认由页面负责，这里只校验 id 合法 */
function setGrade(gradeId) {
  const g = wordLib.gradeById(gradeId);
  if (!g) return currentGrade().id;
  setProgress(Object.assign({}, current, { currentGrade: g.id }));
  return g.id;
}

/** 当前年级末单元 —— 给 completeDailySession 当指针上限。⚠️ 别退回 MAX_WEEK（会跨年级跳） */
function currentGradeMaxUnit() {
  return Math.min(currentGrade().lastUnit, wordLib.MAX_WEEK);
}

/**
 * 学完当前年级后自动前移。已是最后一级 / 下一级没灌内容 → null。
 * ⚠️ 不要塞进 completeDailySession —— 那个函数只管学习日 / streak / 复习调度。
 */
function advanceGrade() {
  const grades = wordLib.GRADES;
  let idx = -1;
  for (let i = 0; i < grades.length; i++) {
    if (grades[i].id === current.currentGrade) idx = i;
  }
  if (idx < 0 || idx >= grades.length - 1) return null;
  const next = grades[idx + 1];
  if (wordLib.getGradeWords(next.id).length === 0) return null;
  setProgress(Object.assign({}, current, { currentGrade: next.id }));
  return next.id;
}

/** 年级卡片列表（年级选择页用） */
function gradeList() {
  const activeId = currentGrade().id;
  return wordLib.GRADES.map((g) => {
    const s = gradeStats(g.id);
    return {
      id: g.id,
      name: g.name,
      firstUnit: g.firstUnit,
      lastUnit: g.lastUnit,
      total: s.total,
      learned: s.learned,
      percent: s.percent,
      completed: s.completed,
      available: s.available,
      active: g.id === activeId,
    };
  });
}

/** 全局汇总（首页头部 / 进度页用） */
function totalStats() {
  const set = learnedIds();
  let learned = 0;
  for (const w of wordLib.WORDS) if (set[w.id]) learned++;
  const total = wordLib.WORDS.length;
  const g = currentGrade();
  return {
    total: total,
    learned: learned,
    percent: total > 0 ? Math.round((learned / total) * 100) : 0,
    days: current.currentWeek,
    streak: current.streakDays,
    gradeId: g.id,
    gradeName: g.name,
  };
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

/**
 * 当日学习完成：锁定今天、推进 streak 与「学习日」计数、启动复习调度。
 *
 * @param {number} maxUnit 「学习日指针」的上限。⚠️ 必须传**当前年级的末单元**
 *   （`store.currentGradeMaxUnit()`）—— 传 MAX_WEEK 会让孩子学完一年级最后一天后，
 *   指针直接落进还没解锁的二年级区域。
 */
function completeDailySession(maxUnit, date) {
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
      currentWeek: Math.min(prev.currentWeek + 1, maxUnit),
    });
  });
}

function resetProgress() {
  cloudRowId = null;
  allowEmptyPush = true; // 这一次要允许空档覆盖云端，见 allowEmptyPush 的注释
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
        : cloud.database.from('learning_progress').select('id, data').limit(1);
      return findRow.then(({ data, error }) => {
        if (error) return null;
        const rows = Array.isArray(data) ? data : [];
        if (rows.length > 0) {
          cloudRowId = rows[0].id;
          // ⚠️ 最后一道保险：本地空档（新设备 / 清了缓存）而云端有记录时**拒绝推送** —— 推上去不可逆。
          const remoteWords = rows[0].data && rows[0].data.words;
          if (!allowEmptyPush && !current.words.length && Array.isArray(remoteWords) && remoteWords.length > 0) return null;
          return cloud.database
            .from('learning_progress')
            .update(payload)
            .eq('id', cloudRowId)
            .select('id')
            .then(({ data: updated }) => {
              if (Array.isArray(updated) && updated.length === 0) {
                // RLS 拦截或行不存在：重置行缓存，下次重新查询
                cloudRowId = null;
              } else {
                allowEmptyPush = false; // 这次专供重置的放行已经用掉了
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

/**
 * 拉取云端进度：只比两边 updatedAt 的大小。任一方缺这个字段（老存档 / 老云档）就当「未知」
 * **不动本地** —— 少拉一次只是这次没同步上，覆盖错一次是永久丢数据。
 * 唯一例外：本地一个词都没学过（新设备 / 清了缓存）→ 云端一定更全，直接拉。
 */
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
          if (!remote || !remote.progressVersion || !Array.isArray(remote.words)) return null;
          const remoteAt = Number(remote.updatedAt) > 0 ? Number(remote.updatedAt) : 0;
          const localAt = Number(current.updatedAt) > 0 ? Number(current.updatedAt) : 0;
          const localEmpty = !current.words.length;
          const takeRemote = localEmpty || (remoteAt > 0 && localAt > 0 && remoteAt > localAt);
          if (!takeRemote) return null;
          current = normalizeProgress(Object.assign(JSON.parse(JSON.stringify(DEFAULT_PROGRESS)), remote));
          current.updatedAt = remoteAt || current.updatedAt;
          notify({ remote: true });
          return 'pulled';
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
  // 年级
  currentGrade,
  nextUnitInGrade,
  gradeStats,
  setGrade,
  currentGradeMaxUnit,
  advanceGrade,
  gradeList,
  totalStats,
  recordReviewResult,
  completeDailySession,
  resetProgress,
  refreshAchievements,
  ACHIEVEMENTS,
  syncToCloud,
  pullFromCloud,
};
