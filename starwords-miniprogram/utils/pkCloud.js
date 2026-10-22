// PK 挑战的云端读写（表：pk_challenges，设计见 docs/superpowers/specs/2026-10-15-pk-challenge-design.md）
//   · 一场 PK 只能被答一次（先到先得）由数据库保证：RLS 的 update 策略是 USING (status='pending')，
//     第一个人改成 done 之后第二个人的 update 匹配 0 行 —— submitResult 靠「返回 0 行」识别被抢先。
//   · 未登录也要能读、能答、能交（RLS 对 anon 开放），只是 played_by 写 null。
//   · 所有失败静默收敛成 false / null / []，绝不抛：云端挂了不能拖垮本地结算
//     （孩子答完的星星必须落进本机账户，见 pages/pk-play 的结算顺序）。
//   · challenger_avatar 是出题者当时选的形象 id；老记录没这列时前端兜底成默认形象，不写默认值进库。
const { cloud } = require('./cloud')

// 出题者列表的默认展示名（写入失败的兜底）
const DEFAULT_NAME = '星星学员'

function hasCloud() {
  return !!cloud
}

/**
 * 新建一场挑战。
 * @param {{ id, challengerId, challengerName, challengerAvatar, targetId, targetName, wordIds }} payload
 * @returns {Promise<boolean>} 是否写入成功
 */
function create(payload) {
  if (!hasCloud() || !payload || !payload.id || !payload.challengerId) return Promise.resolve(false)
  var row = {
    id: payload.id,
    challenger_id: payload.challengerId,
    challenger_name: payload.challengerName || DEFAULT_NAME,
    challenger_avatar: payload.challengerAvatar || null,
    target_id: payload.targetId || null,
    target_name: payload.targetName || null,
    word_ids: Array.isArray(payload.wordIds) ? payload.wordIds : [],
    status: 'pending',
    updated_at: new Date().toISOString(),
  }
  return cloud.database
    .from('pk_challenges')
    .insert(row)
    .select('id')
    .then(function (res) {
      return !res.error && Array.isArray(res.data) && res.data.length > 0
    })
    .catch(function () {
      return false
    })
}

/**
 * 按 id 取一场挑战（答题页入口）。取不到 / 云端不可用 → null。
 * @returns {Promise<object|null>}
 */
function fetch(id) {
  if (!hasCloud() || !id) return Promise.resolve(null)
  return cloud.database
    .from('pk_challenges')
    .select('*')
    .eq('id', id)
    .limit(1)
    .then(function (res) {
      if (res.error || !Array.isArray(res.data) || res.data.length === 0) return null
      return res.data[0]
    })
    .catch(function () {
      return null
    })
}

/**
 * 回传成绩。
 *
 * ⚠️ 返回 false 有两种含义，页面无需区分（都走同一句「这场已经结束啦」）：
 *    a) 网络 / 云端失败；
 *    b) 被**别人抢先**答过了 —— 此时 update 命中 0 行（RLS 的 USING 不匹配），
 *       也就是说服务端的「先到先得」生效了，本机已得的星星仍然保留。
 *
 * @param {string} id
 * @param {{ result, playedBy, playedName }} payload
 * @returns {Promise<boolean>}
 */
function submitResult(id, payload) {
  if (!hasCloud() || !id) return Promise.resolve(false)
  var p = payload || {}
  var patch = {
    status: 'done',
    result: p.result || null,
    played_by: p.playedBy || null, // 未登录作答 → null（匿名）
    played_name: p.playedName || DEFAULT_NAME,
    updated_at: new Date().toISOString(),
  }
  return cloud.database
    .from('pk_challenges')
    .update(patch)
    .eq('id', id)
    .select('id')
    .then(function (res) {
      if (res.error) {
        queuePending(id, patch)
        return false
      }
      dropPending(id) // 之前可能排队过，这次通了就清掉
      // 0 行 = 已被别人答过（或行不存在）
      return Array.isArray(res.data) && res.data.length > 0
    })
    .catch(function () {
      queuePending(id, patch)
      return false
    })
}

/**
 * 我发起的挑战（「我的」页结果列表）。最多 10 条，按时间倒序。
 * @param {string} uid 当前用户 id（未登录传空 → 返回 []）
 * @returns {Promise<Array>}
 */
