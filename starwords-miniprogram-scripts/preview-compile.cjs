/**
 * 用 WorkBuddy 平台自己的小程序预览编译器，在本地复现「预览」这一步。
 *
 * 原理：平台预览面板（workbuddy-baas 扩展 UI）会调用扩展方法
 *   compilePreview({ projectDir, appEndpoint })
 * 编译成功返回 { status:"ready", url }，失败时 UI 只在 console.warn，
 * 界面上没有任何提示 —— 这就是「预览一片空白、看不到报错」的原因。
 *
 * 这里把扩展包的入口挂钩（旧版是 `bootstrap(async () => ({`, 新版是导出 `activate(ctx)`）
 * 换成可本地调用的一层，从而在本地直接调用同一个 compilePreview，把真实的失败原因打出来。
 *
 * 用法：
 *   node preview-compile.cjs [projectDir]
 *     projectDir 默认取 8 级父目录（工作区根），与 .genie 里的 localDir 一致。
 *   加 --serve 参数则常驻运行，把编译产物用 HTTP 服务起来（可直接在浏览器打开）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_SERVER =
  'D:/Program Files/WorkBuddy/resources/app.asar.unpacked/resources/extensions/workbuddy-baas/server/index.cjs';

const argv = process.argv.slice(2);
const serve = argv.includes('--serve');
const projectDir =
  argv.find((a) => !a.startsWith('--')) ||
  path.resolve(__dirname, '..');

if (!fs.existsSync(projectDir)) {
  console.error('projectDir 不存在:', projectDir);
  process.exit(2);
}
if (!fs.existsSync(EXT_SERVER)) {
  console.error('找不到平台扩展包，可能 WorkBuddy 安装路径变了:', EXT_SERVER);
  process.exit(2);
}

/**
 * 造一个「可本地调用」的编译器：返回 boot 对象（含 methods.compilePreview）。
 * 兼容两种扩展入口形态，平台升级时不用改这个脚本。
 */
function makeBoot() {
  const src = fs.readFileSync(EXT_SERVER, 'utf8');

  // 旧形态：模块顶部调用 bootstrap(async () => ({ ... }))，把它替换成捕获函数
  const LEGACY_NEEDLE = 'bootstrap(async () => ({';
  if (src.includes(LEGACY_NEEDLE)) {
    const patchedCode =
      src.replace(LEGACY_NEEDLE, '__wbCapture(async () => ({') +
      '\n;function __wbCapture(f){ globalThis.__wbFactory = f; }\n';
    const patched = path.join(os.tmpdir(), 'wb-baas-compiler.cjs');
    fs.writeFileSync(patched, patchedCode, 'utf8');
    console.log('[1] 旧版扩展结构：已生成可调用的编译器副本:', patched);
    require(patched);
    return globalThis.__wbFactory();
  }

  // 新形态：导出 activate(ctx) → { methods, dispose }
  const mod = require(EXT_SERVER);
  if (mod && typeof mod.activate === 'function') {
    console.log('[1] 新版扩展结构：直接调用导出的 activate()');
    return mod.activate({});
  }

  console.error('扩展包结构已变化，既不认识旧版 bootstrap 也没有导出 activate()');
  process.exit(2);
}

/* ---------- 2. 调用平台的 compilePreview ---------- */
console.log('[2] projectDir =', projectDir);
console.log('    开始编译…');

(async () => {
  let boot;
  try {
    boot = await makeBoot();
  } catch (err) {
    console.error('初始化编译器失败:', err && err.message);
    process.exit(1);
  }

  let result;
  const t0 = Date.now();
  try {
    result = await boot.methods.compilePreview({}, { projectDir });
  } catch (err) {
    console.error('\n✗ 编译失败 —— 这就是预览打不开的原因');
    console.error('  code   :', (err && err.code) || '(无)');
    console.error('  message:', (err && err.message) || String(err));
    if (err && err.stack) {
      console.error(
        '  stack  :\n' + err.stack.split('\n').slice(1, 6).join('\n')
      );
    }
    process.exit(1);
  }

  console.log(`\n✓ 编译成功（${Date.now() - t0}ms）`);
  console.log('  status    :', result.status);
  console.log('  pagePath  :', result.pagePath);
  console.log('  sourceHash:', result.sourceHash);
  console.log('  url       :', result.url);

  if (!serve) {
    console.log('\n（未加 --serve，编译完即退出）');
    process.exit(0);
  }

  // 常驻：让预览服务保活，供浏览器 / 预览面板访问
  console.log('\n[3] 预览服务已启动，保持运行中。按 Ctrl+C 结束。');
  setInterval(() => {}, 1 << 30);
})().catch((err) => {
  console.error('未预期错误:', err);
  process.exit(1);
});
