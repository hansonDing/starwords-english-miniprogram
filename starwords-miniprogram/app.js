// StarWords 星星英语 · 儿童英语启蒙小程序
// 先装 wx API 兜底（补齐预览模拟器缺失的 API），再加载其它模块
require('./utils/wx-compat');
const store = require('./utils/store');
const share = require('./utils/share');

// 给所有页面注入默认分享能力（页面若已自定义则不覆盖）。
// 必须在各页面文件执行之前完成，所以放在 app.js 顶层。
var originPage = Page;
Page = function (options) {
  return originPage(share.attach(options));
};

App({
  onLaunch() {
    // 已登录用户在启动时拉取云端进度（云端较新时覆盖本地）
    store.pullFromCloud();
  },

  // 真机启动异常兜底：把错误暂存，首页弹出便于定位白屏原因
  onError(err) {
    try {
      wx.setStorageSync('__starwords_error', String(err).slice(0, 500));
    } catch (e) {
      /* ignore */
    }
  },
});