function listMine(uid) {
  if (!hasCloud() || !uid) return Promise.resolve([])
  return cloud.database
    .from('pk_challenges')
    .select('id, target_id, target_name, word_ids, status, result, played_name, created_at')
    .eq('challenger_id', uid)
    .order('created_at', { ascending: false })
    .limit(10)
    .then(function (res) {
      if (res.error || !Array.isArray(res.data)) return []
      return res.data
    })
    .catch(function () {
      return []
    })
}

/**
 * 删除一场我自己发起的挑战（「我的」页手工删除）。
 *
 * 只删得掉自己发起的行：RLS 的 delete 策略是 `challenger_id = auth.uid()`，
 * 删别人的行会命中 0 行。返回 false 的两种含义（页面都提示「删除失败」即可）：
 *   a) 云端 / 网络失败；b) 行已不存在 / 不属于自己。
 * @param {string} id
 * @returns {Promise<boolean>}
 */
function remove(id) {
  if (!hasCloud() || !id) return Promise.resolve(false)
  return cloud.database
    .from('pk_challenges')
    .delete()
    .eq('id', id)
    .select('id')
    .then(function (res) {
      if (res.error) return false
      // 个别 SDK 版本的 delete 不回传行；拿不到 data 时以「无报错」为准
      if (!Array.isArray(res.data)) return true
      return res.data.length > 0
    })
    .catch(function () {
      return false
    })
}

/**
 * 查询我收到的未读挑战（用于站内通知）。
 * @param {string} uid 当前用户 id（未登录传空 → 返回 []）
 * @returns {Promise<Array>} 未读挑战行，按时间倒序
 */
function listIncoming(uid) {
  if (!hasCloud() || !uid) return Promise.resolve([])
  return cloud.database
    .from('pk_challenges')
    .select('id, challenger_id, challenger_name, word_ids, created_at')
    .eq('target_id', uid)
    .eq('status', 'pending')
    .eq('target_read', false)
    .order('created_at', { ascending: false })
    .limit(10)
    .then(function (res) {
      if (res.error || !Array.isArray(res.data)) return []
      return res.data
    })
    .catch(function () {
      return []
    })
}

/**
 * 被挑战者点开挑战后标记为已读。
 * @param {string} id
 * @returns {Promise<boolean>}
 */
function markRead(id) {
  if (!hasCloud() || !id) return Promise.resolve(false)
  return cloud.database
    .from('pk_challenges')
    .update({ target_read: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
    .then(function (res) {
      if (res.error) return false
      return Array.isArray(res.data) && res.data.length > 0
    })
    .catch(function () {
      return false
    })
}

/**
 * 没回传成功的成绩先存本机，下次启动补传。
 * 只有「网络 / 云端报错」才进队列 —— 「被别人抢先」（update 命中 0 行）是正常结果，重试也没用。
 */
var PENDING_KEY = '__pk_pending'
var MAX_PENDING = 5

function readPending() {
  try {
    var list = wx.getStorageSync(PENDING_KEY)
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function writePending(list) {
  try {
    wx.setStorageSync(PENDING_KEY, list.slice(-MAX_PENDING))
  } catch (e) {
    /* 存不下就算了，不能影响结算 */
  }
}

function queuePending(id, patch) {
  var list = readPending().filter(function (x) {
    return x && x.id !== id
  })
  list.push({ id: id, patch: patch })
  writePending(list)
}

function dropPending(id) {
  writePending(
    readPending().filter(function (x) {
      return x && x.id !== id
    })
  )
}

/** 启动时补传上次没送出去的成绩（没有待传的就直接返回） */
function retryPending() {
  var list = readPending()
  if (!hasCloud() || list.length === 0) return Promise.resolve(false)
  return list.reduce(function (chain, item) {
    return chain.then(function () {
      return cloud.database
        .from('pk_challenges')
        .update(item.patch)
        .eq('id', item.id)
        .select('id')
        .then(function (res) {
          // 成功、或者这场已经被别人答完（0 行）→ 都算「不用再传了」
          if (!res.error) dropPending(item.id)
        })
        .catch(function () {
          /* 还是不通，留着下次再试 */
        })
    })
  }, Promise.resolve(true))
}

module.exports = {
  create: create,
  fetch: fetch,
  submitResult: submitResult,
  listMine: listMine,
  listIncoming: listIncoming,
  markRead: markRead,
  remove: remove,
  retryPending: retryPending,
}
