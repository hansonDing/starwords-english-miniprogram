/**
 * 星星形象运行时自检：真跑 pages/avatar/avatar.js 与 pages/pk-play/pk-play.js。
 *
 * 为什么需要：静态检查只能证明「代码里出现了这几行」，证明不了形象真的跟着孩子选的那个走。
 *   这一层锁住四件事，全是**界面看起来正常但结果错**的：
 *     ① 形象页的选择流转（选性别 → 选形象 → 落盘），以及「非法点击不能把已选清掉」
 *     ② 换性别来回切换时，该性别下已保存的形象要自动选回来（不然白选一场）
 *     ③ PK 舞台用的必须**是孩子自己那只形象**（改回写死也不报错，只是显示错人）
 *     ④ 答错变黑之后**下一题必须复原**（否则后面每题都是黑的）
 *
 * 做法：store 与 avatar 用**真实模块**（形象存取逻辑在里面），只桩掉云端与 wx。
 * setTimeout 收进队列手动推进（答对/答错的延迟是流程的一部分）。
 *
 * 用法： node avatar-runtime-check.cjs
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
function flush() {
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

const realAvatar = loadCjs(path.join(ROOT, 'utils', 'avatar.js'));
const realScheduler = loadCjs(path.join(ROOT, 'utils', 'scheduler.js'));
const STORE_PATH = path.join(ROOT, 'utils', 'store.js');
const STORE_SRC = fs.readFileSync(STORE_PATH, 'utf8');

/** 真实 store（纯本地模式，云端桩掉） */
function makeRealStore(storage) {
  const mod = { exports: {} };
  const sandbox = {
    console: { log: function () {}, error: console.error },
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
      if (id === './avatar') return realAvatar;
      if (id === './cloud') return { cloud: null, cloudError: '', available: false };
      // 年级功能之后 store 也依赖词库（gradeOfWeek / getWeekWords）—— 纯数据，直接加载真实文件
      if (id === './words') return loadCjs(path.join(ROOT, 'utils', 'words.js'));
      throw new Error('avatar-runtime-check: store 未预期的 require → ' + id);
    },
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

/* ---------- wx 桩 + 可控定时器 ---------- */
const toasts = [];
const navigations = [];
let timers = [];
function runTimers() {
  const pending = timers;
  timers = [];
  for (let i = 0; i < pending.length; i++) pending[i].fn();
}
const wxStub = {
  showToast: function (o) {
    toasts.push(o && o.title);
  },
  showLoading: function () {},
  hideLoading: function () {},
  setNavigationBarTitle: function () {},
  switchTab: function (o) {
    navigations.push('switchTab:' + (o && o.url));
  },
  redirectTo: function (o) {
    navigations.push('redirectTo:' + (o && o.url));
  },
  navigateTo: function (o) {
    navigations.push('navigateTo:' + (o && o.url));
  },
  navigateBack: function () {
    navigations.push('navigateBack');
  },
  vibrateShort: function () {},
  getAccountInfoSync: function () {
    return { miniProgram: { appId: 'touristappid' } };
  },
};

function loadPage(pagePath, stubs) {
  let def = null;
  const sandbox = {
    console: console,
    module: { exports: {} },
    exports: {},
    require: function (id) {
      if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
      throw new Error('avatar-runtime-check: 未预期的 require（' + pagePath + '）→ ' + id);
    },
    Page: function (o) {
      def = o;
    },
    wx: wxStub,
    // 页面里用 getCurrentPages() 判断有没有上一页
    getCurrentPages: function () {
      return [{ route: 'pages/mine/mine' }, { route: 'pages/avatar/avatar' }];
    },
    setTimeout: function (fn) {
      timers.push({ fn: fn });
      return timers.length;
    },
    clearTimeout: function () {},
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(pagePath, 'utf8'), sandbox, { filename: pagePath });
  return def;
}

function makePage(def) {
  const p = Object.assign({}, def);
  p.data = JSON.parse(JSON.stringify(def.data));
  p.setData = function (patch) {
    Object.keys(patch).forEach(function (k) {
      p.data[k] = patch[k];
    });
  };
  return p;
}

const AVATAR_PATH = path.join(ROOT, 'pages', 'avatar', 'avatar.js');
const PLAY_PATH = path.join(ROOT, 'pages', 'pk-play', 'pk-play.js');

/* ================= 形象页 ================= */
const storageA = {};
const storeA = makeRealStore(storageA);

const avatarStubs = {
  '../../utils/store': storeA,
  '../../utils/avatar': realAvatar,
};

const avatarDef = loadPage(AVATAR_PATH, avatarStubs);
check(!!avatarDef, '[0] 捕获真实 pages/avatar/avatar.js 的 Page 定义');
if (!avatarDef) {
  console.error('\n形象运行时自检失败：Page 定义缺失 ✗');
  process.exit(1);
}

console.log('[1] 第一次进来：先选性别');
{
  const p = makePage(avatarDef);
  p.onLoad({ from: 'login' });
  check(p.data.step === 'gender', '未设置过形象 → 停在第 1 步选性别');
  check(p.data.from === 'login', '记住是从登录引导进来的');
  check(p.data.genders.length === 2, '两张大卡片（男孩 / 女孩）');
  check(p.data.genders[0].name === '男孩' && p.data.genders[1].name === '女孩', '卡片文案正确');
  check(p.data.genders[0].tx === 0 && p.data.genders[0].ty === 0, '男孩卡片预览用该性别的第 1 个形象（boy-1 坐标）');
  check(p.data.genders[1].tx === 0 && p.data.genders[1].ty === -50, '女孩卡片预览用 girl-1 坐标');
  check(p.data.list.length === 0, '还没选性别 → 形象列表为空');
  check(p.data.preview === null, '还没选 → 没有大图预览');
  check(p.data.selectedId === '', '没有选中项 → 「就选它啦」按钮会是禁用态');
}

console.log('[2] 选男孩 → 出 4 个形象');
{
  const p = makePage(avatarDef);
  p.onLoad({});
  p.onPickGender({ currentTarget: { dataset: { id: 'boy' } } });
  check(p.data.step === 'pick', '进入第 2 步');
  check(p.data.list.length === 4, '男孩 4 个形象');
  check(p.data.list.every((x) => x.gender === 'boy'), '全是男孩');
  check(p.data.list.every((x) => x.ty === 0), '第 1 行取图 ty 都是 0');
  check(new Set(p.data.list.map((x) => x.tx)).size === 4, '4 个横向坐标互不相同（不会切到同一个格子）');
  check(p.data.list.map((x) => x.name).join(',') === '棒球帽,短袖T恤,背带裤,小超人', '顺序与精灵图落位一致');
  check(p.data.selectedId === '' && p.data.preview === null, '还没点具体形象 → 仍然没选中');
}

console.log('[3] 点形象 → 选中 + 大图预览');
{
  const p = makePage(avatarDef);
  p.onLoad({});
  p.onPickGender({ currentTarget: { dataset: { id: 'boy' } } });
  p.onPickAvatar({ currentTarget: { dataset: { id: 'boy-3' } } });
  check(p.data.selectedId === 'boy-3', '选中 boy-3');
  check(!!p.data.preview && p.data.preview.name === '背带裤', '大图预览切到「背带裤」');
  check(p.data.preview.tx === -50 && p.data.preview.ty === 0, '预览坐标是该格子的（第 3 列 → tx = -50）');
  // 非法 id（理论上点不到）不能把已选清掉
  p.onPickAvatar({ currentTarget: { dataset: { id: 'nope' } } });
  check(p.data.selectedId === 'boy-3', '★非法 id 不清掉已选形象');
}

console.log('[4] 换性别来回切：该性别下已保存的形象要自动选回来');
{
  const p = makePage(avatarDef);
  p.onLoad({});
  p.onPickGender({ currentTarget: { dataset: { id: 'girl' } } });
  p.onPickAvatar({ currentTarget: { dataset: { id: 'girl-3' } } });
  p.onConfirm();
  runTimers();
  check(storeA.getAvatar().id === 'girl-3', '确认后落盘 girl-3');
  check(storeA.hasAvatar() === true, 'store 认为已设置');
  check(toasts.indexOf('这就是我啦！') !== -1, '给了成功提示');
  check(navigations.indexOf('navigateBack') !== -1, '确认后回到上一页');

  const p2 = makePage(avatarDef);
  p2.onLoad({});
  check(p2.data.step === 'pick', '已设置过 → 直接进第 2 步（是来「换」的，不逼着重选性别）');
  check(p2.data.selectedId === 'girl-3', '自动选中当前形象');
  check(p2.data.gender === 'girl', '性别自动落在女孩');

  p2.onBackGender();
  check(p2.data.step === 'gender', '点「换性别」回到第 1 步');
  p2.onPickGender({ currentTarget: { dataset: { id: 'boy' } } });
  check(p2.data.selectedId === '', '换到男孩 → 男孩下没存过形象，不预选');
  p2.onBackGender();
  p2.onPickGender({ currentTarget: { dataset: { id: 'girl' } } });
  check(p2.data.selectedId === 'girl-3', '★再切回女孩 → 自动选回 girl-3（不然白选一场）');
}

console.log('[5] 没选就确认 → 拦下来，不能落盘');
{
  const storageB = {};
  const storeB = makeRealStore(storageB);
  const def = loadPage(AVATAR_PATH, { '../../utils/store': storeB, '../../utils/avatar': realAvatar });
  const p = makePage(def);
  p.onLoad({});
  p.onPickGender({ currentTarget: { dataset: { id: 'boy' } } });
  toasts.length = 0;
  navigations.length = 0;
  p.onConfirm();
  check(storeB.hasAvatar() === false, '★没选形象 → 不会写进存档（也不会静默存个默认值）');
  check(toasts.indexOf('先挑一个星星形象吧') !== -1, '明确提示要先挑一个');
  check(navigations.length === 0, '不跳转');
}

console.log('[6] 未登录也能设置（存本机）');
{
  check(storeA.getAvatar().id === 'girl-3', '形象页不需要登录就能落盘（云端在这里是桩掉的 null）');
}

/* ================= PK 答题页 ================= */
const storageP = {};
const playStore = makeRealStore(storageP);

let sessionStub = null;
let fetchResult = null;
let submitOk = true;
const submitted = [];
const fakeCloud = {
  auth: {
    getSession: function () {
      return Promise.resolve({ data: sessionStub });
    },
  },
};
const fakePkCloud = {
  fetch: function () {
    return Promise.resolve(fetchResult);
  },
  submitResult: function (id, payload) {
    submitted.push({ id: id, payload: payload });
    return Promise.resolve(submitOk);
  },
  create: function () {
    return Promise.resolve(true);
  },
  listMine: function () {
    return Promise.resolve([]);
  },
  listIncoming: function () {
    return Promise.resolve([]);
  },
  markRead: function () {
    return Promise.resolve(true);
  },
};
const fakeLeaderboard = {
  getNickname: function () {
    return '星星学员';
  },
  setNickname: function (x) {
    return x;
  },
  DEFAULT_NICKNAME: '星星学员',
  NICKNAME_KEY: 'starwords-nickname',
};
const playStubs = {
  '../../utils/words': {
    WORDS: [
      { id: 'w1-1', word: 'Apple', meaning: '苹果', phonetic: '/a/', imgTx: 0, imgTy: 0 },
      { id: 'w1-2', word: 'Banana', meaning: '香蕉', phonetic: '/b/', imgTx: 0, imgTy: 0 },
      { id: 'w1-3', word: 'Orange', meaning: '橙子', phonetic: '/o/', imgTx: 0, imgTy: 0 },
    ],
    getWordById: function (id) {
      return null;
    },
  },
  '../../utils/cloud': { cloud: fakeCloud, cloudError: '', available: true },
  '../../utils/store': playStore,
  '../../utils/avatar': realAvatar,
  '../../utils/pk': loadCjs(path.join(ROOT, 'utils', 'pk.js')),
  '../../utils/pkCloud': fakePkCloud,
  '../../utils/leaderboard': fakeLeaderboard,
};
const playDef = loadPage(PLAY_PATH, playStubs);
check(!!playDef, '[7] 捕获真实 pages/pk-play/pk-play.js 的 Page 定义');

function playAllCorrect(p) {
  while (p.data.mode === 'playing') {
    const q = p.data.current;
    p.onPickOption({ currentTarget: { dataset: { idx: q.answerIdx } } });
    runTimers();
  }
}

(async function () {
  console.log('[7] PK 舞台用的是孩子自己选的形象');
  {
    playStore.setAvatar('girl-3'); // 花仙子
    sessionStub = null; // 未登录（点开分享卡片的常态）
    fetchResult = {
      id: 'pk-1',
      challenger_id: 'u9',
      challenger_name: '小明',
      challenger_avatar: 'boy-4',
      word_ids: ['w1-1', 'w1-2', 'w1-3'],
      status: 'pending',
    };
    const p = makePage(playDef);
    p.onLoad({ id: 'pk-1' });
    await flush();
    await flush();
    check(p.data.mode === 'playing', '未登录也能开始答题（不卡登录墙）');
    check(!!p.data.av && p.data.av.id === 'girl-3', '★舞台形象 = 孩子自己选的 girl-3');
    check(p.data.av.tx === -50 && p.data.av.ty === -50, '取图坐标是 girl-3 那一格（第 3 列 / 第 2 行）');
    check(!!p.data.pkAv && p.data.pkAv.id === 'boy-4', '出题者形象来自挑战记录 (boy-4)');
  }

  console.log('[8] 答错：雷击 + 变黑；下一题必须复原');
  {
    fetchResult.status = 'pending';
    const p = makePage(playDef);
    p.onLoad({ id: 'pk-1' });
    await flush();
    await flush();
    const q0 = p.data.current;
    const wrong = (q0.answerIdx + 1) % q0.options.length;
    p.onPickOption({ currentTarget: { dataset: { idx: wrong } } });
    check(p.data.figureDark === true, '★答错 → 变黑（figureDark）');
    check(p.data.figureHit === true, '★答错 → 雷击（figureHit）');
    check(p.data.flashing === true, '答错 → 白闪');
    runTimers(); // 推进延时 → 下一题
    check(p.data.mode === 'playing', '还有题 → 继续答题');
    check(p.data.figureDark === false, '★下一题复原成亮色（否则后面每题都是黑的）');
    check(p.data.figureHit === false, '雷击状态也复原');
    check(p.data.pickedIdx === -1, '新题的选项回到未选状态');
  }

  console.log('[9] 结算页：对战双方形象都在');
  {
    fetchResult.status = 'pending';
    const p = makePage(playDef);
    p.onLoad({ id: 'pk-1' });
    await flush();
    await flush();
    playAllCorrect(p);
    check(p.data.mode === 'done', '答完 → 结算页');
    check(!!p.data.av && p.data.av.id === 'girl-3', '★结算页左「我」仍是自己的形象');
    check(!!p.data.pkAv && p.data.pkAv.id === 'boy-4', '★结算页右「对方」是出题者形象');
    check(p.data.earnedStars === 3, '答对 3 题得 3 颗星');
  }

  console.log('[10] 兜底：出题者没设形象 / 自己也没设过');
  {
    const storageE = {};
    const storeE = makeRealStore(storageE);
    const stubs = Object.assign({}, playStubs);
    stubs['../../utils/store'] = storeE;
    const def = loadPage(PLAY_PATH, stubs);
    fetchResult.status = 'pending';
    fetchResult.challenger_avatar = null; // 老记录没有这一列
    const p = makePage(def);
    p.onLoad({ id: 'pk-1' });
    await flush();
    await flush();
    check(p.data.mode === 'playing', '照样能答题');
    check(!!p.data.pkAv && p.data.pkAv.id === 'boy-1', '★出题者没形象 → 默认形象（不空白、不报错）');
    check(!!p.data.av && p.data.av.id === 'boy-1', '自己没设过 → 默认形象');
  }

  console.log(failed ? '\n形象运行时自检失败：' + failed + ' 项 ✗' : '\n形象运行时自检全部通过 ✓');
  process.exit(failed ? 1 : 0);
})();
