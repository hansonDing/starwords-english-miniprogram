// 跟读录音的轻量自动评分（纯本地，无需网络）
// 思路：解析录音 WAV（16bit PCM），统计
//   1) 时长 duration —— 太短说明没读完，太长说明夹了别的话
//   2) 整体响度 rms —— 太轻说明没发声
//   3) 有声占比 voicedRatio —— 有 20ms 窗口响度超过阈值的比例
// 三者合成 0~100 的分数。这是"开口程度/节奏"评分，
// 不是 AI 发音评测（那需要接入第三方语音评测服务）。
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// 解析 WAV，返回 { sampleRate, samples } 或 null
function parseWav(u8) {
  if (!u8 || u8.length < 44) return null;
  var tag = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (tag !== 'RIFF') return null;
  var pos = 12;
  var dataOff = -1;
  var dataLen = 0;
  var sampleRate = 16000;
  var bits = 16;
  while (pos + 8 <= u8.length) {
    var id = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
    var size =
      (u8[pos + 4] | (u8[pos + 5] << 8) | (u8[pos + 6] << 16) | (u8[pos + 7] << 24)) >>> 0;
    if (id === 'fmt ') {
      sampleRate =
        (u8[pos + 12] | (u8[pos + 13] << 8) | (u8[pos + 14] << 16) | (u8[pos + 15] << 24)) >>> 0;
      bits = u8[pos + 22] | (u8[pos + 23] << 8);
    } else if (id === 'data') {
      dataOff = pos + 8;
      dataLen = Math.min(size, u8.length - dataOff);
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (dataOff < 0 || bits !== 16 || sampleRate <= 0 || dataLen < 2) return null;
  return { sampleRate: sampleRate, dataOff: dataOff, dataLen: dataLen };
}

// 分析 PCM：返回 { duration, rms, voicedRatio }
function analyzePcm(u8, wav) {
  var total = Math.floor(wav.dataLen / 2);
  if (total < wav.sampleRate * 0.1) return null; // 少于 0.1s 直接放弃
  var win = Math.max(1, Math.round(wav.sampleRate * 0.02)); // 20ms 窗
  var sumSq = 0;
  var winSq = 0;
  var winN = 0;
  var voiced = 0;
  var VOICED_TH = 0.02;
  for (var i = 0; i < total; i++) {
    var o = wav.dataOff + i * 2;
    var v = u8[o] | (u8[o + 1] << 8);
    if (v >= 32768) v -= 65536;
    var s = (v / 32768) * (v / 32768);
    sumSq += s;
    winSq += s;
    winN++;
    if (winN >= win) {
      if (Math.sqrt(winSq / winN) > VOICED_TH) voiced++;
      winSq = 0;
      winN = 0;
    }
  }
  if (winN > 0 && Math.sqrt(winSq / winN) > VOICED_TH) voiced++;
  var windows = Math.ceil(total / win);
  return {
    duration: total / wav.sampleRate,
    rms: Math.sqrt(sumSq / total),
    voicedRatio: windows > 0 ? voiced / windows : 0,
  };
}

// 打分。返回 { score, level, stars, message } 或 null（解析失败）
function grade(u8) {
  var wav = parseWav(u8);
  if (!wav) return null;
  var m = analyzePcm(u8, wav);
  if (!m) return null;

  if (m.rms < 0.008 || m.voicedRatio < 0.04) {
    return { score: 30, level: 'low', stars: '⭐', message: '没听到声音，声音再大一点试试吧' };
  }
  if (m.duration < 0.35) {
    return { score: 45, level: 'low', stars: '⭐', message: '读得有点短，再大声读一遍吧' };
  }
  if (m.duration > 3.2) {
    return { score: 55, level: 'mid', stars: '⭐⭐', message: '有点长哦，只要读这个单词就可以啦' };
  }

  var durScore = 90 - Math.abs(m.duration - 1.1) * 25; // 1.1s 附近最佳
  var clarity = 0.7 + 0.3 * Math.min(1, m.voicedRatio / 0.6);
  var score = clamp(Math.round(durScore * clarity), 45, 96);

  if (score >= 80) {
    return { score: score, level: 'great', stars: '⭐⭐⭐', message: '读得很棒！继续加油 🎉' };
  }
  if (score >= 60) {
    return { score: score, level: 'good', stars: '⭐⭐', message: '读得不错，再试一次会更好' };
  }
  return { score: score, level: 'low', stars: '⭐', message: '再大声、清楚地读一遍试试' };
}

// 读文件后评分；失败返回 null
function gradeFile(filePath) {
  return new Promise((resolve) => {
    try {
      var fsm = wx.getFileSystemManager();
      fsm.readFile({
        filePath: filePath,
        success: (r) => resolve(grade(new Uint8Array(r.data))),
        fail: () => resolve(null),
      });
    } catch (e) {
      resolve(null);
    }
  });
}

module.exports = { gradeFile: gradeFile };
