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
    // 启动时对一次账：先拉（云端较新才覆盖本地），再推（本地较新才写上去）。
    // 顺序不能反 —— 新设备上本地是空档，先推就把云端进度擦了（syncToCloud 里还有一道兜底）。
    // 「先推」这一步也是断网 / 1.5 秒防抖窗口内被杀进程后的自动补传。
    store.pullFromCloud().then(() => store.syncToCloud());
    // 上次答题时网络不通、成绩没传出去的，趁启动补传（失败就继续留着）
    require('./utils/pkCloud').retryPending();
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
