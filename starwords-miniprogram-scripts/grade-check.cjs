#!/usr/bin/env node
/**
 * 年级划分静态自检。
 *
 * 背景：词库按「单元」（= 一组 5 词，words.js 里叫 week）全局连续编号 1..N。
 * 年级是**给单元加的一层区间划分**，不是新编号 —— 这样取词、音频段 id
 * （`w<week>-<n>`）、云端块映射全部不用改。
 *
 * 这个脚本把「划分表正确」这件事固化下来。划分表一旦出现缺口 / 重叠，
 * 真机表现是「点进某个年级没有词」或「两个年级互相抢词」，而且
 * **预览环境只有一个年级、根本发现不了**，所以静态校验必须足够严。
 *
 * 用法：node grade-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const HERE = __dirname;
const PKG = path.join(HERE, '..', 'starwords-miniprogram');
const PLAN_JSON = path.join(HERE, 'grade-plan.json');
const WORDS_JS = path.join(PKG, 'utils', 'words.js');
const STORE_JS = path.join(PKG, 'utils', 'store.js');
const LEARN_JS = path.join(PKG, 'pages', 'learn', 'learn.js');
const APP_JSON = path.join(PKG, 'app.json');

// 存量内容锚点：2026-10-16 时全部 200 词 = 单元 1..40。
// 划分表必须让这 40 个单元**完整落在同一个年级内**，否则现有内容的
// id（w1-1 … w40-5）、音频周包、精灵图格子都要重排 —— 那就是「迁移」，不是零改动。
const LEGACY_UNITS = 40;

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

function loadCommonJs(file) {
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8'), file);
  return m.exports;
}

/** 取源码里 module.exports = { ... } 的块（store.js 不能直接加载：顶层就要 wx） */
function exportsBlock(src) {
  const i = src.lastIndexOf('module.exports');
  if (i < 0) return '';
  const j = src.indexOf('{', i);
  const k = src.lastIndexOf('}');
  if (j < 0 || k < j) return '';
  return src.slice(j, k + 1);
}

