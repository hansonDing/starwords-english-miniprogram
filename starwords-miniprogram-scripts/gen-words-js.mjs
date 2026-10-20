// 由 words.json + sprite-map.json 生成小程序词库模块
import { readFileSync, writeFileSync } from 'fs';

const words = JSON.parse(readFileSync(new URL('./words.json', import.meta.url), 'utf8'));
const sprite = JSON.parse(readFileSync(new URL('./sprite-map.json', import.meta.url), 'utf8'));
const { cols, rows, map } = sprite;
if (sprite.missing.length) throw new Error('精灵图缺图：' + sprite.missing.join(', '));

// 年级划分表（设计容量，见 grade-plan.json）。它**可以超前于当前内容** ——
// 表里声明到单元 320（1600 词），而现在只有 40 个单元。这样做的好处：
// 灌内容时不用改表、不用改代码；年级卡片能把「还没开放的年级」也展示出来。
const gradePlan = JSON.parse(readFileSync(new URL('./grade-plan.json', import.meta.url), 'utf8'));
const grades = gradePlan.grades;

// 生成器自己先校验一遍划分表。自检（grade-check.cjs）是第二道网，
// 但生成器是唯一写 words.js 的地方 —— 坏表在源头就该拦下，别等写出产物才发现。
if (!Array.isArray(grades) || grades.length === 0) throw new Error('grade-plan.json 的 grades 为空');
if (grades[0].firstUnit !== 1) throw new Error('年级划分必须从单元 1 开始');
{
  const seen = Object.create(null);
  for (let i = 0; i < grades.length; i++) {
    const g = grades[i];
    if (!g.id || !g.name) throw new Error(`第 ${i} 个年级缺 id / name`);
    if (seen[g.id]) throw new Error(`年级 id 重复：${g.id}`);
    seen[g.id] = true;
    if (!(g.lastUnit >= g.firstUnit)) throw new Error(`${g.id} 的 lastUnit < firstUnit`);
    if (i > 0 && g.firstUnit !== grades[i - 1].lastUnit + 1) {
      throw new Error(
        `${g.id} 与 ${grades[i - 1].id} 之间有缺口 / 重叠：${grades[i - 1].lastUnit} → ${g.firstUnit}`
      );
    }
  }
}

const data = words.map((w) => {
  const cell = map[w.imageName];
  if (!cell) throw new Error(`${w.id} 在精灵图中没有对应格子`);
  const [col, row] = cell;
  return {
    id: w.id,
    word: w.word,
    phonetic: w.phonetic,
    meaning: w.meaning,
    phrase: w.phrase,
    phraseMeaning: w.phraseMeaning,
    difficulty: w.difficulty,
    week: w.week,
    // 精灵图格子序号。**不存 imgTx/imgTy** —— 两个浮点数每个词要花 20 多字节，
    // 200 词就是 4KB，而它们完全由格子序号算得出来（见下面输出里的展开循环）。
    c: row * cols + col,
  };
});

const maxWeek = Math.max(...words.map((w) => w.week));
const lastUnit = grades[grades.length - 1].lastUnit;
const banner =
  '// 词库：由 Web 版 wordData.ts 提取生成（starwords-miniprogram-scripts/gen-words-js.mjs）\n' +
  `// ${words.length} 词 / ${maxWeek} 单元。单词发音为预生成音频；单词图为 assets/sprite.jpg（${cols}x${rows} 精灵图）。\n`;

const out =
  banner +
  'const WORDS = ' + JSON.stringify(data) + ';\n\n' +
  '// 以下三个字段都不进数据，运行时展开 —— 它们全部由 id / 格子序号决定：\n' +
  '//   audio / phraseAudio：音频段就是按词条 id 索引的（见 utils/audioPackMap.js），\n' +
  '//     每个词重复存一遍要花约 7KB。\n' +
  '//   imgTx / imgTy：精灵图位移（百分比，配合 app.wxss 里 .sprite-img 的\n' +
  '//     1600%/1300% 用），由格子序号算出，再省约 4KB。\n' +
  '// 改这里的公式必须同步 gen-sprite.py 与 app.wxss 的 1600%/1300%。\n' +
  'for (let i = 0; i < WORDS.length; i++) {\n' +
  '  const w = WORDS[i];\n' +
  '  w.audio = w.id;\n' +
  '  w.phraseAudio = w.phrase ? w.id : "";\n' +
  '  w.imgTx = -((w.c % ' + cols + ') / ' + cols + ') * 100;\n' +
  '  w.imgTy = -(Math.floor(w.c / ' + cols + ') / ' + rows + ') * 100;\n' +
  '}\n\n' +
  'const WORDS_PER_WEEK = 5;\n' +
  'const MAX_WEEK = ' + maxWeek + ';\n' +
  '// 划分表末单元（设计容量）；MAX_WEEK 才是已有内容的末单元。\n' +
  'const LAST_UNIT = ' + lastUnit + ';\n\n' +
  '// 精灵图布局（必须与 assets/sprite.jpg 实际尺寸、app.wxss 里 .sprite-img 的 1600%/1300% 保持一致）\n' +
  'const SPRITE = { cols: ' + cols + ', rows: ' + rows + ', cell: ' + sprite.cell + ', src: "../../assets/sprite.jpg" };\n\n' +
  '// 年级划分表，生成自 grade-plan.json。⚠️ 不给词条加 grade 字段：\n' +
  '// grade 由 week 查表决定，1600 词时那个字段会白占约 22KB 主包。\n' +
  'const GRADES = ' + JSON.stringify(grades) + ';\n\n' +
  'function getWeekWords(week) {\n' +
  '  return WORDS.filter((w) => w.week === week).slice(0, WORDS_PER_WEEK);\n' +
  '}\n\n' +
  'function getWordById(id) {\n' +
  '  return WORDS.find((w) => w.id === id) || null;\n' +
  '}\n\n' +
  'function gradeById(gradeId) {\n' +
  '  for (let i = 0; i < GRADES.length; i++) {\n' +
  '    if (GRADES[i].id === gradeId) return GRADES[i];\n' +
  '  }\n' +
  '  return null;\n' +
  '}\n\n' +
  '// 越界（超出设计容量）兜底到最后一个年级，永不返回空\n' +
  'function gradeOfWeek(week) {\n' +
  '  for (let i = 0; i < GRADES.length; i++) {\n' +
  '    if (week >= GRADES[i].firstUnit && week <= GRADES[i].lastUnit) return GRADES[i];\n' +
  '  }\n' +
  '  return GRADES[GRADES.length - 1];\n' +
  '}\n\n' +
  '// 未灌内容的年级返回空数组（页面据此显示「未开放」）\n' +
  'function getGradeWords(gradeId) {\n' +
  '  const g = gradeById(gradeId);\n' +
  '  if (!g) return [];\n' +
  '  return WORDS.filter((w) => w.week >= g.firstUnit && w.week <= g.lastUnit);\n' +
  '}\n\n' +
  'module.exports = { WORDS, WORDS_PER_WEEK, MAX_WEEK, LAST_UNIT, SPRITE, GRADES,' +
  ' getWeekWords, getWordById, gradeById, gradeOfWeek, getGradeWords };\n';

writeFileSync(new URL('../starwords-miniprogram/utils/words.js', import.meta.url), out);
console.log('written', data.length, 'words, sprite', cols + 'x' + rows + ', grades', grades.length);
