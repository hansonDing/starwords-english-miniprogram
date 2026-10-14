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
 *   node preview-compile.cjs [projectDir] [--genie=<file.genie>] [--serve]
 *     projectDir 默认取 .genie 里的 localDir（工作区根），与预览面板行为一致。
 *   新版平台（workbuddy-baas-v2）要求先「打开应用」注册允许目录：
 *     先 resolvePreview({ genieFile }) → 再 compilePreview({ projectDir })
 *   本脚本已自动带上这一步；找不到 .genie 时用 --genie= 显式指定。
 *   加 --serve 则常驻运行，把编译产物用 HTTP 服务起来（可直接在浏览器打开）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 定位平台扩展入口。平台的扩展目录名会随版本变（`workbuddy-baas` → `workbuddy-baas-v2` …），
 * 所以这里不写死，改为扫描扩展目录挑出带 compilePreview 的那个，避免平台升级后脚本失效。
 * 需要覆盖时设环境变量 WB_BAAS_SERVER=<server/index.cjs 绝对路径>。
 */
function findExtServer() {
  if (process.env.WB_BAAS_SERVER) return process.env.WB_BAAS_SERVER;

  const roots = [
    'D:/Program Files/WorkBuddy/resources/app.asar.unpacked/resources/extensions',
    'C:/Program Files/WorkBuddy/resources/app.asar.unpacked/resources/extensions',
    path.join(
      process.env.LOCALAPPDATA || '',
      'Programs/WorkBuddy/resources/app.asar.unpacked/resources/extensions'
    ),
    path.join(os.homedir(), 'AppData/Local/Programs/WorkBuddy/resources/app.asar.unpacked/resources/extensions'),
  ];

  const hits = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!/^workbuddy-baas/.test(name)) continue;
      const entry = path.join(root, name, 'server', 'index.cjs');
      if (!fs.existsSync(entry)) continue;
      let src = '';
      try {
        src = fs.readFileSync(entry, 'utf8');
      } catch (e) {
        continue;
      }
      if (src.includes('compilePreview')) hits.push(entry);
    }
  }
  if (!hits.length) return null;
  // 多个命中时优先精确名（老版无后缀），否则取字典序最大（v2 / v3 …）
  hits.sort((a, b) => {
    const an = path.basename(path.dirname(path.dirname(a)));
    const bn = path.basename(path.dirname(path.dirname(b)));
    const aExact = an === 'workbuddy-baas' ? 0 : 1;
    const bExact = bn === 'workbuddy-baas' ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return bn.localeCompare(an);
  });
  return hits[0];
}

const EXT_SERVER = findExtServer();

const argv = process.argv.slice(2);
const serve = argv.includes('--serve');
const genieArg = (argv.find((a) => a.startsWith('--genie=')) || '').slice('--genie='.length);
let projectDir = argv.find((a) => !a.startsWith('--')) || null;

/** 找 .genie（平台用它登记应用与 localDir）；先看给定目录，再看其父目录。 */
function findGenieFile(baseDir) {
  const dirs = [baseDir, baseDir && path.resolve(baseDir, '..'), __dirname, path.resolve(__dirname, '..')];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    const hit = names.filter((n) => n.endsWith('.genie')).map((n) => path.join(dir, n));
    if (hit.length) return hit[0];
  }
  return null;
}

const GENIE_FILE = genieArg
  ? path.resolve(genieArg)
  : findGenieFile(projectDir || path.resolve(__dirname, '..'));

if (projectDir && !fs.existsSync(projectDir)) {
  console.error('projectDir 不存在:', projectDir);
  process.exit(2);
}
if (!EXT_SERVER || !fs.existsSync(EXT_SERVER)) {
  console.error(
    '找不到平台扩展包（已扫描 extensions/workbuddy-baas*），可能 WorkBuddy 安装路径变了。'
  );
  console.error('可用 WB_BAAS_SERVER 环境变量显式指定 server/index.cjs 路径。');
  process.exit(2);
}
console.log('[0] 平台扩展入口 =', EXT_SERVER);
console.log('[0] .genie        =', GENIE_FILE || '(未找到，跳过打开应用这一步)');

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
(async () => {
  let boot;
  try {
    boot = await makeBoot();
  } catch (err) {
    console.error('初始化编译器失败:', err && err.message);
    process.exit(1);
  }

  // 新版平台先要「打开应用」把工程根登记进白名单，compilePreview 才放行。
  // 老版没有 resolvePreview，跳过即可。
  if (GENIE_FILE && typeof boot.methods.resolvePreview === 'function') {
    try {
      const opened = await boot.methods.resolvePreview({ genieFile: GENIE_FILE });
      const localDir = opened && opened.app && opened.app.localDir;
      console.log('[1.5] resolvePreview 已打开应用，localDir =', localDir || '(无)');
      if (localDir && !projectDir) projectDir = localDir;
    } catch (err) {
      console.log('[1.5] resolvePreview 失败（老平台可忽略）:', err && err.message);
    }
  }
  if (!projectDir) projectDir = path.resolve(__dirname, '..');
  if (!fs.existsSync(projectDir)) {
    console.error('projectDir 不存在:', projectDir);
    process.exit(2);
  }
  console.log('[2] projectDir =', projectDir);
  console.log('    开始编译…');

  let result;
  const t0 = Date.now();
  try {
    // 新平台签名：compilePreview(params)（旧版是 compilePreview(ctx, params)，readParams 两者都兼容）
    result = await boot.methods.compilePreview({ projectDir });
  } catch (err) {
    console.error('\n✗ 编译调用失败 —— 这就是预览打不开的原因');
    console.error('  code   :', (err && err.code) || '(无)');
    console.error('  message:', (err && err.message) || String(err));
    if (err && err.stack) {
      console.error(
        '  stack  :\n' + err.stack.split('\n').slice(1, 6).join('\n')
      );
    }
    process.exit(1);
  }

  // 新平台把编译错误包成 { status:'failed', code, message } 返回，而不是抛异常
  if (result && result.status === 'failed') {
    console.error('\n✗ 编译失败 —— 这就是预览打不开的原因');
    console.error('  code   :', result.code || '(无)');
    console.error('  message:', result.message || '(无)');
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
