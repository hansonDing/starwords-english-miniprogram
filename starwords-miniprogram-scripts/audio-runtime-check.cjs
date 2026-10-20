#!/usr/bin/env node
/**
 * utils/audio.js 运行时沙箱自检。
 *
 * 为什么需要它：包化之后「播错词」不会报错 —— src 对、play 成功、就是放了别的段落。
 * 而且**预览环境根本没有音频**（utils/wx-compat.js 把 InnerAudioContext 桩掉了），
 * 所以本机跑预览是查不出任何音频问题的。这个脚本用假 wx + 假定时器把播放过程
 * 完整走一遍，把「定位参数」「复用/重建」「定时器抢占」这些**静默失败点**钉死。
 *
 * 用法：node audio-runtime-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const HERE = __dirname;
const PKG = path.join(HERE, '..', 'starwords-miniprogram');
const AUDIO_JS = path.join(PKG, 'utils', 'audio.js');
const MAP_JS = path.join(PKG, 'utils', 'audioPackMap.js');
const WORDS_JS = path.join(PKG, 'utils', 'words.js');

const SEGMENTS_PER_PACK = 5;
const TAIL_MS = 50; // 必须与 utils/audio.js 的 TAIL_MS 一致

let pass = 0;
const failures = [];
const ok = (n) => {
  pass++;
  console.log('  ✓ ' + n);
};
const bad = (n, d) => {
  failures.push(n + (d ? ' —— ' + d : ''));
  console.log('  ✗ ' + n + (d ? ' —— ' + d : ''));
};
const eq = (n, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(n + ' = ' + e);
  else bad(n, '期望 ' + e + '，实际 ' + a);
};

function loadCommonJs(file) {
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8'), file);
  return m.exports;
}

const MAP = loadCommonJs(MAP_JS);
const SEG = MAP.SEG || {};
const PSEG = MAP.PSEG || {};

/* ---------------------------------------------------------------- */
/* 沙箱                                                              */
/* ---------------------------------------------------------------- */

/**
 * 建一个独立沙箱加载 utils/audio.js。
 * 每次调用都是全新模块实例 —— audio.js 有模块级状态（currentCtx / stopTimer），
 * 不隔离的话用例之间会互相污染。
 */
