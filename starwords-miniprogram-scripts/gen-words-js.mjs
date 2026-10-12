// 由 words.json + sprite-map.json 生成小程序词库模块
import { readFileSync, writeFileSync } from 'fs';

const words = JSON.parse(readFileSync(new URL('./words.json', import.meta.url), 'utf8'));
const sprite = JSON.parse(readFileSync(new URL('./sprite-map.json', import.meta.url), 'utf8'));
const { cols, rows, map } = sprite;
if (sprite.missing.length) throw new Error('精灵图缺图：' + sprite.missing.join(', '));

const fmt = (n) => {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
};

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
    // 页面相对路径（页面都在 pages/<page>/ 下，../.. 回到包根），微信真机/开发者工具均可正确解析
    audio: '../../assets/audio/' + w.id + '.mp3',
    // 例句发音（低码率压缩后放在主包内，见 starwords-miniprogram-scripts/compress-phrase-audio.py）
    phraseAudio: w.phrase ? '../../assets/phrases/' + w.id + '.mp3' : '',
    // 全部单词图合并成一张精灵图（sprite.jpg）。原因：预览用的内置编译器
    // 有 MAX_SOURCE_FILES = 500 的硬上限，200 张独立图片会让工程超限、预览打不开。
    // 注意：图片路径不写进数据，而是在 WXML 里写成字面量 ../../assets/sprite.jpg ——
    // 预览编译器只复制「字面量 src」引用的资源，用 {{}} 绑定的路径不会被复制，
    // 预览里就会 404。下面两个偏移是该词对应格子在精灵图中的位移（百分比，
    // 配合 app.wxss 里 .sprite-img 的 1600%/1300% 缩放使用）。
    imgTx: fmt(-(col / cols) * 100),
    imgTy: fmt(-(row / rows) * 100),
  };
});

const maxWeek = Math.max(...words.map((w) => w.week));
const banner =
  '// 词库：由 Web 版 wordData.ts 提取生成（starwords-miniprogram-scripts/gen-words-js.mjs）\n' +
  `// ${words.length} 词 / ${maxWeek} 周。单词发音为预生成音频；单词图为 assets/sprite.jpg（${cols}x${rows} 精灵图）。\n`;

const out =
  banner +
  'const WORDS = ' + JSON.stringify(data) + ';\n\n' +
  'const WORDS_PER_WEEK = 5;\n' +
  'const MAX_WEEK = ' + maxWeek + ';\n\n' +
  '// 精灵图布局（必须与 assets/sprite.jpg 实际尺寸、app.wxss 里 .sprite-img 的 1600%/1300% 保持一致）\n' +
  'const SPRITE = { cols: ' + cols + ', rows: ' + rows + ', cell: ' + sprite.cell + ', src: "../../assets/sprite.jpg" };\n\n' +
  'function getWeekWords(week) {\n' +
  '  return WORDS.filter((w) => w.week === week).slice(0, WORDS_PER_WEEK);\n' +
  '}\n\n' +
  'function getWordById(id) {\n' +
  '  return WORDS.find((w) => w.id === id) || null;\n' +
  '}\n\n' +
  'module.exports = { WORDS, WORDS_PER_WEEK, MAX_WEEK, SPRITE, getWeekWords, getWordById };\n';

writeFileSync(new URL('../starwords-miniprogram/utils/words.js', import.meta.url), out);
console.log('written', data.length, 'words, sprite', cols + 'x' + rows);
