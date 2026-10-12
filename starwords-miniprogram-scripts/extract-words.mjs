// 从 Web 版 wordData.ts 提取词条为纯 JSON
import { readFileSync, writeFileSync } from 'fs';

const src = readFileSync(new URL('../src/data/wordData.ts', import.meta.url), 'utf8');
const start = src.indexOf('const WORD_ENTRIES: WordEntry[] = [');
const end = src.indexOf('];', start);
const arrText = src.slice(src.indexOf('[', src.indexOf('=', start)), end + 1);
const entries = JSON.parse(arrText);

const PHRASE_AUDIO_IDS = new Set(); // mp3 为例句朗读，与词条错位问题保留判断
const m = src.match(/const PHRASE_AUDIO_IDS[^=]*= new Set\(\[([\s\S]*?)\]\)/);
if (m) {
  for (const id of m[1].matchAll(/'([^']+)'/g)) PHRASE_AUDIO_IDS.add(id[1]);
}

const words = entries.map((e) => ({
  id: e.id,
  word: e.word,
  phonetic: e.phonetic,
  meaning: e.meaning,
  phrase: e.phrase,
  phraseMeaning: e.phraseMeaning,
  difficulty: e.difficulty,
  week: e.week,
  imageName: e.imageName,
  hasPhraseAudio: PHRASE_AUDIO_IDS.has(e.id),
}));

writeFileSync(new URL('./words.json', import.meta.url), JSON.stringify(words, null, 1));
console.log('words:', words.length, 'weeks:', Math.max(...words.map((w) => w.week)), 'phraseAudio:', words.filter(w=>w.hasPhraseAudio).length);
