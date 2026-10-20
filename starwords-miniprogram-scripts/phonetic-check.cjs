#!/usr/bin/env node
/**
 * 音标自检。
 *
 * 背景：历史上第 5 周起的 180 条音标被直接填成了单词本身（"/mother/"、"/two/"），
 * 界面照常显示，看不出问题 —— 典型的静默错误。这个脚本把「音标必须是真 IPA」
 * 这件事固化下来，并且顺带拦住「改了 wordData.ts 忘了重跑 gen-words-js.mjs」
 * 这种更隐蔽的不一致。
 *
 * 规矩：英式音标（牛津/剑桥写法）。允许出现的字符只有 IPA 符号本身，
 * 外加 `/` 包裹、`ˈ`/`ˌ` 重音、`ː` 长音符、`.` 音节分隔。
 *
 * 用法：node phonetic-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const HERE = __dirname;
const WORD_DATA = path.join(HERE, '..', 'src', 'data', 'wordData.ts');
const WORDS_JS = path.join(HERE, '..', 'starwords-miniprogram', 'utils', 'words.js');

let pass = 0;
const failures = [];

function ok(name) {
  pass++;
  console.log('  ✓ ' + name);
}

function bad(name, detail) {
  failures.push(name + (detail ? ' —— ' + detail : ''));
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}

/* ---------------------------------------------------------------- */
/* 校验规则                                                          */
/* ---------------------------------------------------------------- */

// c / q / x / y 只存在于英文拼写里，不是 IPA 符号 —— 它们出现就说明音标是抄的单词
const ALLOWED = new Set(
  [
    'b', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'z',
    'a', 'e', 'i', 'o', 'u',
    'æ', 'ɑ', 'ɒ', 'ɔ', 'ə', 'ɜ', 'ɪ', 'ʊ', 'ʌ',
    'ð', 'θ', 'ʃ', 'ʒ', 'ŋ', 'ɡ',
    'ː', 'ˈ', 'ˌ', '.',
    ' ',
  ].join('')
);

const VOWELS = 'aeiouɑæɒɔəɜɪʊʌ';

// 少数单词的英式音标恰好与拼写一模一样（字母正好都是合法 IPA 符号），属正常
const SELF_SPELLED_OK = new Set(['bed', 'desk', 'red']);

/** 连续元音符号算一拍（双元音 /eɪ/ 是一拍），据此数音节 */
function syllablesOf(inner) {
  return inner.split(new RegExp('[^' + VOWELS + ']+')).filter(Boolean).length;
}

/** @returns {string[]} 问题列表，空数组 = 合法 */
function validatePhonetic(id, word, phonetic) {
  const problems = [];
  const where = '(' + phonetic + ')';

  if (typeof phonetic !== 'string' || !phonetic.startsWith('/') || !phonetic.endsWith('/')) {
    return ['不是 /……/ 形式 ' + where];
  }
  const inner = phonetic.slice(1, -1);
  if (inner.length === 0) problems.push('音标内容为空');
  if (phonetic.trim() !== phonetic || /[^\S ]/.test(phonetic) || / {2,}/.test(phonetic)) {
    problems.push('空格位置不合法');
  }
  for (const ch of inner) {
    if (!ALLOWED.has(ch)) problems.push('含非 IPA 字符 "' + ch + '" ' + where);
  }
  const plain = String(word).replace(/\s/g, '').toLowerCase();
  if (!SELF_SPELLED_OK.has(plain) && inner.toLowerCase() === plain) {
    problems.push('音标就是单词本身 ' + where);
  }
  if (syllablesOf(inner) >= 2 && !phonetic.includes('ˈ')) {
    problems.push('多音节词缺主重音 ' + where);
  }
  return problems;
}

/* ---------------------------------------------------------------- */
/* 读取两侧数据                                                      */
/* ---------------------------------------------------------------- */

