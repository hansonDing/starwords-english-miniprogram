// 单词发音播放：播放打包在 assets/audio 下的预生成 mp3
//
// 路径解析在「预览模拟器」和「真机」上行为不同（踩坑记录）：
//   - 预览模拟器：/assets/... 绝对路径解析失败，只认页面相对路径 ../../assets/...
//   - 真机：InnerAudioContext 不支持 ../ 相对路径（readFile:fail、无声），
//           必须用包内绝对路径 /assets/... 或包根相对路径 assets/...
// 因此按运行环境选择首选路径，并保留完整候选链自动降级。
let currentCtx = null;
let cachedPlatform = null;

function getPlatform() {
  if (cachedPlatform) return cachedPlatform;
  try {
    cachedPlatform = wx.getDeviceInfo
      ? wx.getDeviceInfo().platform
      : wx.getSystemInfoSync().platform;
  } catch (e) {
    cachedPlatform = '';
  }
  return cachedPlatform;
}

/** 由页面相对路径生成候选播放路径（按环境排序、去重） */
function candidates(src) {
  const rootRel = src.replace(/^(\.\.\/)+/, ''); // assets/audio/x.mp3
  const abs = '/' + rootRel; // /assets/audio/x.mp3
  const isDevtools = getPlatform().indexOf('devtools') !== -1;
  const order = isDevtools ? [src, abs, rootRel] : [abs, rootRel, src];
  const seen = {};
  return order.filter((p) => {
    if (seen[p]) return false;
    seen[p] = true;
    return true;
  });
}

/**
 * 播放音频，结束时 resolve；全部候选路径失败才 reject
 * @param {string} src 页面相对路径，如 ../../assets/audio/w1-1.mp3
 */
function play(src) {
  const list = candidates(src);
  let chain = Promise.reject();
  for (const path of list) {
    chain = chain.catch(() => playOnce(path));
  }
  return chain;
}

function playOnce(src) {
  return new Promise((resolve, reject) => {
    if (currentCtx) {
      try {
        currentCtx.destroy();
      } catch (e) {
        /* ignore */
      }
      currentCtx = null;
    }
    const ctx = wx.createInnerAudioContext();
    currentCtx = ctx;
    ctx.src = src;
    ctx.obeyMuteSwitch = false; // 学习场景不受静音开关影响
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    ctx.onEnded(() => {
      ctx.destroy();
      if (currentCtx === ctx) currentCtx = null;
      settle(resolve);
    });
    ctx.onError((err) => {
      ctx.destroy();
      if (currentCtx === ctx) currentCtx = null;
      settle(reject, err);
    });
    ctx.play();
  });
}

function stop() {
  if (currentCtx) {
    try {
      currentCtx.stop();
      currentCtx.destroy();
    } catch (e) {
      /* ignore */
    }
    currentCtx = null;
  }
}

/* ---------- 例句音频 ---------- */
// 例句与单词发音都在主包内（assets/phrases、assets/audio），播放方式完全一致。
// 保留独立入口是为了 learn 页语义清晰，也便于以后换托管方式。
function playPhrase(src) {
  if (!src) return Promise.resolve();
  return play(src);
}

// 全局音频选项：iOS 静音开关下也能发声
try {
  wx.setInnerAudioOption({ obeyMuteSwitch: false, speakerOn: true });
} catch (e) {
  /* 低版本基础库无此 API，忽略 */
}

module.exports = { play, playPhrase, stop };
