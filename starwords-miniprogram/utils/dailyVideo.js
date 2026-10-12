// 每日动画：一周 7 天各一段动画片，家长上传、孩子每天解锁一段。
//
// 存储设计（关键，别改）：
//   视频对象放在「上传者自己的共享目录」：shared/<上传者uid>/daily-videos/day-<n>-<时间戳>.mp4
//   云存储的约定是 shared/<uid>/... 所有已登录用户可读、只有本人可写 ——
//   所以家长账号上传一次，孩子账号也能播。
//   （注意：shared/_application/... 只有应用管理员能写，普通用户上传会被拒，不能用。）
//
//   清单表 daily_animations 一行一天（day_index 唯一）：公开可读、仅上传者本人可写。
//   客户端不写死存储路径，路径存在表里，谁上传的就归谁。
//
// 播放地址：云存储没有 public URL，只能现签（最长 3600 秒），签出来的地址落在
//   小程序固定网关域名上，发布链路会自动把它加进微信后台的合法域名，真机可直接播。
const { cloud } = require('./cloud');

const TABLE = 'daily_animations';
const DIR = 'daily-videos';
const SIGNED_TTL = 3600; // 云存储签名链接上限就是 3600 秒
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB，超了提示先压缩

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 一周节目单（沿用网页版：每天一首经典英文儿歌），dayIndex 与 Date.getDay() 对齐（0 = 周日）
const SHOWS = [
  { dayIndex: 0, title: '划呀划小船', enTitle: 'Row Row Row Your Boat', category: '自然', desc: '坐上小船 gently down the stream，感受水波荡漾的快乐' },
  { dayIndex: 1, title: '早安大公鸡', enTitle: 'Good Morning, Mr. Rooster', category: '日常', desc: '跟着大公鸡学习早上好怎么说，开启美好的一天' },
  { dayIndex: 2, title: '头肩膝脚趾', enTitle: 'Head Shoulders Knees & Toes', category: '身体', desc: '边唱边指，认识身体的各个部位' },
  { dayIndex: 3, title: '老麦克唐纳', enTitle: 'Old MacDonald Had A Farm', category: '动物', desc: '参观农场，认识牛、猪、鸭等动物的叫声' },
  { dayIndex: 4, title: '如果你感到幸福', enTitle: "If You're Happy And You Know It", category: '情绪', desc: '拍拍手、跺跺脚，用动作表达快乐的心情' },
  { dayIndex: 5, title: '公交车的轮子', enTitle: 'The Wheels On The Bus', category: '交通', desc: '轮子在转呀转，雨刮器在刷呀刷，认识公交车部件' },
  { dayIndex: 6, title: '雨呀快走吧', enTitle: 'Rain Rain Go Away', category: '天气', desc: '小雨小雨快走开，好让我出去玩，学习天气相关词汇' },
];

function todayIndex() {
  return new Date().getDay();
}

function getShow(dayIndex) {
  for (let i = 0; i < SHOWS.length; i++) {
    if (SHOWS[i].dayIndex === dayIndex) return SHOWS[i];
  }
  return SHOWS[0];
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (Math.round((n / 1024 / 1024) * 10) / 10) + ' MB';
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (v) => (v < 10 ? '0' + v : '' + v);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/* ---------- 登录态 ---------- */

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

/* ---------- 清单读取 ---------- */

// 返回 { dayIndex: row }；云不可用或未登录时返回 {}
function fetchManifest() {
  if (!cloud) return Promise.resolve({});
  return cloud.database
    .from(TABLE)
    .select('day_index, title, en_title, category, object_path, size_bytes, updated_at, owner_id')
    .limit(20)
    .then(({ data, error }) => {
      const map = {};
      if (error || !Array.isArray(data)) return map;
      data.forEach((row) => {
        map[row.day_index] = row;
      });
      return map;
    })
    .catch(() => ({}));
}

// 单天清单行（上传前先查归属，避免传完才发现这天归别人、留下孤儿文件）
function fetchDay(dayIndex) {
  if (!cloud) return Promise.resolve(null);
  return cloud.database
    .from(TABLE)
    .select('id, owner_id, object_path')
    .eq('day_index', dayIndex)
    .limit(1)
    .then(({ data, error }) => (!error && Array.isArray(data) && data.length > 0 ? data[0] : null))
    .catch(() => null);
}

// 组装 7 天视图：当天及之前可看（可回看），之后锁定
function buildWeek(manifest) {
  const today = todayIndex();
  return SHOWS.map((s) => {
    const row = manifest[s.dayIndex];
    const uploaded = !!(row && row.object_path);
    return {
      dayIndex: s.dayIndex,
      dayName: WEEKDAY[s.dayIndex],
      title: s.title,
      enTitle: s.enTitle,
      category: s.category,
      desc: s.desc,
      isToday: s.dayIndex === today,
      unlocked: s.dayIndex <= today,
      uploaded: uploaded,
      objectPath: uploaded ? row.object_path : '',
      ownerId: uploaded ? row.owner_id : '',
      sizeText: uploaded ? formatSize(row.size_bytes) : '',
      updatedText: uploaded ? formatDate(row.updated_at) : '',
    };
  });
}

/* ---------- 签名播放地址 ---------- */

function signUrl(objectPath) {
  if (!cloud || !objectPath) return Promise.resolve('');
  return cloud.storage
    .createSignedUrl(objectPath, SIGNED_TTL)
    .then((res) => {
      if (!res || res.error) return '';
      const d = res.data || {};
      return d.signedUrl || d.signedURL || d.url || '';
    })
    .catch(() => '');
}

/* ---------- 上传 ---------- */

function readAsArrayBuffer(filePath) {
  return new Promise((resolve, reject) => {
    let fs;
    try {
      fs = wx.getFileSystemManager();
    } catch (e) {
      reject(new Error('当前环境不支持读取文件'));
      return;
    }
    fs.readFile({
      filePath: filePath,
      success: (res) => resolve(res.data),
      fail: () => reject(new Error('读取视频文件失败，请重新选择')),
    });
  });
}

function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  const ext = m ? m[1].toLowerCase() : 'mp4';
  if (ext === 'mp4' || ext === 'mov' || ext === 'm4v') return ext;
  return 'mp4';
}