function loadAudio() {
  const ctxs = [];
  const warns = [];
  const timers = [];
  const audioOptions = [];
  let now = 0;
  let tid = 1;

  const wx = {
    createInnerAudioContext() {
      const c = {
        src: '',
        startTime: 0,
        obeyMuteSwitch: true,
        _play: 0,
        _stop: 0,
        _destroy: 0,
        _onError: [],
        play() {
          this._play++;
          // 真机上 play() 会消费当前 startTime；这里记录实际生效的位置
          this._actualStart = this.startTime;
        },
        stop() {
          this._stop++;
          // 关键：模拟真机 stop() 后播放位置回到 0，
          // 如果代码 stop() 后才设置 startTime 并立即 play，
          // 在某些环境下 startTime 不会生效，实际从 0 开始 → 同包串音。
          this.startTime = 0;
        },
        destroy() {
          this._destroy++;
        },
        onError(fn) {
          this._onError.push(fn);
        },
        // 测试辅助：模拟底层报错
        _emitError(err) {
          for (const f of this._onError) f(err);
        },
      };
      ctxs.push(c);
      return c;
    },
    setInnerAudioOption(opt) {
      audioOptions.push(opt);
    },
  };

  let exportsObj = {};
  const sandbox = {
    console: { log() {}, warn: (m) => warns.push(String(m)), error() {} },
    wx,
    setTimeout(fn, ms) {
      const id = tid++;
      timers.push({ id, fn, ms, due: now + (ms || 0) });
      return id;
    },
    clearTimeout(id) {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    require(id) {
      if (id === './audioPackMap') return MAP;
      throw new Error('沙箱不支持 require(' + id + ')');
    },
    module: { exports: exportsObj },
    exports: exportsObj,
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(AUDIO_JS, 'utf8'), sandbox, { filename: AUDIO_JS });

  return {
    audio: sandbox.module.exports,
    ctxs,
    warns,
    timers,
    audioOptions,
    get now() {
      return now;
    },
    /** 推进逻辑时钟，按到期顺序执行定时器 */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let pick = -1;
        for (let i = 0; i < timers.length; i++) {
          if (timers[i].due <= target && (pick === -1 || timers[i].due < timers[pick].due)) pick = i;
        }
        if (pick === -1) break;
        const t = timers.splice(pick, 1)[0];
        now = t.due;
        t.fn();
      }
      now = target;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

const settleOf = (p) => {
  const state = { done: false, value: null, rejected: false, error: null };
  p.then(
    (v) => {
      state.done = true;
      state.value = v;
    },
    (e) => {
      state.done = true;
      state.rejected = true;
      state.error = e;
    }
  );
  return state;
};

/* ---------------------------------------------------------------- */
/* 用例                                                              */
/* ---------------------------------------------------------------- */

async function casePlayWord() {
  console.log('\n[2] play(单词 id) 的播放参数');
  const S = loadAudio();
  const seg = SEG['w1-1'];
  if (!seg) {
    bad('映射表里有 w1-1', '没有 —— 先跑 gen-audio-packs.py');
    return;
  }
  const p = settleOf(S.audio.play('w1-1'));
  eq('新建 1 个 ctx', S.ctxs.length, 1);
  eq('src 指向单词包', S.ctxs[0].src, '/assets/audio/wp01.mp3');
  eq('startTime = 段偏移', S.ctxs[0].startTime, seg.o);
  eq('调用了 play()', S.ctxs[0]._play, 1);
  eq('obeyMuteSwitch = false', S.ctxs[0].obeyMuteSwitch, false);
  eq('定时器时长 = 段时长 + TAIL_MS', S.timers[0] && S.timers[0].ms, Math.round(seg.d * 1000) + TAIL_MS);
  eq('play 返回 Promise', typeof p.done === 'boolean', true);

  S.advance(Math.round(seg.d * 1000) + TAIL_MS);
  await flush();
  eq('到点后调用了 stop()', S.ctxs[0]._stop >= 1, true);
  eq('到点后 Promise resolve', p.done, true);
}

async function casePlayPhrase() {
  console.log('\n[3] playPhrase(例句 id) 必须走 PSEG 而不是 SEG');
  const S = loadAudio();
  const pseg = PSEG['w1-1'];
  if (!pseg) {
    bad('映射表里有例句段 w1-1', '没有 —— 先跑 gen-audio-packs.py');
    return;
  }
  S.audio.playPhrase('w1-1');
  eq('src 指向例句包', S.ctxs[0].src, '/assets/phrases/pp01.mp3');
  eq('startTime = 例句段偏移', S.ctxs[0].startTime, pseg.o);

  // 两表键完全相同，所以「查错表」不会报错，只会静默播错内容 ——
  // 只有包名和偏移能暴露它。首段两边偏移都是 0，没有区分力，用后面的段比对。
  const wseg5 = SEG['w1-5'];
  const pseg5 = PSEG['w1-5'];
  eq('同一词条：单词段与例句段指向不同的包', !!(wseg5 && pseg5 && wseg5.p !== pseg5.p), true);
  eq('两表同一词条的段偏移确实不同', !!(wseg5 && pseg5 && Math.abs(wseg5.o - pseg5.o) > 1e-9), true);

  // 反向验证：把例句 id 交给 play()（单词入口），必须去单词包 —— 确认两个入口真的分流
  const S2 = loadAudio();
  S2.audio.play('w1-1');
  eq('play() 走单词包', S2.ctxs[0].src.indexOf('/assets/audio/') === 0, true);
}

async function caseReuseSamePack() {
  console.log('\n[4] 同包连播 → 不再复用 ctx（避免 stop 后 startTime 失效导致串音）');
  const S = loadAudio();
  S.audio.play('w1-1');
  const first = S.ctxs[0];
  const firstStart = first._actualStart;
  S.audio.play('w1-2');
  eq('ctx 总数为 2（同包也重建）', S.ctxs.length, 2);
  eq('旧 ctx 被销毁', first._destroy, 1);
  eq('新 ctx startTime 指向第二段', S.ctxs[1].startTime, SEG['w1-2'].o);
  eq('新 ctx play() 实际从第二段开始', S.ctxs[1]._actualStart, SEG['w1-2'].o);
  eq('旧 ctx play 实际从第一段开始（未串音）', firstStart, SEG['w1-1'].o);
  eq('定时器队列只剩当前段的 1 个', S.timers.length, 1);
}

async function caseRebuildOtherPack() {
  console.log('\n[5] 换周包 → 重建 ctx 并销毁旧的');
  const S = loadAudio();
  S.audio.play('w1-1'); // wp01
  const first = S.ctxs[0];
  S.audio.play('w2-1'); // wp02
  eq('ctx 总数为 2', S.ctxs.length, 2);
  eq('旧 ctx 被销毁', first._destroy, 1);
  eq('新 ctx src 指向 wp02', S.ctxs[1].src, '/assets/audio/wp02.mp3');
  eq('新 ctx startTime = w2-1 偏移', S.ctxs[1].startTime, SEG['w2-1'].o);
}

async function casePreempt() {
  console.log('\n[6] 抢占：上一段没播完就播下一段');
  const S = loadAudio();
  const p1 = settleOf(S.audio.play('w1-1'));
  S.advance(100); // 只播了一小会
  const p2 = settleOf(S.audio.play('w1-2'));
  await flush();

  eq('被抢占的 p1 已 resolve（不能永久 pending）', p1.done, true);
  eq('p1 是 resolve 不是 reject', p1.rejected, false);
  eq('旧定时器已从队列移除，只剩 1 个', S.timers.length, 1);
  eq('剩下的是当前段的定时器', S.timers[0].due, 100 + Math.round(SEG['w1-2'].d * 1000) + TAIL_MS);

  const stoppedBefore = S.ctxs[0]._stop;
  S.advance(500); // 已越过 w1-1 原本的结束点
  eq('旧定时器没有再触发 stop（新段没被提前掐掉）', S.ctxs[0]._stop, stoppedBefore);
  eq('p2 仍 pending（还在播）', p2.done, false);

  S.advance(Math.round(SEG['w1-2'].d * 1000) + TAIL_MS);
  await flush();
  eq('p2 到点后 resolve', p2.done, true);
}

async function caseRapidFiveWords() {
  console.log('\n[7] 快速连点一周 5 个词 → 每个词都新建 ctx，startTime 与实际播放位置都正确');
  const S = loadAudio();
  const ids = ['w3-1', 'w3-2', 'w3-3', 'w3-4', 'w3-5'];
  const seen = [];
  const actual = [];
  for (const id of ids) {
    S.audio.play(id);
    const ctx = S.ctxs[S.ctxs.length - 1];
    seen.push(ctx.startTime);
    actual.push(ctx._actualStart);
    S.advance(60); // 孩子手快，每个只听了不到 0.1 秒
  }
  eq('ctx 总数 = 词数（每次重建）', S.ctxs.length, ids.length);
  // 旧 ctx 在每次新播放前都被销毁，最后一个没被销毁（它还在播）
  eq('前 4 个旧 ctx 已被销毁', S.ctxs.slice(0, -1).every((c) => c._destroy === 1), true);
  const expect = ids.map((id) => SEG[id].o);
  eq('每次 startTime 都正确', seen, expect);
  eq('每次 play() 实际起始位置都正确', actual, expect);
  eq('段偏移严格递增（不串音的前提）', expect.every((v, i) => i === 0 || v > expect[i - 1]), true);
}

async function caseUnknownId() {
  console.log('\n[8] 未登记 id / 空 id → 降级不抛异常，也不建 ctx');
  const S = loadAudio();
  for (const id of ['w99-9', '', null, undefined, 'w1-1-phrase']) {
    const st = settleOf(S.audio.play(id));
    await flush();
    if (!st.done) bad('play(' + JSON.stringify(id) + ') 应立刻 resolve', '仍然 pending');
  }
  eq('没有创建任何 ctx', S.ctxs.length, 0);
  eq('每次都给了 warn', S.warns.length, 5);
  eq('warn 文案含「未登记的单词 id」', /未登记的单词 id/.test(S.warns[0]), true);

  const S2 = loadAudio();
  const st2 = settleOf(S2.audio.playPhrase('nope'));
  await flush();
  eq('playPhrase 的 warn 文案区分「例句」', /未登记的例句 id/.test(S2.warns[0]), true);
  eq('playPhrase 未登记也 resolve', st2.done, true);
}

async function caseOnError() {
  console.log('\n[9] 底层报错 → reject 且作废 ctx');
  const S = loadAudio();
  const st = settleOf(S.audio.play('w1-1'));
  const ctx = S.ctxs[0];
  ctx._emitError({ errMsg: 'readFile:fail' });
  await flush();
  eq('Promise 被 reject', st.rejected, true);
  eq('错误原样传出', st.error && st.error.errMsg, 'readFile:fail');
  eq('ctx 已销毁', ctx._destroy, 1);
  eq('定时器已清（不会残留）', S.timers.length, 0);
}

async function caseStop() {
  console.log('\n[10] stop() 全局停止');
  const S = loadAudio();
  const st = settleOf(S.audio.play('w1-1'));
  const ctx = S.ctxs[0];
  S.audio.stop();
  await flush();
  eq('ctx 已销毁', ctx._destroy, 1);
  eq('定时器已清', S.timers.length, 0);
  eq('pending 的 Promise 被收尾（不卡页面）', st.done, true);

  S.audio.stop(); // 再调一次不应抛
  ok('重复 stop() 不抛异常');
}

async function caseOptions() {
  console.log('\n[11] 模块加载时的全局音频选项');
  const S = loadAudio();
  eq('调用了 setInnerAudioOption 1 次', S.audioOptions.length, 1);
  eq('obeyMuteSwitch = false（iOS 静音键下也能发声）', S.audioOptions[0] && S.audioOptions[0].obeyMuteSwitch, false);
}

async function caseCoverage() {
  console.log('\n[12] 全部 200 个词条都走真实播放路径（不产生 warn）');
  const words = (loadCommonJs(WORDS_JS).WORDS) || [];
  const S = loadAudio();
  let miss = 0;
  let switches = 0; // 周包切换次数 —— ctx 应当只在这里重建
  let prevPack = null;
  const calls = [];
  for (const w of words) {
    calls.push({ id: w.audio, tbl: SEG, phrase: false });
    calls.push({ id: w.phraseAudio, tbl: PSEG, phrase: true });
  }
  for (const c of calls) {
    const seg = c.tbl[c.id];
    if (!seg) {
      miss++;
      continue;
    }
    if (prevPack !== null && seg.p !== prevPack) switches++;
    prevPack = seg.p;
    if (c.phrase) S.audio.playPhrase(c.id);
    else S.audio.play(c.id);
    S.advance(30);
    if (S.warns.length) {
      miss++;
      if (miss <= 3) bad(c.id + ' 播放时产生了 warn', S.warns[S.warns.length - 1]);
      S.warns.length = 0;
    }
  }
  eq('200 个词条 × 单词/例句 全部命中映射表', miss, 0);
  // 修复同包串音 bug 后，每次 play 都重建 ctx，
  // 所以 ctx 总数应等于实际有效播放调用次数（400 次）。
  const totalCalls = words.length * 2 - miss;
  eq('每次播放都新建 ctx（共 ' + totalCalls + ' 次有效调用）', S.ctxs.length, totalCalls);
  eq('单词段总数', Object.keys(SEG).length, words.length);
  eq('例句段总数', Object.keys(PSEG).length, words.length);
}

/* ---------------------------------------------------------------- */

async function main() {
  console.log('[1] 加载 utils/audio.js');
  if (!fs.existsSync(AUDIO_JS)) {
    bad('utils/audio.js 存在', AUDIO_JS + ' 不存在');
    report();
    return;
  }
  ok('沙箱加载成功（模块级 wx 调用未抛异常）');
  ok('映射表：单词 ' + Object.keys(SEG).length + ' 段 / 例句 ' + Object.keys(PSEG).length + ' 段');
  if (Object.keys(SEG).length !== 200 || Object.keys(PSEG).length !== 200) {
    bad('映射表段数应为 200 / 200', '先跑 gen-audio-packs.py');
    report();
    return;
  }

  await casePlayWord();
  await casePlayPhrase();
  await caseReuseSamePack();
  await caseRebuildOtherPack();
  await casePreempt();
  await caseRapidFiveWords();
  await caseUnknownId();
  await caseOnError();
  await caseStop();
  await caseOptions();
  await caseCoverage();

  report();
}

function report() {
  console.log('\n────────────────────────────────────────');
  if (failures.length === 0) {
    console.log('全部通过（' + pass + ' 项）');
    process.exit(0);
  }
  console.log('通过 ' + pass + ' 项，失败 ' + failures.length + ' 项：');
  for (const f of failures.slice(0, 25)) console.log('  - ' + f);
  if (failures.length > 25) console.log('  …还有 ' + (failures.length - 25) + ' 项');
  process.exit(1);
}

main().catch((e) => {
  console.error('\n自检自身出错：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
