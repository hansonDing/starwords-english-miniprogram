// PK 挑战的云端读写（表：pk_challenges）
//
// 设计要点（详见 docs/superpowers/specs/2026-10-15-pk-challenge-design.md）：
//   · 一场 PK 只能被作答一次（先到先得）。这条**由数据库保证**，不是靠前端判断：
//     RLS 的 update 策略是 `USING (status = 'pending')`，
//     所以第一个人把 status 改成 'done' 之后，第二个人的 update 会匹配 0 行。
//     submitResult 用「返回行数为 0」来识别「被人抢先答了」。
//   · 未登录也要能读挑战、能答、能提交成绩 —— 所以 RLS 的 select/update 对 anon 也开放，
//     只是 played_by 会写 null（匿名作答）。出题者仍能看到「星星学员答对 4/5」。
//   · 所有失败都静默收敛成 false / null / []，绝不抛 —— 云端挂了不能拖垮本地流程
//     （孩子答完的星星必须落进本机账户，见 pages/pk-play 的结算顺序）。
//
// 云端表结构：
//   id text pk / challenger_id text / challenger_name text / challenger_avatar text
//   target_id / target_name / word_ids jsonb / status text('pending'|'done') / result jsonb
//   played_by / played_name / created_at / updated_at
//
//   challenger_avatar：出题者当时选的形象 id。答题页结算时用它显示「我 ↔ 对方」两个形象。
//   出题者没设过形象 / 老记录没这一列 → 前端 resolve 成默认形象，不写默认值进库。
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
      if (res.error) return false
      // 0 行 = 已被别人答过（或行不存在）
      return Array.isArray(res.data) && res.data.length > 0
    })
    .catch(function () {
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

module.exports = {
  create: create,
  fetch: fetch,
  submitResult: submitResult,
  listMine: listMine,
}