// upsert 失败时的兜底：按 day_index 查，是自己那行就更新，没有就插入
function saveRow(row) {
  const fail = (msg) => ({ saved: false, error: msg });
  return cloud.database
    .from(TABLE)
    .upsert(row, { onConflict: 'day_index' })
    .select('id')
    .then((res) => {
      if (res && !res.error) return { saved: true, error: '' };
      return fallbackSave(row, fail);
    })
    .catch(() => fallbackSave(row, fail));
}

function fallbackSave(row, fail) {
  return cloud.database
    .from(TABLE)
    .select('id, owner_id')
    .eq('day_index', row.day_index)
    .limit(1)
    .then(({ data, error }) => {
      const rows = !error && Array.isArray(data) ? data : [];
      if (rows.length === 0) {
        return cloud.database
          .from(TABLE)
          .insert(row)
          .select('id')
          .then((res) => (res && !res.error ? { saved: true, error: '' } : fail('保存清单失败，请重试')));
      }
      if (rows[0].owner_id && rows[0].owner_id !== row.owner_id) {
        return fail('这一天的动画已经由其他账号上传，请让上传者来替换');
      }
      return cloud.database
        .from(TABLE)
        .update(row)
        .eq('id', rows[0].id)
        .select('id')
        .then((res) => (res && !res.error ? { saved: true, error: '' } : fail('保存清单失败，请重试')));
    })
    .catch(() => fail('网络异常，保存失败'));
}

// filePath 来自 wx.chooseMessageFile；size 为字节数（可选，仅用于前置校验）
function uploadDay(dayIndex, filePath, size) {
  if (!cloud) return Promise.resolve({ saved: false, error: '云服务不可用' });
  if (size && size > MAX_UPLOAD_BYTES) {
    return Promise.resolve({ saved: false, error: '视频超过 50MB，请先压缩再上传' });
  }
  return getSession().then((session) => {
    if (!session) return { saved: false, error: '请先在「我的」页登录' };
    const uid = session.user.id;
    // 先查归属：这一天已被别人上传过就直接拒绝，不要先传文件再报错
    return fetchDay(dayIndex).then((existing) => {
      if (existing && existing.owner_id && existing.owner_id !== uid) {
        return { saved: false, error: '这一天的动画已经由其他账号上传，请让上传者来替换' };
      }
      const name = 'day-' + dayIndex + '-' + Date.now() + '.' + extOf(filePath);
      const objectPath = cloud.storage.sharedPath(uid, DIR + '/' + name);
      return readAsArrayBuffer(filePath)
        .then((buffer) =>
          cloud.storage
            .upload(objectPath, buffer, { contentType: 'video/mp4', cacheControl: '3600', upsert: true })
            .then((res) => {
              if (!res || res.error) {
                return { saved: false, error: (res && res.error && res.error.message) || '上传失败，请重试' };
              }
              const show = getShow(dayIndex);
              return saveRow({
                owner_id: uid,
                day_index: dayIndex,
                title: show.title,
                en_title: show.enTitle,
                category: show.category,
                object_path: objectPath,
                size_bytes: size || 0,
                updated_at: new Date().toISOString(),
              }).then((out) => {
                if (out.saved) return { saved: true, error: '', objectPath: objectPath };
                // 清单没写成功 → 把刚传上去的文件删掉，别留孤儿占空间
                return cloud.storage
                  .remove([objectPath])
                  .catch(() => null)
                  .then(() => out);
              });
            })
        )
        .catch((err) => ({ saved: false, error: (err && err.message) || '上传失败，请重试' }));
    });
  });
}

function removeDay(row) {
  if (!cloud) return Promise.resolve({ saved: false, error: '云服务不可用' });
  return getSession().then((session) => {
    if (!session) return { saved: false, error: '请先登录' };
    if (row.ownerId && row.ownerId !== session.user.id) {
      return { saved: false, error: '只能删除自己上传的动画' };
    }
    const dropRow = () =>
      cloud.database
        .from(TABLE)
        .delete()
        .eq('day_index', row.dayIndex)
        .then((res) => (res && !res.error ? { saved: true, error: '' } : { saved: false, error: '删除清单失败' }))
        .catch(() => ({ saved: false, error: '网络异常，删除失败' }));
    if (!row.objectPath) return dropRow();
    return cloud.storage
      .remove([row.objectPath])
      .catch(() => null)
      .then(dropRow);
  });
}

module.exports = {
  SHOWS: SHOWS,
  WEEKDAY: WEEKDAY,
  todayIndex: todayIndex,
  getShow: getShow,
  getSession: getSession,
  fetchManifest: fetchManifest,
  buildWeek: buildWeek,
  signUrl: signUrl,
  uploadDay: uploadDay,
  removeDay: removeDay,
  formatSize: formatSize,
  MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES,
};
