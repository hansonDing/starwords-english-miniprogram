// 配对闯关的出题逻辑（learn 页第 4 步：学完当天 5 词后做整组配对）
//
// 纯逻辑、不依赖 wx —— 便于本地自检（starwords-miniprogram-scripts/match-check.cjs）。
//
// 规则：
//   左列 = 5 个单词，保持词库原顺序
//   右列 = 5 个中文含义，打乱
//   ⚠️ 硬约束：右列顺序不能恰好等于左列（否则孩子从上往下照着点就全对）。
//      这个退化情况概率 1/120，只靠人眼抽查发现不了，由 match-check.cjs 锁住。

// Fisher-Yates 洗牌。rng 可注入（默认 Math.random），便于测试复现最坏情况。
function shuffle(arr, rng) {
  var rand = typeof rng === 'function' ? rng : Math.random;
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// 右列顺序是否与左列完全一致（逐位 id 相同）
function sameOrder(left, right) {
  if (left.length !== right.length) return false;
  for (var i = 0; i < left.length; i++) {
    if (left[i].id !== right[i].id) return false;
  }
  return true;
}

// 生成题目。返回 { left: [{id, text}], right: [{id, text}] }
function buildPuzzle(words, rng) {
  var list = words || [];
  var left = list.map(function (w) {
    return { id: w.id, text: w.word };
  });
  var right = list.map(function (w) {
    return { id: w.id, text: w.meaning };
  });
  if (right.length < 2) return { left: left, right: right };

  var rand = typeof rng === 'function' ? rng : Math.random;
  var guard = 0;
  do {
    right = shuffle(right, rand);
    guard++;
    // 最多重试 20 次（正常 1 次就够；恒定 rng 这类病态输入才会反复命中）
  } while (guard < 20 && sameOrder(left, right));

  // 兜底：即使重试到上限仍是原序（例如 rng 恒为 0.999… 导致恒不交换），
  // 手动把首项挪到末尾强制错开。
  if (sameOrder(left, right)) {
    right.push(right.shift());
  }
  return { left: left, right: right };
}

// 左右两项是否配对成功（id 相同；任一侧为空都算未配对）
function isMatch(leftId, rightId) {
  return !!leftId && leftId === rightId;
}

module.exports = { buildPuzzle: buildPuzzle, isMatch: isMatch };
