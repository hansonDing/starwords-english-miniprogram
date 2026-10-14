/**
 * 分享能力「运行时」自检（check-static 只看静态文本，这里真跑一遍逻辑）。
 *
 * 为什么需要：微信的规则是「页面只有定义了 onShareAppMessage，右上角才会出现『转发』，
 * 否则置灰不可用」。本项目在 app.js 顶层用 Page 包装器统一注入，属于**运行时**行为，
 * 静态扫描看不出对不对 —— 而这个能力一旦失效是**静默**的（按钮灰掉，不报错），
 * 只能靠提审后才发现，代价是浪费一次提审机会。所以这里在本地把逻辑跑通。
 *
 * 用法： node share-runtime-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', 'starwords-miniprogram');

// ⚠️ 工作区根的 package.json 有 "type":"module"，直接 require 小程序目录里的 .js 会被当成 ESM
// 而报「module is not defined」。小程序是纯 CommonJS，必须用 Module._compile 显式按 CJS 加载。
function loadCjs(file) {
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8'), file);
  return m.exports;
}

const share = loadCjs(path.join(ROOT, 'utils', 'share.js'));

let failed = 0;
function ok(msg) {
  console.log('  ✓ ' + msg);
}
function fail(msg) {
  failed++;
  console.error('  ✗ ' + msg);
}
function check(cond, msg) {
  cond ? ok(msg) : fail(msg);
}

console.log('[1] utils/share.js attach() 行为');
{
  let showMenuArgs = null;
  global.wx = {
    showShareMenu: function (o) {
      showMenuArgs = o;
    },
  };

  const page = {
    data: { a: 1 },
    onLoad: function (q) {
      this.gotQuery = q;
    },
  };
  const returned = share.attach(page);
  check(returned === page, 'attach 返回同一个配置对象（不改引用）');
  check(typeof page.onShareAppMessage === 'function', '注入 onShareAppMessage（决定「转发」是否可用）');
  check(typeof page.onShareTimeline === 'function', '注入 onShareTimeline（决定「分享到朋友圈」是否可用）');

  const msg = page.onShareAppMessage();
  check(!!(msg && msg.title && msg.path && msg.path[0] === '/'), 'onShareAppMessage 返回带 title / 绝对 path 的对象');
  check(!!(page.onShareTimeline().title), 'onShareTimeline 返回非空 title');

  const self = {};
  page.onLoad.call(self, { from: 'test' });
  check(!!(self.gotQuery && self.gotQuery.from === 'test'), '包装后的 onLoad 仍会执行页面自己的逻辑，且 this 正确');
  check(
    !!(showMenuArgs && showMenuArgs.menus && showMenuArgs.menus.length === 2),
    'onLoad 中调用了 wx.showShareMenu（显式打开「转发」+「朋友圈」）'
  );
}

console.log('[2] 页面自定义分享不被覆盖');
{
  const custom = { onShareAppMessage: function () { return { title: 'custom' }; } };
  share.attach(custom);
  check(custom.onShareAppMessage().title === 'custom', '页面自带 onShareAppMessage 时保持原样');
}

console.log('[3] app.js 的 Page 包装器机制');
{
  let captured = null;
  const originPage = function (o) {
    captured = o;
    return 'page-constructed';
  };
  global.Page = originPage;

  // 复刻 app.js 顶层那三行（用真实 share.attach）
  const origin = Page;
  Page = function (options) {
    return origin(share.attach(options));
  };

  const ret = Page({ data: {} });
  check(ret === 'page-constructed', '包装器把 Page() 的返回值原样透传');
  check(
    !!(captured && typeof captured.onShareAppMessage === 'function' && typeof captured.onShareTimeline === 'function'),
    '经包装器注册的页面拿到两个分享处理函数'
  );
}

console.log('[4] 七个页面文件都在顶层调用 Page()');
{
  const pageRoot = path.join(ROOT, 'pages');
  const dirs = fs.readdirSync(pageRoot).filter(function (d) {
    return fs.existsSync(path.join(pageRoot, d, d + '.js'));
  });
  check(dirs.length === 7, '找到 7 个页面（实际 ' + dirs.length + '）');
  const missing = dirs.filter(function (d) {
    const src = fs.readFileSync(path.join(pageRoot, d, d + '.js'), 'utf8');
    return !/(^|\n)\s*Page\s*\(/.test(src);
  });
  check(missing.length === 0, missing.length ? '这些页面没有顶层 Page() 调用：' + missing.join(', ') : '全部页面都有顶层 Page() 调用（会被包装器接管）');
}

console.log('[5] 真实 app.js 能在沙箱里跑通且装上包装器');
{
  const appPath = path.join(ROOT, 'app.js');
  const src = fs.readFileSync(appPath, 'utf8');
  let lastPage = null;
  let appOptions = null;
  const sandbox = {
    console: console,
    Page: function (o) {
      lastPage = o;
    },
    App: function (o) {
      appOptions = o;
    },
    wx: {},
    // wx-compat / store 与本次验证无关，桩掉避免拉起云 SDK
    require: function (id) {
      if (id === './utils/share') return share;
      return {};
    },
  };
  const ctx = vm.createContext(sandbox);
  let error = null;
  try {
    vm.runInContext(src, ctx, { filename: appPath });
  } catch (e) {
    error = e;
  }
  check(!error, error ? '加载 app.js 报错：' + error.message : 'app.js 顶层代码执行无异常');
  check(!!(appOptions && typeof appOptions.onLaunch === 'function'), 'App({...}) 被调用（应用注册成功）');
  const wrapped = String(sandbox.Page);
  check(sandbox.Page !== undefined && wrapped.indexOf('attach') !== -1, '全局 Page 已被包装器替换');
  sandbox.Page({ data: {} });
  check(
    !!(lastPage && typeof lastPage.onShareAppMessage === 'function' && typeof lastPage.onShareTimeline === 'function'),
    '包装后注册的页面拿到 onShareAppMessage / onShareTimeline（真实 app.js 路径）'
  );
}

console.log(failed ? '\n分享运行时自检失败：' + failed + ' 项 ✗' : '\n分享运行时自检全部通过 ✓');
process.exit(failed ? 1 : 0);
