// 管理员（家长）身份：一次性绑定 + 只读校验。
//
// 为什么不用微信号：小程序的微信接口拿不到微信号、手机号这类可搜索标识，
// 能拿到的唯一稳定标识只有云会话里的 user.id（uid）。所以「管理员」= 被绑定过的那个 uid。
//
// 绑定机制（关键，别改）：
//   云表 app_config 里只存一条 admin_uid 记录，config_key 是主键。
//   服务端 RLS 只授了 SELECT + INSERT，没有 UPDATE / DELETE 策略 ——
//   于是第一个写进去的人永久占位：别人再 insert 会主键冲突，谁也没法改或删。
//   写入前还要校验家长口令（PASSCODE），防止孩子账号抢先绑定。
const { cloud } = require('./cloud');

const TABLE = 'app_config';
const CONFIG_KEY = 'admin_uid';
const CACHE_KEY = 'sw_admin_uid';

// 家长口令：绑定管理员时输入。要换口令只改这一行。
const PASSCODE = 'ford660';

/* ---------- 本地缓存（断网 / 云不可用时兜底） ---------- */

function readCache() {
  try {
    return wx.getStorageSync(CACHE_KEY) || '';
  } catch (e) {
    return '';
  }
}

function writeCache(uid) {
  try {
    wx.setStorageSync(CACHE_KEY, uid || '');
  } catch (e) {
    /* 存不进去也不影响本次判断 */
  }
}

/* ---------- 会话 ---------- */

function getSession() {
  if (!cloud) return Promise.resolve(null);
  return cloud.auth
    .getSession()
    .then(({ data: session, error }) => {
      if (error || !session || !session.user) return null;
      return session;
    })
    .catch(() => null);
}

/* ---------- 管理员 uid 读取 ---------- */

// 兼容后端把 jsonb 返回成对象或字符串两种形态
function pickUid(row) {
  if (!row) return '';
  let value = row.value;
  if (value && typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (e) {
      value = null;
    }
  }
  if (value && typeof value === 'object' && value.uid) return String(value.uid);
  return row.owner_id ? String(row.owner_id) : '';
}

// 云表可公开读取，所以任何账号都能知道「管理员是谁」，但只有管理员本人能通过校验。
function fetchAdminUid() {
  const cached = readCache();
  if (!cloud) return Promise.resolve(cached);
  return cloud.database
    .from(TABLE)
    .select('value, owner_id')
    .eq('config_key', CONFIG_KEY)
    .limit(1)
    .then(({ data, error }) => {
      if (error || !Array.isArray(data)) return cached; // 查不动 → 用本地缓存
      if (data.length === 0) return ''; // 云端确认没人绑定
      const uid = pickUid(data[0]);
      if (uid) writeCache(uid);
      return uid;
    })
    .catch(() => cached);
}

/* ---------- 对外：判断 / 绑定 ---------- */

// 返回 { loggedIn, bound, isAdmin, uid, adminUid }
//   bound=false  → 还没人绑定，当前账号可以绑定
//   isAdmin=true → 当前账号就是管理员
function check() {
  const guest = { loggedIn: false, bound: false, isAdmin: false, uid: '', adminUid: '' };
  if (!cloud) return Promise.resolve(guest);
  return getSession().then((session) => {
    if (!session) return guest;
    const uid = session.user.id;
    return fetchAdminUid().then((adminUid) => ({
      loggedIn: true,
      bound: !!adminUid,
      isAdmin: !!adminUid && adminUid === uid,
      uid: uid,
      adminUid: adminUid,
    }));
  });
}

// 口令校验通过 → 把当前 uid 绑成管理员（只能成功一次）
function claim(passcode) {
  if (!cloud) return Promise.resolve({ ok: false, error: '云服务暂不可用' });
  const input = String(passcode || '').trim();
  if (!input) return Promise.resolve({ ok: false, error: '请输入家长口令' });
  if (input !== PASSCODE) return Promise.resolve({ ok: false, error: '口令不对，请检查后重试' });

  return getSession().then((session) => {
    if (!session) return { ok: false, error: '请先在「我的」页用微信登录' };
    const uid = session.user.id;
    return fetchAdminUid().then((existing) => {
      if (existing && existing !== uid) {
        return { ok: false, error: '管理员已绑定过其他账号了' };
      }
      if (existing === uid) {
        writeCache(uid);
        return { ok: true, uid: uid };
      }
      return cloud.database
        .from(TABLE)
        .insert({
          config_key: CONFIG_KEY,
          value: { uid: uid },
          owner_id: uid,
          updated_at: new Date().toISOString(),
        })
        .select('config_key')
        .then((res) => {
          if (res && !res.error) {
            writeCache(uid);
            return { ok: true, uid: uid };
          }
          return { ok: false, error: '绑定失败：管理员可能已被其他账号绑定' };
        })
        .catch(() => ({ ok: false, error: '网络异常，绑定失败，请重试' }));
    });
  });
}

module.exports = {
  check: check,
  claim: claim,
  getSession: getSession,
  fetchAdminUid: fetchAdminUid,
  PASSCODE: PASSCODE,
};
