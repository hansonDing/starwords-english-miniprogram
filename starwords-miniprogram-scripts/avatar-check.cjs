/**
 * 星星形象（Avatar）自检：纯逻辑 utils/avatar.js + 真实 utils/store.js 的落盘行为。
 *
 * 为什么需要：形象这条链上有四处**静默**故障 ——
 *   ① **坐标算错**：精灵图取图靠一个百分比位移，公式错一点点，真机上就是
 *      「形象整个错位 / 变成别的形象的一部分」，而界面不报任何错。
 *   ② **兜底缺失**：云端同步下来的脏数据（null / 不存在的 id / 数字）会让
 *      `getAvatar()` 返回空对象 → 页面里 `av.tx` 是 undefined → 形象不显示，
 *      同样是零报错。
 *   ③ **旧存档没字段**：老用户升级后 progress 里没有 avatarId，
 *      要是直接读 `.id` 会取到 undefined，判断全错。
 *   ④ **老 id 迁移**：形象曾经每性别 6 个，现在 4 个。存着 girl-6 的孩子如果被
 *      直接兜底成默认（男孩）形象，就是「我女儿突然变成男孩」——静默且刺眼。
 *
 * 做法：纯逻辑部分直接 require 真模块；store 部分用 vm 沙箱 + 内存 storage
 * 真跑 store.js（cloud 桩掉，纯本地），共用同一个 storage 再建一次 = 模拟重启。
 *
 * 用法： node avatar-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', 'starwords-miniprogram');

// ⚠️ 工作区根有 "type":"module"，小程序目录里的 .js 必须按 CommonJS 显式加载
function loadCjs(file) {
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8'), file);
  return m.exports;
}

let failed = 0;
function check(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}

const AVATAR_PATH = path.join(ROOT, 'utils', 'avatar.js');
if (!fs.existsSync(AVATAR_PATH)) {
  console.error('  ✗ 缺少 utils/avatar.js —— 形象模块还没实现');
  process.exit(1);
}
const avatar = loadCjs(AVATAR_PATH);

const STORE_PATH = path.join(ROOT, 'utils', 'store.js');
const STORE_SRC = fs.readFileSync(STORE_PATH, 'utf8');
const realScheduler = loadCjs(path.join(ROOT, 'utils', 'scheduler.js'));

/** 用同一份内存 storage 造一个真实 store；传同一个 storage 两次 = 模拟重启 */
function makeStore(storage) {
  const mod = { exports: {} };
  const sandbox = {
    console: console,
    wx: {
      getStorageSync: function (k) {
        return storage[k];
      },
      setStorageSync: function (k, v) {
        storage[k] = v;
      },
    },
    module: mod,
    exports: mod.exports,
    require: function (id) {
      if (id === './scheduler') return realScheduler;
      if (id === './avatar') return avatar;
      if (id === './cloud') return { cloud: null, cloudError: '', available: false };
      // 年级功能之后 store 也依赖词库（gradeOfWeek / getWeekWords）—— 纯数据，直接加载真实文件
      if (id === './words') return loadCjs(path.join(ROOT, 'utils', 'words.js'));
      throw new Error('avatar-check: store 未预期的 require → ' + id);
    },
    // 云同步防抖的定时器：回空实现，避免挂起的定时器拖住测试进程
    setTimeout: function () {
      return 0;
    },
    clearTimeout: function () {},
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(STORE_SRC, sandbox, { filename: STORE_PATH });
  return sandbox.module.exports;
}

/* ---------------- 1. 精灵图常量 ---------------- */
console.log('[1] 精灵图常量（必须与 assets/avatars.png 实际尺寸一致）');
{
  const s = avatar.SPRITE;
  check(!!s, '导出了 SPRITE');
  check(s && s.cols === 4, 'cols === 4（实际 ' + (s && s.cols) + '）');
  check(s && s.rows === 2, 'rows === 2（实际 ' + (s && s.rows) + '）');
  check(s && s.cell === 192, 'cell === 192（实际 ' + (s && s.cell) + '）');
  check(s && s.src === '../../assets/avatars.png', 'src 指向 assets/avatars.png（实际 ' + (s && s.src) + '）');
  check(avatar.GENDERS.length === 2, '2 个性别');
  check(
    avatar.GENDERS[0].id === 'boy' && avatar.GENDERS[1].id === 'girl',
    '性别顺序 = 男孩、女孩'
  );
  check(avatar.DEFAULT_ID === 'boy-1', '默认形象 = boy-1');
}

/* ---------------- 2. 8 个形象 ---------------- */
console.log('[2] 8 个形象清单（每性别 4 个）');
{
  const list = avatar.LIST;
  check(Array.isArray(list) && list.length === 8, 'LIST 有 8 条（实际 ' + (Array.isArray(list) ? list.length : 'N/A') + '）');
  const ids = list.map((x) => x.id);
  check(new Set(ids).size === 8, '8 个 id 互不重复');
  const boys = list.filter((x) => x.gender === 'boy');
  const girls = list.filter((x) => x.gender === 'girl');
  check(boys.length === 4, '男孩 4 个（实际 ' + boys.length + '）');
  check(girls.length === 4, '女孩 4 个（实际 ' + girls.length + '）');
  check(list.every((x) => x.gender === 'boy' || x.gender === 'girl'), '性别只有 boy / girl 两种值');
  check(list.every((x) => typeof x.name === 'string' && x.name.length > 0), '每个形象都有非空名称');
  check(list.every((x) => x.col >= 0 && x.col < 4 && (x.row === 0 || x.row === 1)), 'col ∈ [0,4) 且 row ∈ {0,1}');
  // 落位必须就是「第 i 个 = 第 i%4 列、第 floor(i/4) 行」，与生成器写入精灵图的顺序一一对应
  check(
    list.every((x, i) => x.col === i % 4 && x.row === Math.floor(i / 4)),
    'col/row 与在 LIST 中的序号一致（左到右、上到下）'
  );
  check(
    list.slice(0, 4).every((x) => x.row === 0) && list.slice(4).every((x) => x.row === 1),
    '第 0 行全是男孩、第 1 行全是女孩'
  );
  check(
    list.map((x) => x.id).join(',') === 'boy-1,boy-2,boy-3,boy-4,girl-1,girl-2,girl-3,girl-4',
    'id 顺序固定（精灵图落位不能乱）'
  );
}

/* ---------------- 3. 查表与兜底 ---------------- */
console.log('[3] findById / listByGender');
{
  const g4 = avatar.findById('girl-4');
  check(!!g4 && g4.row === 1 && g4.col === 3 && g4.gender === 'girl', 'findById(girl-4) 命中第 2 行第 4 列');
  check(avatar.findById('girl-5') === null, '已下线的 girl-5 → null（不硬编成别的格子）');
  check(avatar.findById('nope') === null, '不存在的 id → null');
  check(avatar.findById('') === null, '空字符串 → null');
  check(avatar.findById(null) === null, 'null → null');
  check(avatar.listByGender('boy').length === 4, 'listByGender(boy) → 4 个');
  check(avatar.listByGender('boy').every((x) => x.gender === 'boy'), '返回的全是男孩');
  check(avatar.listByGender('girl')[0].id === 'girl-1', '女孩列表第一个是 girl-1');
  check(avatar.listByGender('x').length === 0, '非法性别 → 空数组（不崩）');
  check(avatar.listByGender(null).length === 0, 'null 性别 → 空数组');
}

/* ---------------- 4. 取图坐标 ---------------- */
console.log('[4] 精灵图取图坐标（tx = -100/cols*col, ty = -100/rows*row）');
{
  const t1 = avatar.tileOf('boy-1');
  check(t1 && t1.id === 'boy-1' && t1.tx === 0 && t1.ty === 0, 'boy-1 → (0%, 0%)（实际 ' + (t1 && t1.tx) + ',' + (t1 && t1.ty) + '）');
  const t4 = avatar.tileOf('boy-4');
  check(t4.tx === -75, 'boy-4（第 4 列）→ tx = -75（实际 ' + t4.tx + '）');
  const g1 = avatar.tileOf('girl-1');
  check(g1.tx === 0 && g1.ty === -50, 'girl-1 → (0, -50)（实际 ' + g1.tx + ',' + g1.ty + '）');
  const g4 = avatar.tileOf('girl-4');
  check(g4.tx === -75 && g4.ty === -50, 'girl-4 → (-75, -50)（实际 ' + g4.tx + ',' + g4.ty + '）');
  // 同一列 tx 必须相同、同一行 ty 必须相同 —— 否则精灵图会「歪着切」
  const all = avatar.LIST.map((x) => avatar.tileOf(x.id));
  check(
    new Set(all.map((x) => x.tx)).size === 4 && new Set(all.map((x) => x.ty)).size === 2,
    '8 个坐标只有 4 个不同的 tx、2 个不同的 ty（不歪切）'
  );
  check(all.every((x) => x.tx <= 0 && x.ty <= 0), 'tx / ty 都是非正数（向左上位移）');
  check(all.every((x) => x.tx >= -100 && x.ty >= -100), 'tx / ty 都在 [-100,0] 内（位移不超过一张图）');
  check(t1.name === '棒球帽' && typeof t1.gender === 'string', 'tile 上带 name / gender（页面直接用）');
}

/* ---------------- 5. 脏数据兜底 ---------------- */
console.log('[5] 脏数据兜底（永不返回 null）');
{
  ['nope', '', null, undefined, 123, {}, 'boy-9', 'girlX-1'].forEach(function (bad) {
    const t = avatar.tileOf(bad);
    check(!!t && t.id === 'boy-1' && t.tx === 0 && t.ty === 0, 'tileOf(' + JSON.stringify(bad) + ') → 默认形象');
  });
  check(avatar.normalizeId('girl-3') === 'girl-3', 'normalizeId 合法 id 原样返回');
  check(avatar.normalizeId('nope') === 'boy-1', 'normalizeId 非法 → 默认');
  check(avatar.normalizeId(null) === 'boy-1', 'normalizeId(null) → 默认');
  check(avatar.normalizeId(123) === 'boy-1', 'normalizeId(123) → 默认（不是数字比较）');
  check(avatar.defaultTile().id === 'boy-1', 'defaultTile() → boy-1');
}

/* ---------------- 6. 老 id 同性别迁移 ---------------- */
console.log('[6] migrateId：老存档（曾每性别 6 个）同性别兜底');
{
  const hasMig = typeof avatar.migrateId === 'function';
  check(hasMig, '导出了 migrateId');
  // 未实现时短路，避免后面一行行 TypeError 把整个自检打断（只看到堆栈、看不到断言）
  const mig = hasMig
    ? avatar.migrateId
    : function () {
        return '<<未实现>>';
      };
  // 下线的老 id → 同性别第 1 个（**不能**变成男孩）
  check(mig('girl-6') === 'girl-1', '迁移 girl-6 → girl-1（女孩不变男孩）');
  check(mig('girl-5') === 'girl-1', '迁移 girl-5 → girl-1');
  check(mig('boy-6') === 'boy-1', '迁移 boy-6 → boy-1');
  check(mig('boy-9') === 'boy-1', '迁移越界序号 boy-9 → boy-1');
  // 仍然合法的 id 原样返回
  check(mig('boy-1') === 'boy-1', '合法 id boy-1 原样返回');
  check(mig('girl-4') === 'girl-4', '合法 id girl-4 原样返回');
  // 根本不是形象 id → 空串（调用方决定清空还是兜底默认）
  check(mig('nope') === '', 'migrateId(乱写) → 空串');
  check(mig('girlX-1') === '', 'migrateId(性别不合法) → 空串');
  check(mig('') === '', 'migrateId(空串) → 空串');
  check(mig(null) === '', 'migrateId(null) → 空串');
  check(mig(123) === '', 'migrateId(数字) → 空串');
  // normalizeId / tileOf 也要走迁移
  check(avatar.normalizeId('girl-6') === 'girl-1', 'normalizeId(girl-6) → girl-1（不是默认男孩）');
  check(avatar.normalizeId('boy-9') === 'boy-1', 'normalizeId(boy-9) → boy-1');
  check(avatar.tileOf('girl-6').id === 'girl-1', 'tileOf(girl-6) 也迁移（PK 里老挑战记录不会错人）');
  check(avatar.tileOf('girl-6').ty === -50, '迁移后坐标仍是女孩那一行');
}

/* ---------------- 7. store 落盘 ---------------- */
console.log('[7] store：未设置时的默认值');
const storage = {};
{
  const store = makeStore(storage);
  check(typeof store.getAvatar === 'function', 'store 导出了 getAvatar');
  check(typeof store.hasAvatar === 'function', 'store 导出了 hasAvatar');
  check(typeof store.setAvatar === 'function', 'store 导出了 setAvatar');
  const a = store.getAvatar();
  check(a.id === 'boy-1', '未设置 → 默认形象 boy-1（不是 undefined）');
  check(a.tx === 0 && a.ty === 0, '未设置 → 坐标是默认形象的（页面能直接渲染）');
  check(store.hasAvatar() === false, '未设置 → hasAvatar() === false');
}

console.log('[8] store：设置与读取');
{
  const store = makeStore(storage);
  check(store.setAvatar('girl-4') === 'girl-4', 'setAvatar(girl-4) 返回归一的 id');
  check(store.hasAvatar() === true, '设置后 hasAvatar() === true');
  const a = store.getAvatar();
  check(a.id === 'girl-4', 'getAvatar().id === girl-4');
  check(a.gender === 'girl', '性别由 id 推导 = girl');
  check(a.tx === -75 && a.ty === -50, 'girl-4 坐标 (-75, -50)（实际 ' + a.tx + ',' + a.ty + '）');
}

console.log('[9] store：非法输入不改动已有选择');
{
  const store = makeStore(storage);
  check(store.setAvatar('乱写') === 'girl-4', 'setAvatar(乱写) 不写入，返回当前值');
  check(store.setAvatar(null) === 'girl-4', 'setAvatar(null) 不写入');
  check(store.setAvatar('') === 'girl-4', 'setAvatar(空串) 不写入');
  // ⚠️ 已下线的老 id 也算「非法输入」：setAvatar 是页面点选调用的，只接受在册形象。
  //    老存档的迁移发生在 loadProgress 归一化，不走这里。
  check(store.setAvatar('girl-6') === 'girl-4', 'setAvatar(已下线的 girl-6) 不写入');
  check(store.hasAvatar() === true, '仍然处于「已设置」状态');
  check(store.getAvatar().id === 'girl-4', '原选择没被冲掉');
}

console.log('[10] store：重启后读回（形象随进度同步上云的前提）');
{
  const store = makeStore(storage); // 同一份 storage = App 重启
  check(store.getAvatar().id === 'girl-4', '重启后仍是 girl-4');
  check(store.hasAvatar() === true, '重启后 hasAvatar() 仍为 true');
  check(store.getProgress().avatarId === 'girl-4', 'progress.avatarId 已落盘');
}

console.log('[11] store：老存档与脏数据');
{
  const legacy = {};
  legacy['starwords-progress'] = JSON.stringify({ progressVersion: 2, words: [], stars: 7 });
  const s1 = makeStore(legacy);
  check(s1.getAvatar().id === 'boy-1', '旧存档（无 avatarId）→ 默认形象');
  check(s1.hasAvatar() === false, '旧存档 → hasAvatar() false（会再引导一次）');

  // ★ 关键：曾选过已下线形象的孩子，要被迁移到**同性别**第 1 个，且保留「已设置」
  const stale = {};
  stale['starwords-progress'] = JSON.stringify({ progressVersion: 2, words: [], avatarId: 'girl-6' });
  const s2 = makeStore(stale);
  check(s2.getAvatar().id === 'girl-1', '★存着 girl-6 的老存档 → 迁移到 girl-1（女孩不变男孩）');
  check(s2.hasAvatar() === true, '★迁移后仍算「已设置」（不会把孩子再引导一遍）');
  check(s2.getProgress().avatarId === 'girl-1', '★迁移结果已就地落盘（不是只在内存里兜底）');
  check(s2.getAvatar().ty === -50, '迁移后坐标落在女孩那一行');

  const staleBoy = {};
  staleBoy['starwords-progress'] = JSON.stringify({ progressVersion: 2, words: [], avatarId: 'boy-9' });
  const s3 = makeStore(staleBoy);
  check(s3.getAvatar().id === 'boy-1' && s3.hasAvatar() === true, 'boy-9 → 迁移到 boy-1 且保留已设置');

  const broken = {};
  broken['starwords-progress'] = JSON.stringify({ progressVersion: 2, words: [], avatarId: null });
  const s4 = makeStore(broken);
  check(s4.getAvatar().id === 'boy-1' && s4.hasAvatar() === false, 'avatarId = null → 默认且视为未设置');

  const broken2 = {};
  broken2['starwords-progress'] = JSON.stringify({ progressVersion: 2, words: [], avatarId: 12345 });
  const s5 = makeStore(broken2);
  check(s5.getAvatar().id === 'boy-1' && s5.hasAvatar() === false, 'avatarId = 数字 → 默认且视为未设置');

  const broken3 = {};
  broken3['starwords-progress'] = JSON.stringify({ progressVersion: 2, words: [], avatarId: '乱写' });
  const s6 = makeStore(broken3);
  check(s6.getAvatar().id === 'boy-1' && s6.hasAvatar() === false, 'avatarId 是完全无关的字符串 → 默认且视为未设置');
}

console.log('[12] store：重置进度会一并清掉形象');
{
  const store = makeStore(storage);
  store.resetProgress();
  check(store.hasAvatar() === false, 'resetProgress() 后回到未设置');
  check(store.getAvatar().id === 'boy-1', 'resetProgress() 后是默认形象');
}

console.log(failed ? '\n形象自检失败：' + failed + ' 项 ✗' : '\n形象自检全部通过 ✓');
process.exit(failed ? 1 : 0);
