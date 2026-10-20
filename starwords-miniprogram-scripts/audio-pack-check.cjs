#!/usr/bin/env node
/**
 * 音频包静态自检。
 *
 * 背景：包体同时逼近「预览 500 文件上限」和「体积上限」，而 400 个 mp3 占了文件数的 84%。
 * 解法是把每周的 5 个音频按原始 MP3 帧直接拼成一个「周包」（CBR + 帧对齐 → 零重编码、
 * 音质不变），播放时用 InnerAudioContext.startTime 定位到段。
 *
 * 这个脚本把「拼接正确」这件事固化下来 —— 拼接一旦错位，真机上表现是「播错词」或
 * 「没声音」，而且**预览环境没有音频，本机根本发现不了**，所以静态校验必须足够严。
 *
 * 用法：node audio-pack-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const HERE = __dirname;
const PKG = path.join(HERE, '..', 'starwords-miniprogram');
const MAP_JS = path.join(PKG, 'utils', 'audioPackMap.js');
const WORDS_JS = path.join(PKG, 'utils', 'words.js');
const WORDS_DIR = path.join(PKG, 'assets', 'audio');
const PHRASES_DIR = path.join(PKG, 'assets', 'phrases');

const SEGMENTS_PER_PACK = 5;
const FRAME_TOLERANCE = 1; // 允许 1 帧（36ms）误差

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

/* ---------------------------------------------------------------- */
/* MP3 帧解析                                                        */
/* ---------------------------------------------------------------- */

// 本工程只用 Layer III。表索引 3 = MPEG-1，2 = MPEG-2 / 2.5
const BITRATE = {
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000] };
const SAMPLES_PER_FRAME = { 3: 1152, 2: 576 };

/**
 * 逐帧走一遍，返回帧列表。任何一处同步字不对就判失败 ——
 * 「拼接错位」在这种校验下无处遁形。
 */
function walkFrames(buf) {
  const frames = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) return { ok: false, reason: '尾部残留 ' + (buf.length - i) + ' 字节', frames };
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) {
      return { ok: false, reason: '偏移 ' + i + ' 处不是帧同步字', frames };
    }
    const verBits = (buf[i + 1] >> 3) & 3;
    const layerBits = (buf[i + 1] >> 1) & 3;
    if (verBits === 1) return { ok: false, reason: '偏移 ' + i + ' 处保留的 MPEG 版本位', frames };
    if (layerBits !== 1) return { ok: false, reason: '偏移 ' + i + ' 处不是 Layer III', frames };
    const t = verBits === 3 ? 3 : 2;
    const brIdx = (buf[i + 2] >> 4) & 0xf;
    const srIdx = (buf[i + 2] >> 2) & 3;
    const pad = (buf[i + 2] >> 1) & 1;
    const br = BITRATE[t][brIdx];
    const sr = SAMPLE_RATE[t][srIdx];
    if (!br || !sr) return { ok: false, reason: '偏移 ' + i + ' 处码率/采样率非法', frames };
    const size = Math.floor(((SAMPLES_PER_FRAME[t] / 8) * br * 1000) / sr) + pad;
    if (i + size > buf.length) return { ok: false, reason: '偏移 ' + i + ' 处帧越界', frames };
    frames.push({ at: i, size, bitrate: br, sampleRate: sr, dur: SAMPLES_PER_FRAME[t] / sr });
    i += size;
  }
  return { ok: true, frames };
}

function loadCommonJs(file) {
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8'), file);
  return m.exports;
}

/* ---------------------------------------------------------------- */

