// wx API 兼容兜底
//
// 背景：WorkBuddy 的「预览」用的是一套自研 H5 模拟器（不是微信开发者工具），
// 它只实现了部分 wx API（storage / toast / modal / 路由 / 导航栏 / request 等），
// 其余 API 一律不存在。页面里一旦直接调用缺失的 API，就会抛异常中断生命周期，
// 预览里表现为「报错黄条」甚至整页不渲染。
//
// 这里把缺失的 API 补成安全实现：
//   - 真机 / 微信开发者工具上这些 API 原生存在，本模块不会覆盖它们；
//   - 预览模拟器上则降级为「不报错、流程能走完」，而不是崩掉。
//
// 必须在 app.js 最前面引入，保证早于任何页面代码执行。

(function installWxCompat() {
  if (typeof wx === 'undefined' || !wx) return;

  // 页面里用 wx.nextTick 做「setData 之后再播音频」这类时序控制。
  // 缺失时用 setTimeout 兜底，语义等价（下一个事件循环执行）。
  if (typeof wx.nextTick !== 'function') {
    wx.nextTick = function (fn) {
      setTimeout(fn, 0);
    };
  }

  // loading 提示：缺失时静默降级，不影响流程
  if (typeof wx.showLoading !== 'function') {
    wx.showLoading = function () {};
  }
  if (typeof wx.hideLoading !== 'function') {
    wx.hideLoading = function () {};
  }

  // 基础库信息：预览无此 API，返回空 appId 即可（仅用于诊断展示）
  if (typeof wx.getAccountInfoSync !== 'function') {
    wx.getAccountInfoSync = function () {
      return { miniProgram: { appId: '' } };
    };
  }

  // 音频选项：低版本基础库也可能没有
  if (typeof wx.setInnerAudioOption !== 'function') {
    wx.setInnerAudioOption = function () {};
  }

  // InnerAudioContext：预览模拟器没有音频能力。
  // 用一个「静音实现」顶上 —— play() 会异步触发一次 onEnded，
  // 让上层 Promise 正常 resolve，学习流程可以继续走下去（只是没有声音）。
  if (typeof wx.createInnerAudioContext !== 'function') {
    wx.createInnerAudioContext = function () {
      var handlers = { ended: [], error: [], play: [], stop: [] };
      var ctx = {
        src: '',
        obeyMuteSwitch: true,
        loop: false,
        volume: 1,
        onEnded: function (fn) { handlers.ended.push(fn); },
        onError: function (fn) { handlers.error.push(fn); },
        onPlay: function (fn) { handlers.play.push(fn); },
        onStop: function (fn) { handlers.stop.push(fn); },
        offEnded: function () { handlers.ended.length = 0; },
        offError: function () { handlers.error.length = 0; },
        play: function () {
          setTimeout(function () {
            handlers.play.forEach(function (fn) { fn(); });
            handlers.ended.forEach(function (fn) { fn(); });
          }, 0);
        },
        pause: function () {},
        stop: function () {},
        seek: function () {},
        destroy: function () {},
      };
      return ctx;
    };
  }

  // 插件：预览模拟器没有 requirePlugin 能力。
  // learn 页会探测插件是否存在，不存在则降级到本地录音器。
  if (typeof requirePlugin !== 'function') {
    try {
      // eslint-disable-next-line no-global-assign
      requirePlugin = function () { return null; };
    } catch (e) {
      // strict mode 下不能给未声明变量赋值，忽略；业务代码有 try-catch 兜底
    }
  }

  // 录音：预览模拟器没有录音能力。
  // start() 触发 onError，learn 页会提示「录音不可用，可以直接跳过跟读」，
  // 用户点「我读对了」即可继续，不会卡在跟读这一步。
  if (typeof wx.getRecorderManager !== 'function') {
    wx.getRecorderManager = function () {
      var onErrorCb = null;
      return {
        onStart: function () {},
        onStop: function () {},
        onError: function (fn) { onErrorCb = fn; },
        onPause: function () {},
        onResume: function () {},
        start: function () {
          setTimeout(function () {
            if (typeof onErrorCb === 'function') onErrorCb({ errMsg: 'recorder:fail 当前环境不支持录音' });
          }, 0);
        },
        stop: function () {},
        pause: function () {},
        resume: function () {},
      };
    };
  }
})();

module.exports = {};