function main() {
  console.log('年级划分自检\n');

  /* ---------------- [1] 划分表自身合法 ---------------- */
  console.log('[1] grade-plan.json 结构');
  let plan = null;
  try {
    plan = JSON.parse(fs.readFileSync(PLAN_JSON, 'utf8'));
  } catch (e) {
    bad('grade-plan.json 可解析', e.message);
    return report();
  }
  const grades = plan.grades;
  if (!Array.isArray(grades) || grades.length === 0) {
    bad('grades 是非空数组', '实际 ' + JSON.stringify(grades));
    return report();
  }
  ok('grades 有 ' + grades.length + ' 个年级');

  if (grades[0].firstUnit === 1) ok('第一个年级从单元 1 开始');
  else bad('第一个年级从单元 1 开始', '实际 firstUnit=' + grades[0].firstUnit);

  let shapeBad = 0;
  const seenId = Object.create(null);
  for (let i = 0; i < grades.length; i++) {
    const g = grades[i];
    const where = '第 ' + i + ' 项 (' + (g && g.id) + ')';
    if (!g || typeof g.id !== 'string' || !g.id) {
      shapeBad++;
      if (shapeBad <= 3) bad(where + ' 缺 id', '');
      continue;
    }
    if (typeof g.name !== 'string' || !g.name) {
      shapeBad++;
      if (shapeBad <= 3) bad(where + ' 缺 name', '');
    }
    if (seenId[g.id]) {
      shapeBad++;
      if (shapeBad <= 3) bad('年级 id 重复', g.id);
    }
    seenId[g.id] = true;
    if (!Number.isInteger(g.firstUnit) || !Number.isInteger(g.lastUnit)) {
      shapeBad++;
      if (shapeBad <= 3) bad(where + ' firstUnit / lastUnit 必须是整数', JSON.stringify(g));
    } else if (g.lastUnit < g.firstUnit) {
      shapeBad++;
      if (shapeBad <= 3) bad(where + ' lastUnit < firstUnit', JSON.stringify(g));
    }
  }
  if (shapeBad === 0) ok('每项都有 id / name / 合法区间，且 id 不重复');

  let gapBad = 0;
  for (let i = 1; i < grades.length; i++) {
    const prev = grades[i - 1];
    const cur = grades[i];
    if (cur.firstUnit !== prev.lastUnit + 1) {
      gapBad++;
      if (gapBad <= 5) {
        bad('年级区间必须首尾相接', prev.id + ' 止于 ' + prev.lastUnit + ' → ' + cur.id + ' 起于 ' + cur.firstUnit);
      }
    }
  }
  if (gapBad === 0) ok('区间连续覆盖，无重叠无缺口');

  const lastUnit = grades[grades.length - 1].lastUnit;
  const totalUnits = grades.reduce((a, g) => a + (g.lastUnit - g.firstUnit + 1), 0);
  if (totalUnits === lastUnit) ok('单元总数一致：' + totalUnits + ' 个单元 = ' + lastUnit + '（设计容量 ' + totalUnits * 5 + ' 词）');
  else bad('单元总数一致', '累加 ' + totalUnits + ' ≠ 末单元 ' + lastUnit);

  /* ---------------- [2] 划分表覆盖现有内容 ---------------- */
  console.log('\n[2] 划分表与现有内容的关系');
  const W = loadCommonJs(WORDS_JS);
  const MAX_WEEK = W.MAX_WEEK;
  const covered = grades.filter((g) => MAX_WEEK >= g.firstUnit && MAX_WEEK <= g.lastUnit);
  if (covered.length === 1) ok('现有 ' + MAX_WEEK + ' 个单元全部落在「' + covered[0].name + '」内（' + covered[0].id + '）');
  else bad('现有内容必须完整落在某一个年级内', 'MAX_WEEK=' + MAX_WEEK + ' 命中 ' + covered.length + ' 个年级');

  const g1 = grades[0];
  if (g1.firstUnit === 1 && g1.lastUnit === LEGACY_UNITS) {
    ok('一年级 = 单元 1..' + LEGACY_UNITS + ' = 现有全部内容（零迁移锚点）');
  } else {
    bad(
      '一年级必须恰好覆盖存量锚点 1..' + LEGACY_UNITS,
      '实际 ' + g1.firstUnit + '..' + g1.lastUnit + ' —— 改了这里就要同步重排现有内容的 id / 音频包 / 精灵图格子'
    );
  }
  if (MAX_WEEK >= LEGACY_UNITS) ok('现有单元数不少于锚点（' + MAX_WEEK + ' ≥ ' + LEGACY_UNITS + '）');
  else bad('现有单元数不少于锚点', MAX_WEEK + ' < ' + LEGACY_UNITS + '，存量内容变少了？');

  /* ---------------- [3] words.js 导出与两侧一致 ---------------- */
  console.log('\n[3] words.js 的年级导出');
  const NEED_EXPORTS = ['GRADES', 'LAST_UNIT', 'gradeById', 'gradeOfWeek', 'getGradeWords', 'getWeekWords', 'MAX_WEEK'];
  const exportSrc = exportsBlock(fs.readFileSync(WORDS_JS, 'utf8'));
  const missingExport = NEED_EXPORTS.filter((n) => !new RegExp('\\b' + n + '\\b').test(exportSrc));
  if (missingExport.length === 0) ok('words.js 导出了 ' + NEED_EXPORTS.join(' / '));
  else bad('words.js 导出不全', '缺 ' + missingExport.join(', ') + '（跑 gen-words-js.mjs）');

  if (W.LAST_UNIT === lastUnit) ok('LAST_UNIT 与划分表一致（' + lastUnit + '）');
  else bad('LAST_UNIT 与划分表一致', 'words.js=' + W.LAST_UNIT + ' / grade-plan.json=' + lastUnit);

  // 两侧一致性：改了 grade-plan.json 忘重跑生成器 → 这里必须红
  const planSig = JSON.stringify(grades.map((g) => [g.id, g.name, g.firstUnit, g.lastUnit]));
  const wordsSig = JSON.stringify((W.GRADES || []).map((g) => [g.id, g.name, g.firstUnit, g.lastUnit]));
  if (planSig === wordsSig) ok('words.js 的 GRADES 与 grade-plan.json 完全一致');
  else bad('words.js 的 GRADES 与 grade-plan.json 完全一致', '不一致 —— 改了划分表要重跑 gen-words-js.mjs');

  // 防回退到「把 grade 落到每个词条」的方案（1600 词时白占约 22KB 主包）
  const withGrade = W.WORDS.filter((w) => Object.prototype.hasOwnProperty.call(w, 'grade'));
  if (withGrade.length === 0) ok('词条里不含 grade 字段（由 week 查表推导）');
  else bad('词条里不含 grade 字段', withGrade.length + ' 条带了（如 ' + withGrade[0].id + '）—— 会白占主包体积');

  /* ---------------- [4] gradeOfWeek / getGradeWords 行为 ---------------- */
  console.log('\n[4] 查表函数行为');
  let lookupBad = 0;
  for (let u = 1; u <= lastUnit; u++) {
    const g = W.gradeOfWeek(u);
    if (!g || u < g.firstUnit || u > g.lastUnit) {
      lookupBad++;
      if (lookupBad <= 5) bad('gradeOfWeek(' + u + ') 命中所在年级', JSON.stringify(g));
    }
  }
  if (lookupBad === 0) ok('1..' + lastUnit + ' 每个单元都能查到自己的年级');

  const over = W.gradeOfWeek(lastUnit + 100);
  if (over && over.id === grades[grades.length - 1].id) ok('越界单元（上溢）兜底到最后一个年级，不返回空');
  else bad('越界单元（上溢）兜底到最后一个年级', JSON.stringify(over));
  // 下溢只是「永不返回空」的兜底，不要求具体是哪个年级 —— 断言对象形状即可
  const under = W.gradeOfWeek(0);
  if (under && typeof under.id === 'string' && typeof under.firstUnit === 'number') ok('越界单元（下溢）不崩，仍返回一个年级对象');
  else bad('gradeOfWeek(0) 不崩且返回年级对象', JSON.stringify(under));

  let wordsBad = 0;
  for (const g of grades) {
    const list = W.getGradeWords(g.id);
    const expectMax = Math.max(0, Math.min(g.lastUnit, MAX_WEEK) - g.firstUnit + 1);
    const expect = expectMax * W.WORDS_PER_WEEK;
    if (list.length !== expect) {
      wordsBad++;
      if (wordsBad <= 5) bad('getGradeWords(' + g.id + ') 词数', '实际 ' + list.length + ' / 应为 ' + expect);
    }
    const strayed = list.filter((w) => w.week < g.firstUnit || w.week > g.lastUnit);
    if (strayed.length) {
      wordsBad++;
      if (wordsBad <= 5) bad('getGradeWords(' + g.id + ') 不得越界', strayed[0].id);
    }
  }
  if (wordsBad === 0) ok('每个年级取到的词数正确且不越界');

  if (W.getGradeWords('g-nonexistent').length === 0) ok('未知年级返回空数组（不崩）');
  else bad('未知年级返回空数组', '');

  // 全部词条必须能被某个年级认领 —— 否则那些词在界面上永远看不到
  const total = grades.reduce((a, g) => a + W.getGradeWords(g.id).length, 0);
  if (total === W.WORDS.length) ok('全部 ' + total + ' 个词条都能被某个年级认领');
  else bad('全部词条都能被某个年级认领', '覆盖 ' + total + ' / 共 ' + W.WORDS.length);

  /* ---------------- [5] store.js 的年级接口 ---------------- */
  console.log('\n[5] utils/store.js 接口');
  const storeSrc = fs.readFileSync(STORE_JS, 'utf8');
  const storeExports = exportsBlock(storeSrc);
  const NEED_STORE = ['currentGrade', 'nextUnitInGrade', 'gradeStats', 'setGrade', 'currentGradeMaxUnit'];
  const missingStore = NEED_STORE.filter((n) => !new RegExp('\\b' + n + '\\b').test(storeExports));
  if (missingStore.length === 0) ok('store.js 导出了 ' + NEED_STORE.join(' / '));
  else bad('store.js 年级接口导出不全', '缺 ' + missingStore.join(', '));

  if (/currentGrade\s*:\s*['"]g1['"]/.test(storeSrc)) ok('DEFAULT_PROGRESS 带 currentGrade: "g1"');
  else bad('DEFAULT_PROGRESS 带 currentGrade: "g1"', '新存档必须有默认年级');
  if (/progressVersion\s*:\s*3\b/.test(storeSrc)) ok('progressVersion 已升到 3');
  else bad('progressVersion 已升到 3', '新增了 currentGrade 字段');
  if (/gradeOfWeek/.test(storeSrc)) ok('normalizeProgress 用 gradeOfWeek 反推缺失的年级');
  else bad('normalizeProgress 用 gradeOfWeek 反推缺失的年级', '老存档缺 currentGrade 会落到错年级');

  /* ---------------- [6] 页面调用点 ---------------- */
  console.log('\n[6] 调用点已解耦');
  const learnSrc = fs.readFileSync(LEARN_JS, 'utf8');
  if (/nextUnitInGrade/.test(learnSrc)) ok('learn.js 改走 store.nextUnitInGrade 取词');
  else bad('learn.js 改走 store.nextUnitInGrade 取词', '还在按 currentWeek 当单元指针');
  const badTake = learnSrc.match(/getWeekWords\(\s*[^)]*currentWeek[^)]*\)/);
  if (!badTake) ok('learn.js 不再把 progress.currentWeek 当单元指针传给 getWeekWords');
  else bad('learn.js 不再把 progress.currentWeek 当单元指针', badTake[0]);
  const badMax = learnSrc.match(/completeDailySession\(\s*MAX_WEEK/);
  if (!badMax) ok('completeDailySession 的调用方不再传 MAX_WEEK（防跨年级跳）');
  else bad('completeDailySession 的调用方不再传 MAX_WEEK', badMax[0] + ' —— 会越过当前年级边界');
  if (/currentGradeMaxUnit/.test(learnSrc)) ok('learn.js 用 currentGradeMaxUnit() 取代 MAX_WEEK');
  else bad('learn.js 用 currentGradeMaxUnit() 取代 MAX_WEEK', '');

  /* ---------------- [7] pages/grades 已注册 ---------------- */
  console.log('\n[7] 年级选择页注册');
  let app = null;
  try {
    app = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  } catch (e) {
    bad('app.json 可解析', e.message);
    return report();
  }
  const pages = Array.isArray(app.pages) ? app.pages : [];
  if (pages.indexOf('pages/grades/grades') !== -1) ok('app.json 已注册 pages/grades/grades');
  else bad('app.json 已注册 pages/grades/grades', '页面不注册就跳不过去');

  const tabPages = ((app.tabBar && app.tabBar.list) || []).map((t) => t.pagePath);
  if (tabPages.indexOf('pages/grades/grades') === -1) ok('pages/grades 不在 tabBar 里（tabBar 页必须留主包）');
  else bad('pages/grades 不在 tabBar 里', '进了 tabBar 会挡住未来分包');

  const four = ['js', 'json', 'wxml', 'wxss'];
  const missingFile = four.filter((ext) => !fs.existsSync(path.join(PKG, 'pages', 'grades', 'grades.' + ext)));
  if (missingFile.length === 0) ok('pages/grades 四件套齐（js/json/wxml/wxss）');
  else bad('pages/grades 四件套齐', '缺 ' + missingFile.join(', ') + '（缺 .json 会让真机整组 tab 白屏）');

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
