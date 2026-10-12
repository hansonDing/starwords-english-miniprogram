// 分享（转发给好友 / 分享到朋友圈）统一配置
// 微信规则：
//   1. 页面必须实现 onShareAppMessage，「转发」才会启用并可自定义卡片；朋友圈需 onShareTimeline。
//   2. app.js 用 Page 包装器给所有页面注入默认分享能力（页面若已自定义则不覆盖）。
//   3. 账号侧还需满足：已完成【微信认证】+【ICP 备案】，否则微信会限制「被分享 / 被搜索」能力，
//      这时无论代码怎么写，按钮都会被置灰 / 提示不可分享。

var TITLE = '星星英语 · 每天 5 个单词，陪孩子开口说英语';
var PATH = '/pages/index/index';

function appMessage() {
  return { title: TITLE, path: PATH };
}

function timeline() {
  return { title: TITLE, query: '' };
}

// 给页面配置补上默认分享能力；返回同一个配置对象
function attach(options) {
  if (!options || typeof options !== 'object') return options;

  // 进页面时显式打开右上角菜单里的「转发」「分享到朋友圈」
  var originOnLoad = options.onLoad;
  options.onLoad = function (query) {
    try {
      wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
    } catch (e) {
      /* 旧基础库 / 预览模拟器不支持该参数则忽略 */
    }
    if (typeof originOnLoad === 'function') return originOnLoad.call(this, query);
  };

  if (typeof options.onShareAppMessage !== 'function') options.onShareAppMessage = appMessage;
  if (typeof options.onShareTimeline !== 'function') options.onShareTimeline = timeline;
  return options;
}

module.exports = {
  TITLE: TITLE,
  PATH: PATH,
  appMessage: appMessage,
  timeline: timeline,
  attach: attach,
};
