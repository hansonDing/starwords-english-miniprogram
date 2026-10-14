// 跟读录音的轻量自动评分（纯本地，无需网络）
// 思路：解析录音 WAV（16bit PCM），统计
//   1) 时长 duration —— 太短说明没读完，太长说明夹了别的话
//   2) 整体响度 rms —— 太轻说明没发声
//   3) 有声占比 voicedRatio —— 有 20ms 窗口响度超过阈值的比例
// 三者合成 0~100 的分数。这是"开口程度/节奏"评分，
// 不是 AI 发音评测（那需要接入第三方语音评测服务）。
//
// 星级换算（2026-10-15 起，界面只显示星星，不显示分数）：
//   3 星（>60 分）：完整、清楚地把单词读出来了 —— 正常读完的都落在这档
//   2 星（>40 分）：开口读了，但有明显问题（读得太长 / 节奏或音量差一截）
//   1 星（>30 分）：读了，但没读完（时长太短）
//   0 星（≤30 分）：完全没听到声音
// 注：正常评分路径的分数被 clamp 在 45~96，所以「真开口读了」至少 2 星；
//     1 星只给"读太短没读完"，0 星只给"压根没出声"。四档语义：
//     没出声 / 没读完 / 读了但不够好 / 读对了。
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

// 分数 → 星级（0~3）。>60 → 3 星；>40 → 2 星；>30 → 1 星；其余 0 星。
// 30 分是"完全没听到声音"的专属分数，所以 <=30 就是 0 星。
function starsFor(score) {
  if (score > 60) return 3;
  if (score > 40) return 2;
  if (score > 30) return 1;
  return 0;
}

// 打分。返回 { score, level, starCount, message } 或 null（解析失败）
// level：great（3 星）/ good（2 星）/ low（1 星）/ none（0 星），用于界面配色
function grade(u8) {
  var wav = parseWav(u8);
  if (!wav) return null;
  var m = analyzePcm(u8, wav);
  if (!m) return null;

  // 完全没听到声音 = 0 星（唯一进 0 星的入口；分数 30 也是 starsFor 的 0 星分界）
  if (m.rms < 0.008 || m.voicedRatio < 0.04) {
    return {
      score: 30,
      level: 'none',
      starCount: 0,
      message: '没有听到声音，按住麦克风大声读出来吧',
    };
  }
  if (m.duration < 0.35) {
    // 35 分：读太短 = 没读完，跟"没声音"分开 —— 出声了就该有 1 星
    return { score: 35, level: 'low', starCount: 1, message: '读得有点短，再完整读一遍吧' };
  }
  if (m.duration > 3.2) {
    return { score: 55, level: 'good', starCount: 2, message: '有点长哦，只要读这个单词就可以啦' };
  }

  var durScore = 90 - Math.abs(m.duration - 1.1) * 25; // 1.1s 附近最佳
  var clarity = 0.7 + 0.3 * Math.min(1, m.voicedRatio / 0.6);
  var score = clamp(Math.round(durScore * clarity), 45, 96);
  var starCount = starsFor(score);

  if (starCount === 3) {
    return { score: score, level: 'great', starCount: 3, message: '读得真棒！继续加油 🎉' };
  }
  if (starCount === 2) {
    return { score: score, level: 'good', starCount: 2, message: '读出来啦！再试一次会更棒' };
  }
  // 防御分支：当前 clamp 下限 45 保证走不到这里，留作下限调整时的兜底
  return { score: score, level: 'low', starCount: 1, message: '再大声、清楚地读一遍试试' };
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