function main() {
  console.log('[1] 映射表 utils/audioPackMap.js');
  if (!fs.existsSync(MAP_JS)) {
    bad('映射表存在', MAP_JS + ' 还不存在 —— 先跑 gen-audio-packs.py');
    report();
    return;
  }
  const mapMod = loadCommonJs(MAP_JS);
  const SEG = mapMod.SEG || {};
  const PSEG = mapMod.PSEG || {};
  const DUR = mapMod.DUR || {};
  const segIds = Object.keys(SEG);
  const psegIds = Object.keys(PSEG);
  const packNames = Object.keys(DUR);
  ok('映射表可加载：单词 ' + segIds.length + ' 段 / 例句 ' + psegIds.length + ' 段 / ' + packNames.length + ' 包');

  console.log('\n[2] words.js 是否已切换为词条 id');
  const wordsMod = loadCommonJs(WORDS_JS);
  const words = (wordsMod && wordsMod.WORDS) || [];
  if (words.length === 200) ok('words.js 共 200 条');
  else bad('words.js 词条数应为 200', '实际 ' + words.length);

  let pathLeft = 0;
  for (const w of words) {
    if (typeof w.audio === 'string' && w.audio.indexOf('/') !== -1) {
      pathLeft++;
      if (pathLeft <= 5) bad(w.id + ' audio 仍是路径', w.audio);
    }
    if (typeof w.phraseAudio === 'string' && w.phraseAudio.indexOf('/') !== -1) {
      pathLeft++;
      if (pathLeft <= 5) bad(w.id + ' phraseAudio 仍是路径', w.phraseAudio);
    }
  }
  if (pathLeft === 0) ok('audio / phraseAudio 均已是词条 id');

  console.log('\n[3] 段与词条一一对应');
  const wordIds = new Set(words.map((w) => w.id));
  // ⚠️ 单词段查 SEG、例句段查 PSEG —— 两者键都是词条 id，查错表会「假绿」
  const missing = words.filter((w) => !SEG[w.audio]).map((w) => w.id);
  const missingPhrase = words.filter((w) => !PSEG[w.phraseAudio]).map((w) => w.id);
  const extra = segIds.filter((id) => !wordIds.has(id)).concat(psegIds.filter((id) => !wordIds.has(id)));
  if (missing.length === 0) ok('200 个单词 id 全部在映射表里');
  else bad('映射表缺少单词段', missing.slice(0, 8).join(', ') + (missing.length > 8 ? ' …' : ''));
  if (missingPhrase.length === 0) ok('200 个例句段全部在映射表里');
  else bad('映射表缺少例句段', missingPhrase.slice(0, 8).join(', '));
  if (extra.length === 0) ok('映射表没有多余段');
  else bad('映射表有多余段', extra.slice(0, 8).join(', '));

  console.log('\n[4] 段偏移合法且包内严格递增');
  const byPack = {};
  let offsetBad = 0;
  let overrun = 0;
  const TABLES = [
    ['单词', SEG],
    ['例句', PSEG],
  ];
  for (const [kind, table] of TABLES) {
    for (const id of Object.keys(table)) {
      const s = table[id];
      if (typeof s.o !== 'number' || typeof s.d !== 'number' || s.o < 0 || s.d <= 0.2) {
        offsetBad++;
        if (offsetBad <= 5) bad(kind + '段 ' + id + ' 参数非法', JSON.stringify(s));
        continue;
      }
      if (DUR[s.p] === undefined) {
        bad(kind + '段 ' + id + ' 指向未知包', s.p);
        continue;
      }
      if (s.o + s.d > DUR[s.p] + 1e-6) {
        overrun++;
        if (overrun <= 5) bad(kind + '段 ' + id + ' 越出包尾', 'o+d=' + (s.o + s.d).toFixed(3) + ' > DUR=' + DUR[s.p]);
      }
      (byPack[s.p] = byPack[s.p] || []).push({ id, o: s.o });
    }
  }
  if (offsetBad === 0) ok('所有段参数合法（' + (segIds.length + psegIds.length) + ' 段）');
  if (overrun === 0) ok('所有段都在包时长之内');

  let orderBad = 0;
  let countBad = 0;
  let overlapBad = 0;
  for (const p of packNames) {
    const list = (byPack[p] || []).slice().sort((a, b) => a.o - b.o);
    if (list.length !== SEGMENTS_PER_PACK) {
      countBad++;
      if (countBad <= 5) bad('包 ' + p + ' 段数应为 ' + SEGMENTS_PER_PACK, '实际 ' + list.length);
    }
    for (let i = 1; i < list.length; i++) {
      if (!(list[i].o > list[i - 1].o)) {
        orderBad++;
        if (orderBad <= 5) bad('包 ' + p + ' 段偏移未严格递增', list[i - 1].id + ' / ' + list[i].id);
      }
    }
  }
  if (orderBad === 0) ok('每个包内段偏移严格递增');
  if (countBad === 0) ok('每个包恰好 ' + SEGMENTS_PER_PACK + ' 段');

  // 偏移递增不等于不重叠：某段 d 过大仍会盖住下一段的开头
  for (const [kind, table] of TABLES) {
    for (const id of Object.keys(table)) {
      const s = table[id];
      if (!s.p || typeof s.o !== 'number' || typeof s.d !== 'number') continue;
      const end = s.o + s.d;
      for (const oid of Object.keys(table)) {
        if (oid === id) continue;
        const t = table[oid];
        if (t.p !== s.p) continue;
        if (t.o > s.o && t.o < end - 1e-6) {
          overlapBad++;
          if (overlapBad <= 5) bad(kind + '段重叠', id + '[o=' + s.o + ',d=' + s.d + '] 盖住 ' + oid + '[o=' + t.o + ']');
        }
      }
    }
  }
  if (overlapBad === 0) ok('同包内任意两段互不重叠');

  console.log('\n[5] 包文件存在、无残留单文件');
  const expect = (dir, prefix) => {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')) : [];
    const packs = files.filter((f) => f.startsWith(prefix));
    const left = files.filter((f) => !f.startsWith(prefix));
    return { packs: packs.sort(), left };
  };
  const w = expect(WORDS_DIR, 'wp');
  const p = expect(PHRASES_DIR, 'pp');
  if (w.packs.length === 40) ok('单词包 40 个');
  else bad('单词包应为 40 个', '实际 ' + w.packs.length);
  if (p.packs.length === 40) ok('例句包 40 个');
  else bad('例句包应为 40 个', '实际 ' + p.packs.length);
  if (w.left.length === 0) ok('assets/audio 下无残留单文件');
  else bad('assets/audio 下还有 ' + w.left.length + ' 个残留单文件', w.left.slice(0, 5).join(', '));
  if (p.left.length === 0) ok('assets/phrases 下无残留单文件');
  else bad('assets/phrases 下还有 ' + p.left.length + ' 个残留单文件', p.left.slice(0, 5).join(', '));

  console.log('\n[6] 包文件帧对齐、时长与映射表一致');
  let frameBad = 0;
  let durMismatch = 0;
  for (const dir of [WORDS_DIR, PHRASES_DIR]) {
    const names = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')).sort()
      : [];
    for (const name of names) {
      const buf = fs.readFileSync(path.join(dir, name));
      const res = walkFrames(buf);
      if (!res.ok) {
        frameBad++;
        if (frameBad <= 5) bad(name + ' 帧结构异常', res.reason);
        continue;
      }
      const pack = name.replace(/\.mp3$/, '');
      const real = res.frames.reduce((a, f) => a + f.dur, 0);
      const declared = DUR[pack];
      if (declared === undefined) {
        bad(name + ' 不在映射表 DUR 里', '');
        continue;
      }
      const frame = res.frames[0] ? res.frames[0].dur : 0.036;
      if (Math.abs(real - declared) > frame * FRAME_TOLERANCE) {
        durMismatch++;
        if (durMismatch <= 5) {
          bad(name + ' 时长与 DUR 不符', '实际 ' + real.toFixed(3) + 's / 声明 ' + declared + 's');
        }
      }
    }
  }
  if (frameBad === 0) ok('所有包都是完整帧序列');
  if (durMismatch === 0) ok('所有包时长与映射表一致（±1 帧）');

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

main();
