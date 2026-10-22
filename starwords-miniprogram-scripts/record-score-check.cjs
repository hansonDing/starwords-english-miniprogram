/**
 * 跟读评分 / 星级自检：合成 WAV 喂给 utils/record-score.js，验证分数与星级是否符合预期。
 *
 * 为什么需要：星级换算错档是**静默**的（小朋友拿到的星星不对，界面上看不出 bug），
 * 而阈值是"感觉出来的"数字，最容易在后续微调里被改坏。这里用合成波形固定住行为。
 *
 * 用法： node record-score-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', 'starwords-miniprogram');

// ⚠️ 工作区根有 "type":"module"，小程序目录里的 .js 必须按 CommonJS 显式加载。
// record-score.js 只导出 gradeFile（依赖 wx 文件系统），这里额外把内部 grade / starsFor 暴露出来做纯函数测试。
function loadScoreModule() {
  const file = path.join(ROOT, 'utils', 'record-score.js');
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(
    fs.readFileSync(file, 'utf8') + '\nmodule.exports.grade = grade;\nmodule.exports.starsFor = starsFor;\nmodule.exports.gradeBySoe = gradeBySoe;\n',
    file
  );
  return m.exports;
}

const rs = loadScoreModule();

const RATE = 16000;

// 合成一段 16bit / 16kHz / 单声道 WAV：seconds 秒、峰值振幅 amp（0~1）、可选静音
function makeWav(seconds, amp, silent) {
  const n = Math.max(1, Math.round(RATE * seconds));
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (!silent) {
      // 220Hz 正弦，模拟一个稳定的嗓音（有声窗口比例接近 1）
      v = Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * amp * 32767);
    }
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
}

let failed = 0;
function ok(msg) {
  console.log('  ✓ ' + msg);
}
function check(cond, msg) {
  if (cond) ok(msg);
  else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}

// [描述, 时长s, 振幅, 静音, 期望星级]
// 0 星 = 完全没听到声音（唯一的 0 星入口）；1 星 = 出声了但没读完
const cases = [
  ['完全没声音（0.8s 静音）', 0.8, 0, true, 0],
  ['声音太轻（0.8s 极低振幅）', 0.8, 0.004, false, 0],
  ['读得太短（0.2s）', 0.2, 0.5, false, 1],
  ['读得太长（3.5s 一直读）', 3.5, 0.5, false, 2],
  ['拖得很慢（2.4s）', 2.4, 0.5, false, 2],
  ['标准跟读（1.1s、声音饱满）', 1.1, 0.5, false, 3],
  ['略快（0.7s）', 0.7, 0.5, false, 3],
  ['略慢（1.7s）', 1.7, 0.5, false, 3],
];

console.log('[1] 分数 → 星级换算');
for (const [label, seconds, amp, silent, want] of cases) {
  const r = rs.grade(makeWav(seconds, amp, silent));
  if (!r) {
    check(false, `${label}：评分返回 null（不该发生）`);
    continue;
  }
  check(
    r.starCount === want,
    `${label} → ${r.score} 分 / ${r.starCount} 星（期望 ${want} 星）「${r.message}」`
  );
}

console.log('[2] 边界：>60 才给 3 星，>40 才给 2 星，>30 才给 1 星');
check(rs.starsFor(61) === 3 && rs.starsFor(60) === 2, '61 → 3 星；60 → 2 星（严格大于）');
check(rs.starsFor(41) === 2 && rs.starsFor(40) === 1, '41 → 2 星；40 → 1 星（严格大于）');
check(rs.starsFor(31) === 1 && rs.starsFor(30) === 0, '31 → 1 星；30 → 0 星（严格大于）');
check(rs.starsFor(0) === 0 && rs.starsFor(96) === 3, '0 → 0 星；96 → 3 星');

console.log('[3] 四档语义：没出声 0 星 / 没读完 1 星 / 真开口读了至少 2 星');
{
  const none = rs.grade(makeWav(0.8, 0, true));
  check(none.starCount === 0 && none.level === 'none', '静音录音 → 0 星、level=none（界面照常显示反馈）');
  const short = rs.grade(makeWav(0.2, 0.5, false));
  check(short.starCount === 1, '出声但太短 → 1 星（' + short.score + ' 分，不跟 0 星混档）');
  // 正常评分路径的分数下限被 clamp 在 45 → 任何"读到合理时长 + 有声音"的录音都不会掉到 1 星
  const low = rs.grade(makeWav(3.2, 0.5, false));
  check(low.starCount >= 2, '卡在评分路径下限的录音仍是 2 星（' + low.score + ' 分）');
}

console.log('[4] 智聆口语评测（SOE）评分映射');
{
  const soeCases = [
    ['准确度 95 → 3 星', { pron_accuracy: 95 }, 3],
    ['准确度 81 → 3 星', { pron_accuracy: 81 }, 3],
    ['准确度 80 → 2 星（临界）', { pron_accuracy: 80 }, 2],
    ['准确度 56 → 2 星', { pron_accuracy: 56 }, 2],
    ['准确度 55 → 1 星（临界）', { pron_accuracy: 55 }, 1],
    ['准确度 31 → 1 星', { pron_accuracy: 31 }, 1],
    ['准确度 30 → 1 星（开口鼓励）', { pron_accuracy: 30 }, 1],
    ['准确度 5 → 1 星（开口鼓励）', { pron_accuracy: 5 }, 1],
    ['无结果 → 1 星（开口鼓励）', {}, 1],
    ['result 子对象 + PronAccuracy 大小写兼容', { result: { PronAccuracy: 92 } }, 3],
    ['result 子对象 + pronAccuracy 驼峰兼容', { result: { pronAccuracy: 72 } }, 2],
  ];
  for (const [label, soeResult, want] of soeCases) {
    const r = rs.gradeBySoe('cat', soeResult);
    check(r.starCount === want, `${label} → ${r.score} 分 / ${r.starCount} 星（期望 ${want} 星）`);
    check(r.starCount >= 1, `${label}：SOE 路径最低 1 星鼓励`);
  }
}

console.log(failed ? `\n跟读星级自检失败：${failed} 项 ✗` : '\n跟读星级自检全部通过 ✓');
process.exit(failed ? 1 : 0);
