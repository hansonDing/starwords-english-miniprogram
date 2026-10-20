// 单词 / 例句发音播放。
//
// 音频不再是「一个词一个 mp3」，而是按周合并成 40+40 个周包（见
// starwords-miniprogram-scripts/gen-audio-packs.py 与 utils/audioPackMap.js）。
// 原因：400 个 mp3 占了预览编译器 MAX_SOURCE_FILES = 500 的 84%。
// 每个 mp3 都是 MPEG-2 Layer III / 16kHz / CBR 的纯帧文件（无 ID3、无 Xing 帧），
// 所以合并是「逐帧首尾相接」，零重编码、音质与原始完全一致。
//
// 播放方式：加载整包 → 设 startTime 定位到段 → play() → 定时器到点 stop()。
//
// 两个容易踩的点：
//   1. **不能靠 onEnded** —— 合并后 onEnded 只在整包播完时触发，不是段结束。
//      所以必须自己按段时长定时停止。resolve 时间点也改由定时器决定。
//   2. **定时器必须先清** —— 上一段的停止定时器如果没清掉，会提前把下一段停掉
//      （表现是「点了没声音」）。每次播放前 clearStopTimer()。
//
// 为什么不垫静音：实测（2026-10-16，各抽 60 条）每个片段自带前导静音
// 单词中位 150ms / 最小 140ms，例句中位 130ms / 最小 120ms。定时器晚停 100ms 以内
// 听到的仍是下一段的前导静音，不会串音；垫静音只会白白多占约 390KB。
const map = require('./audioPackMap');

// 包内绝对路径。真机 InnerAudioContext 不接受 ../ 相对路径（readFile:fail、无声），
// 必须用包根绝对路径；模拟器两者都能解析，所以统一用绝对路径最省事。
const PACK_DIR = { wp: '/assets/audio/', pp: '/assets/phrases/' };

// 段末多等 50ms 再算结束：这段落在下一段的「前导静音」里，听不出来，
// 但能保证这一段自己的尾部没有被提前切掉。
const TAIL_MS = 50;

let currentCtx = null;
let currentPack = null;
let stopTimer = null;
// 当前「还没播完」的那一段的结束回调。被下一段抢占时必须调用它，
// 否则那个 Promise 永远 pending —— 页面若 await 它就会卡死（表现：点了没反应）。
let pendingDone = null;
// 当前段的失败回调。ctx 会跨段复用，onError 只能绑一次，所以要走这个「当前」引用，
// 不能把某一段自己的 reject 直接闭进 onError（复用后就会指向已结束的旧段）。
let currentFail = null;

function clearStopTimer() {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  if (pendingDone) {
    const done = pendingDone;
    pendingDone = null;
    done();
  }
}

function destroyCtx() {
  clearStopTimer();
  currentFail = null;
  if (currentCtx) {
    try {
      currentCtx.stop();
    } catch (e) {
      /* 忽略：ctx 可能已失效 */
    }
    try {
      currentCtx.destroy();
    } catch (e) {
      /* 忽略 */
    }
    currentCtx = null;
    currentPack = null;
  }
}

/**
 * 按词条 id 取段并播放。
 * ⚠️ 单词与例句分成 SEG / PSEG 两张表，查错表不会报错、只会「静默无声」。
 */
function playFrom(table, id, label) {
  const seg = id ? table[id] : null;
  if (!seg) {
    // 静态自检（audio-pack-check.cjs）保证 200 条 id 都在映射表里，
    // 走到这里说明数据或映射表不同步 —— 不静默吞掉，但要保证不阻塞页面流程。
    console.warn('[audio] 未登记的' + label + ' id：' + id);
    return Promise.resolve();
  }
  return playSeg(seg);
}

/**
 * 播放单词发音。
 * @param {string} id 词条 id（如 'w1-1'），来自 words.js 的 audio 字段
 * @returns {Promise} 段播完时 resolve；加载失败 reject
 */
function play(id) {
  return playFrom(map.SEG, id, '单词');
}

function playSeg(seg) {
  return new Promise((resolve, reject) => {
    // 关键：先清掉上一段的停止定时器，否则它会提前把这一段停掉；
    // 同时让上一段的 Promise 正常收尾（见 pendingDone 注释）。
    clearStopTimer();

    // 2026-10-19 修复同包串音：不再复用同一个 InnerAudioContext。
    // 同包切换时如果复用 ctx，在微信基础库某些环境（尤其 iOS）下，
    // stop() 后设置的 startTime 不会生效，导致音频仍从包开头（第一段）播放，
    // 孩子听到的是该周第一个单词的声音，而不是当前单词。
    // 每次新建 ctx 可确保 startTime 在 play() 前生效，彻底避免串音。
    destroyCtx();
    const created = wx.createInnerAudioContext();
    currentCtx = created;
    currentPack = seg.p;
    created.obeyMuteSwitch = false; // 学习场景不受静音开关影响
    created.onError((err) => {
      if (currentFail) currentFail(err);
    });
    created.src = (PACK_DIR[seg.p.slice(0, 2)] || '/assets/audio/') + seg.p + '.mp3';

    const ctx = currentCtx;
    const pack = seg.p;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (pendingDone === done) pendingDone = null;
      if (currentFail === fail) currentFail = null;
      fn(arg);
    };
    const done = () => finish(resolve);
    const fail = (err) => {
      const stale = currentCtx === ctx && currentPack === pack;
      finish(reject, err);
      if (stale) destroyCtx(); // 包已播坏，整个 ctx 作废
    };
    pendingDone = done;
    currentFail = fail;

    // 定位到段首：stop() 会回到文件开头，再设 startTime 才生效
    try {
      ctx.stop();
    } catch (e) {
      /* 忽略：新 ctx 还没播过 */
    }
    ctx.startTime = seg.o;
    ctx.play();

    stopTimer = setTimeout(() => {
      stopTimer = null;
      if (currentCtx === ctx && currentPack === pack) {
        try {
          ctx.stop();
        } catch (e) {
          /* 忽略 */
        }
      }
      done();
    }, Math.round((seg.d || 0) * 1000) + TAIL_MS);
  });
}

function stop() {
  destroyCtx();
}

/* ---------- 例句音频 ---------- */
// 与单词发音同一套周包机制、同一个播放器；保留独立入口是为了 learn 页语义清晰。
// ⚠️ 必须查 PSEG（例句表）—— 查 SEG 会拿到同名的单词段，播出来是「读单词」而不是「读例句」。
function playPhrase(id) {
  return playFrom(map.PSEG, id, '例句');
}

// 全局音频选项：iOS 静音开关下也能发声
try {
  wx.setInnerAudioOption({ obeyMuteSwitch: false, speakerOn: true });
} catch (e) {
  /* 低版本基础库无此 API，忽略 */
}

module.exports = { play, playPhrase, stop };
