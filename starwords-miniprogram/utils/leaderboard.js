// 学习排行榜：昵称 + 学习量的云端写入与读取
// 关键点（踩过坑）：
//   leaderboard.owner_id 上有唯一索引，所以「先 insert，失败就算了」是错的 ——
//   第一次写入成功后，后续每次 insert 都会撞唯一约束，昵称/学习量永远更新不上去。
//   必须走 upsert（onConflict: owner_id），失败再退回「按 owner_id 查 → 更新或插入」。
const { cloud } = require('./cloud')
const store = require('./store')

const NICKNAME_KEY = 'starwords-nickname'
const DEFAULT_NICKNAME = '星星学员'
const MAX_NAME_LEN = 12

function normalizeName(raw) {
  const v = String(raw == null ? '' : raw).trim().slice(0, MAX_NAME_LEN)
  return v || DEFAULT_NICKNAME
}

function getNickname() {
  let saved = ''
  try {
    saved = wx.getStorageSync(NICKNAME_KEY) || ''
  } catch (e) {
    saved = ''
  }
  return normalizeName(saved)
}

function setNickname(raw) {
  const name = normalizeName(raw)
  try {
    wx.setStorageSync(NICKNAME_KEY, name)
  } catch (e) {
    /* ignore */
  }
  return name
}

// 当前用户在排行榜上的那一行
function buildRow(uid) {
  const p = store.getProgress()
  const words = p.words || []
  const learned = words.filter((w) => w.learned).length
  return {
    owner_id: uid,
    owner_name: getNickname(),
    learned_count: learned,
    streak_days: p.streakDays || 0,
    current_week: p.currentWeek || 1,
    // 年级 id（可空列，老数据不受影响）。榜单仍按已学词数排序。
    grade_id: store.currentGrade().id,
    // 真实星星余额。以前写的是 learned（已学词数），语义错位 —— 榜单目前不展示，
    // 但一旦展示就是「学了 5 个词显示 5 颗星」，跟「我的」页的余额对不上。
    stars: store.getStarBalance(),
    updated_at: new Date().toISOString(),
  }
}

function ok(res) {
  return !!(res && !res.error)
}

// upsert 失败时的兜底：按 owner_id 取出自己那行，有则更新、无则插入
function fallbackWrite(row) {
  return cloud.database
    .from('leaderboard')
    .select('id')
    .eq('owner_id', row.owner_id)
    .limit(1)
    .then(({ data, error }) => {
      const rows = !error && Array.isArray(data) ? data : []
      if (rows.length > 0) {
        return cloud.database
          .from('leaderboard')
          .update(row)
          .eq('id', rows[0].id)
          .select('id')
          .then((res) => ok(res));
      }
      return cloud.database
        .from('leaderboard')
        .insert(row)
        .select('id')
        .then((res) => ok(res));
    });
}

// 把当前昵称 + 学习量写进排行榜。未登录 / 云端不可用时静默跳过。
// 返回 Promise<boolean>（是否写入成功），调用方不需要 await。
function push() {
  if (!cloud) return Promise.resolve(false);
  return cloud.auth
    .getSession()
    .then(({ data: session, error }) => {
      if (error || !session || !session.user) return false;
      const row = buildRow(session.user.id);
      return cloud.database
        .from('leaderboard')
        .upsert(row, { onConflict: 'owner_id' })
        .select('id')
        .then((res) => {
          if (ok(res)) return true;
          return fallbackWrite(row);
        })
        .catch(() => fallbackWrite(row));
    })
    .catch(() => false);
}

module.exports = {
  push: push,
  getNickname: getNickname,
  setNickname: setNickname,
  DEFAULT_NICKNAME: DEFAULT_NICKNAME,
  NICKNAME_KEY: NICKNAME_KEY,
};
