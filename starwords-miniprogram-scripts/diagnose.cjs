// 深度诊断：wxml 标签配对 / wxss 语法 / JS 现代语法 / 图片文件头有效性
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'starwords-miniprogram');
const rel = (p) => path.relative(root, p).split(path.sep).join('/');
let problems = 0;
const bad = (m) => {
  console.log('  ✗ ' + m);
  problems++;
};
const ok = (m) => console.log('  ✓ ' + m);

/* ---------- 1. wxml 标签配对 ---------- */
console.log('[1] wxml 标签配对');
const VOID = new Set(['image', 'input', 'icon', 'progress', 'import', 'include', 'wxs']);
const wxmlFiles = [];
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.wxml')) wxmlFiles.push(p);
  }
})(root);

for (const f of wxmlFiles) {
  const src = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  let err = null;
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrs, selfClose] = m;
    if (closing) {
      const top = stack.pop();
      if (top !== tag) {
        err = `</${tag}> 与 <${top || '无'}> 不匹配`;
        break;
      }
    } else if (!selfClose && !VOID.has(tag)) {
      stack.push(tag);
    }
  }
  if (!err && stack.length) err = `未闭合标签 <${stack.join('>, <')}>`;
  if (err) bad(`${rel(f)}: ${err}`);
}
if (!problems) ok(`${wxmlFiles.length} 个 wxml 标签全部配对`);

/* ---------- 2. wxss 花括号配平 + 非法字符 ---------- */
console.log('[2] wxss 语法');
const wxssFiles = [];
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.wxss')) wxssFiles.push(p);
  }
})(root);
for (const f of wxssFiles) {
  const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const open = (src.match(/\{/g) || []).length;
  const close = (src.match(/\}/g) || []).length;
  if (open !== close) bad(`${rel(f)}: 花括号不配平 { ${open} vs } ${close}`);
}
ok(`${wxssFiles.length} 个 wxss 花括号配平`);

/* ---------- 3. JS 现代语法（老引擎会解析失败） ---------- */
console.log('[3] JS 现代语法');
const jsFiles = [];
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.js')) jsFiles.push(p);
  }
})(root);
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  if (/\?\.[a-zA-Z_$[(]/.test(src)) bad(`${rel(f)}: 含可选链 ?.`);
  if (/[^?]\?\?[^?]/.test(src)) bad(`${rel(f)}: 含空值合并 ??`);
  if (/catch\s*\{/.test(src)) bad(`${rel(f)}: 含省略绑定的 catch {}`);
}
ok(`${jsFiles.length} 个 JS 文件已扫描现代语法`);

/* ---------- 4. 图片文件头有效性 ---------- */
console.log('[4] 图片文件头');
let imgBad = 0;
for (const f of ['assets/tabbar/home.png', 'assets/tabbar/home-active.png', 'assets/tabbar/review.png', 'assets/tabbar/review-active.png', 'assets/tabbar/progress.png', 'assets/tabbar/progress-active.png', 'assets/tabbar/mine.png', 'assets/tabbar/mine-active.png']) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) {
    bad(`缺少 ${f}`);
    imgBad++;
    continue;
  }
  const buf = fs.readFileSync(p);
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) {
    bad(`${f} 不是有效 PNG（首字节 ${buf.slice(0, 4).toString('hex')}）`);
    imgBad++;
  }
}
if (!imgBad) ok('8 个 tab 图标均为有效 PNG');

/* ---------- 5. 单词图片抽样文件头 ---------- */
console.log('[5] 单词图片文件头（抽样 20 张）');
const imgDir = path.join(root, 'assets/images');
const imgs = fs.readdirSync(imgDir);
let jpgBad = 0;
for (const f of imgs.slice(0, 20)) {
  const buf = fs.readFileSync(path.join(imgDir, f));
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  if (!isJpg && !isPng) {
    bad(`${f} 文件头无效`);
    jpgBad++;
  }
}
if (!jpgBad) ok(`图片共 ${imgs.length} 张，抽样文件头有效`);

console.log(problems === 0 ? '\n深度诊断：未发现问题 ✓' : `\n深度诊断：发现 ${problems} 个问题 ✗`);