function readWordData() {
  const src = fs.readFileSync(WORD_DATA, 'utf8');
  const start = src.indexOf('const WORD_ENTRIES: WordEntry[] = [');
  const end = src.indexOf('];', start);
  const arrText = src.slice(src.indexOf('[', src.indexOf('=', start)), end + 1);
  return JSON.parse(arrText);
}

function readWordsJs() {
  const m = new Module(WORDS_JS, null);
  m.filename = WORDS_JS;
  m.paths = Module._nodeModulePaths(path.dirname(WORDS_JS));
  m._compile(fs.readFileSync(WORDS_JS, 'utf8'), WORDS_JS);
  return m.exports;
}

function main() {
  console.log('[1] wordData.ts 词条');
  const entries = readWordData();
  if (entries.length === 200) ok('共 200 条');
  else bad('词条数应为 200', '实际 ' + entries.length);

  console.log('\n[2] wordData.ts 音标合法性');
  let formatBad = 0;
  for (const e of entries) {
    const problems = validatePhonetic(e.id, e.word, e.phonetic);
    if (problems.length) {
      formatBad++;
      if (formatBad <= 12) bad(e.id + ' ' + e.word, problems.join('；'));
    }
  }
  if (formatBad === 0) ok('200 条全部是合法英式 IPA');
  else if (formatBad > 12) bad('合计 ' + formatBad + ' 条不合法（仅列出前 12 条）');

  console.log('\n[3] 音标不重复');
  const seen = new Map();
  let dup = 0;
  for (const e of entries) {
    const key = String(e.phonetic).toLowerCase();
    if (seen.has(key)) {
      dup++;
      bad(e.id + ' ' + e.word, '与 ' + seen.get(key) + ' 同音标 ' + e.phonetic);
    } else {
      seen.set(key, e.id + ' ' + e.word);
    }
  }
  if (dup === 0) ok('200 条音标互不相同');

  console.log('\n[4] 小程序词库与 Web 词库一致（防忘记重跑 gen-words-js.mjs）');
  const words = readWordsJs();
  const list = (words && words.WORDS) || [];
  if (list.length === 200) ok('words.js 共 200 条');
  else bad('words.js 词条数应为 200', '实际 ' + list.length);

  const byId = new Map(entries.map((e) => [e.id, e]));
  let drift = 0;
  for (const w of list) {
    const src = byId.get(w.id);
    if (!src) {
      drift++;
      bad(w.id, 'wordData.ts 里找不到该词条');
    } else if (src.phonetic !== w.phonetic) {
      drift++;
      bad(w.id + ' ' + w.word, '音标不一致：wordData.ts 是 ' + src.phonetic + '，words.js 是 ' + w.phonetic);
    }
  }
  const ids = new Set(list.map((w) => w.id));
  for (const e of entries) {
    if (!ids.has(e.id)) {
      drift++;
      bad(e.id + ' ' + e.word, 'words.js 里缺这条（需要重跑 gen-words-js.mjs）');
    }
  }
  if (drift === 0) ok('两侧 200 条音标逐条一致');

  console.log('\n[5] words.js 音标合法性');
  let jsBad = 0;
  for (const w of list) {
    const problems = validatePhonetic(w.id, w.word, w.phonetic);
    if (problems.length) {
      jsBad++;
      if (jsBad <= 12) bad(w.id + ' ' + w.word, problems.join('；'));
    }
  }
  if (jsBad === 0) ok('200 条全部是合法英式 IPA');
  else if (jsBad > 12) bad('合计 ' + jsBad + ' 条不合法（仅列出前 12 条）');

  console.log('\n────────────────────────────────────────');
  if (failures.length === 0) {
    console.log('全部通过（' + pass + ' 项）');
    process.exit(0);
  }
  console.log('通过 ' + pass + ' 项，失败 ' + failures.length + ' 项：');
  for (const f of failures.slice(0, 30)) console.log('  - ' + f);
  if (failures.length > 30) console.log('  …还有 ' + (failures.length - 30) + ' 项');
  process.exit(1);
}

main();
