// 小程序静态自检：一次性覆盖真机最容易踩的坑
// 用法：node check-static.cjs（脚本目录已移出小程序包，见 ../starwords-miniprogram）
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'starwords-miniprogram');
const rel = (p) => path.relative(root, p).split(path.sep).join('/');
let failed = 0;
const fail = (msg) => {
  console.log('  ✗ ' + msg);
  failed++;
};
const pass = (msg) => console.log('  ✓ ' + msg);

function sizeOf(dir) {
  let s = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    s += st.isDirectory() ? sizeOf(p) : st.size;
  }
  return s;
}

/* ---------- 1. 模块解析：禁止裸包名 require，相对引用必须存在 ---------- */
console.log('[1] 模块引用');
const jsFiles = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'scripts') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith('.js')) jsFiles.push(p);
  }
})(root);

for (const file of jsFiles) {
  const code = fs.readFileSync(file, 'utf8');
  for (const m of code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1];
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      fail(`${rel(file)} 使用裸包名 require('${spec}')，真机无法解析`);
      continue;
    }
    const base = spec.startsWith('/') ? path.join(root, spec) : path.resolve(path.dirname(file), spec);
    const candidates = [base, base + '.js', path.join(base, 'index.js')];
    if (!candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile())) {
      fail(`${rel(file)} require('${spec}') 找不到目标文件`);
    }
  }
}
if (!failed) pass(`${jsFiles.length} 个 JS 文件引用全部可解析，无裸包名`);

/* ---------- 2. 页面四件套齐备（缺 .json 会导致真机 wx://not-found 白屏） ---------- */
console.log('[2] 页面文件齐备');
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
for (const pg of app.pages) {
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    if (!fs.existsSync(path.join(root, pg + ext))) fail(`缺少 ${pg}${ext}`);
  }
}
pass(`${app.pages.length} 个页面 × 4 文件`);

/* ---------- 3. tabBar 图标 ---------- */
console.log('[3] tabBar 图标');
for (const t of app.tabBar.list) {
  for (const k of ['iconPath', 'selectedIconPath']) {
    if (!fs.existsSync(path.join(root, t[k]))) fail(`缺少图标 ${t[k]}`);
  }
}
pass('图标齐备');

/* ---------- 3b. 分包配置（subPackages 的 pages 不能为空，否则构建校验失败→预览/真机空白） ---------- */
console.log('[3b] 分包配置');
const subs = app.subpackages || app.subPackages || [];
if (subs.length === 0) {
  pass('未使用分包（全部资源在主包内）');
} else {
  for (const s of subs) {
    const dir = path.join(root, s.root);
    if (!s.root) {
      fail('分包缺少 root');
      continue;
    }
    if (!fs.existsSync(dir)) {
      fail(`分包目录不存在 ${s.root}`);
      continue;
    }
    if (!Array.isArray(s.pages) || s.pages.length === 0) {
      fail(`分包 ${s.root} 的 pages 为空数组 —— 微信构建校验会失败（预览/真机空白）`);
      continue;
    }
    for (const pg of s.pages) {
      const full = path.join(dir, pg);
      for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
        if (!fs.existsSync(full + ext)) fail(`分包页缺少 ${s.root}/${pg}${ext}`);
      }
    }
  }
  const names = subs.map((s) => s.name).filter(Boolean);
  if (names.length) pass(`分包 ${names.join(', ')} 配置正常`);
}

/* ---------- 4. 词库资源（单词图已合并为 assets/sprite.jpg 精灵图） ---------- */
console.log('[4] 词库资源');
const wordsCode = fs.readFileSync(path.join(root, 'utils', 'words.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', 'require', wordsCode)(mod, mod.exports, () => {
  throw new Error('words.js 不应有外部依赖');
});
const WORDS = mod.exports.WORDS;
const SPRITE = mod.exports.SPRITE;

// 从 JPEG SOF 段读取真实尺寸，不依赖第三方库
function jpegSize(file) {
  const buf = fs.readFileSync(file);
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

let bad = 0;
const spriteAbs = path.resolve(root, 'pages', 'learn', SPRITE.src);
if (!fs.existsSync(spriteAbs)) {
  fail(`精灵图缺失 ${SPRITE.src}`);
  bad++;
} else {
  const size = jpegSize(spriteAbs);
  if (!size) fail('精灵图不是合法 JPEG');
  else if (size.w !== SPRITE.cols * SPRITE.cell || size.h !== SPRITE.rows * SPRITE.cell) {
    fail(
      `精灵图尺寸 ${size.w}x${size.h} 与声明不符，应为 ${SPRITE.cols * SPRITE.cell}x${SPRITE.rows * SPRITE.cell}` +
        `（SPRITE.cols/rows/cell 与 gen-sprite.py、app.wxss 的 .sprite-img 必须一致）`
    );
  }
  // app.wxss 里 .sprite-img 的缩放倍数必须等于 列数/行数 × 100%
  const wxss = fs.readFileSync(path.join(root, 'app.wxss'), 'utf8');
  const needW = `width: ${SPRITE.cols * 100}%`;
  const needH = `height: ${SPRITE.rows * 100}%`;
  if (!wxss.includes(needW) || !wxss.includes(needH)) {
    fail(`app.wxss 的 .sprite-img 应为 ${needW} / ${needH}，与精灵图 ${SPRITE.cols}x${SPRITE.rows} 不匹配`);
  }
}

const stepX = 100 / SPRITE.cols;
const stepY = 100 / SPRITE.rows;
for (const w of WORDS) {
  if (!w.audio || !w.phraseAudio) {
    fail(`${w.id} 资源字段为空`);
    bad++;
    continue;
  }
  if (w.audio.startsWith('/') || w.phraseAudio.startsWith('/')) {
    fail(`${w.id} 使用前导斜杠绝对路径（预览模拟器无法解析）`);
    bad++;
  }
  for (const [label, p] of [
    ['单词音频', w.audio],
    ['例句音频', w.phraseAudio],
  ]) {
    if (!fs.existsSync(path.resolve(root, 'pages', 'learn', p))) {
      fail(`${w.id} ${label}缺失 ${p}`);
      bad++;
    }
  }
  // 格子偏移必须是列/行步长的整数倍，且在 0 ~ 负一格以内
  const nx = w.imgTx / stepX;
  const ny = w.imgTy / stepY;
  if (Math.abs(nx - Math.round(nx)) > 0.02 || Math.abs(ny - Math.round(ny)) > 0.02) {
    fail(`${w.id} 精灵图偏移 (${w.imgTx}%, ${w.imgTy}%) 不是格子的整数倍`);
    bad++;
  } else if (-Math.round(nx) >= SPRITE.cols || -Math.round(ny) >= SPRITE.rows) {
    fail(`${w.id} 精灵图偏移超出 ${SPRITE.cols}x${SPRITE.rows} 网格`);
    bad++;
  }
}
// 词条数不能超过精灵图容量，否则有词会取到空格子
if (WORDS.length > SPRITE.cols * SPRITE.rows) {
  fail(`词条 ${WORDS.length} 个超过精灵图容量 ${SPRITE.cols * SPRITE.rows} 格`);
  bad++;
}
// 预览编译器只复制 wxml 里「字面量 src」引用的资源（copyLocalAsset），
// 用 {{}} 数据绑定的路径不会被复制进预览产物，预览里图片就会 404。
// 因此图片必须写成字面量，路径差异只体现在 style 的 translate 偏移上。
let dynImg = 0;
let literalSpritePages = 0;
for (const pg of app.pages) {
  const wxml = fs.readFileSync(path.join(root, pg + '.wxml'), 'utf8');
  for (const m of wxml.matchAll(/<image\b[^>]*?\bsrc\s*=\s*"([^"]*)"/g)) {
    if (m[1].includes('{{')) {
      fail(`${pg}.wxml 的 <image src="${m[1]}"> 用了数据绑定 —— 预览编译器不会复制该资源，预览里会 404`);
      dynImg++;
    }
  }
  if (wxml.includes('src="../../assets/sprite.jpg"')) literalSpritePages++;
}
if (!dynImg && literalSpritePages < 3) {
  fail(`只有 ${literalSpritePages} 个页面用字面量引用了精灵图，预期至少 3 个（index/learn/review）`);
  bad++;
}
if (!bad) {
  pass(
    `${WORDS.length} 个词的单词音频/例句音频齐备；精灵图偏移全部落在 ${SPRITE.cols}x${SPRITE.rows} 网格内；` +
      `${literalSpritePages} 个页面用字面量 src 引用精灵图（预览可正常取图）`
  );
}

/* ---------- 4b. 工程文件总数（预览编译器的硬上限，超了预览首页直接打不开） ----------
   依据：WorkBuddy 内置预览编译器 workbuddy-baas/server/compiler.ts 里
   MAX_SOURCE_FILES = 500、MAX_SINGLE_FILE_BYTES = 2MB、MAX_TOTAL_BYTES = 20MB。
   collectSourceFiles 会把包内所有文件（含图片/音频）计入，超过即抛
   CompileError("UNSUPPORTED_FEATURE", "源文件超过 500 个")，表现为预览打不开。
   （注意：这条限制不影响「发布」，发布链路的上限是 10000 个文件 / 25MB ZIP。） */
console.log('[4b] 预览编译器文件数上限');
const MAX_PREVIEW_FILES = 500;
let fileCount = 0;
let singleTooBig = 0;
let totalBytes = 0;
(function countFiles(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) countFiles(p);
    else {
      fileCount++;
      totalBytes += st.size;
      if (st.size > 2 * 1024 * 1024) {
        fail(`${rel(p)} 单文件超过预览编译器 2MB 上限`);
        singleTooBig++;
      }
    }
  }
})(root);
if (fileCount >= MAX_PREVIEW_FILES) {
  fail(`工程文件数 ${fileCount} 已达/超过预览编译器上限 ${MAX_PREVIEW_FILES} —— 预览会报「源文件超过 500 个」而打不开`);
} else {
  pass(`工程文件数 ${fileCount} < ${MAX_PREVIEW_FILES}（余量 ${MAX_PREVIEW_FILES - fileCount} 个）`);
}
if (totalBytes > 20 * 1024 * 1024) fail(`源码总大小 ${totalBytes}B 超过预览编译器 20MB 上限`);
else if (!singleTooBig) pass(`源码总大小 ${(totalBytes / 1024 / 1024).toFixed(2)}MB < 20MB`);


/* ---------- 4c. 预览模拟器缺失 API 的兜底 ----------
   预览用的 H5 模拟器只实现了 storage/toast/modal/路由/导航栏/request 等少数 API，
   wx.nextTick、wx.getRecorderManager、wx.createInnerAudioContext、wx.showLoading
   都不存在，直接调用会抛异常中断页面生命周期（预览里报黄条或不渲染）。 */
console.log('[4c] 预览 API 兜底');
const compatPath = path.join(root, 'utils', 'wx-compat.js');
const appJsSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
if (!fs.existsSync(compatPath)) {
  fail('缺少 utils/wx-compat.js —— 预览模拟器缺失的 wx API 没有兜底，页面会抛错');
} else if (!/require\(\s*['"]\.\/utils\/wx-compat['"]\s*\)/.test(appJsSource)) {
  fail('app.js 没有引入 utils/wx-compat（必须在最前面 require，早于任何页面代码）');
} else {
  pass('已装 wx API 兜底（nextTick / loading / 录音 / 音频在预览下安全降级）');
}

/* ---------- 4d. 每日动画（云托管视频） ----------
   视频必须托管到云存储，两个原因：
     ① 包内放不下 —— 主包余量不到 200KB，一段 mp4 就撑爆；
     ② <video> 播网络地址时，域名必须在微信后台「downloadFile 合法域名」里，
        而只有小程序固定网关域名（publicConfig.endpoint，发布链路会自动登记）
        满足条件。签名地址由 cloud.storage.createSignedUrl 产出，正好落在该域名上，
        自己拼 COS 地址真机会黑屏。
   另一个已踩过的坑：不能把上传目标写成 shared/_application/ —— 该目录只有
   应用管理员能写，普通登录用户上传会被 RLS 拒绝。必须用 sharedPath(uid, ...)。 */
console.log('[4d] 每日动画');
const dvPath = path.join(root, 'utils', 'dailyVideo.js');
if (!fs.existsSync(dvPath)) {
  fail('缺少 utils/dailyVideo.js');
} else {
  // 判定前先剥掉注释：注释里提到某个坏写法并不等于代码真的那么写了
  const src = fs
    .readFileSync(dvPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  if (src.includes('shared/_application') || /sharedPath\s*\(\s*['"]_application['"]/.test(src)) {
    fail('dailyVideo.js 往 shared/_application/ 上传 —— 该目录只有应用管理员能写，普通用户上传会被拒绝');
  }
  if (!/cloud\.storage\.sharedPath\(/.test(src)) {
    fail('dailyVideo.js 没有用 cloud.storage.sharedPath 组装对象路径');
  }
  if (!/cloud\.storage\s*\.\s*createSignedUrl/.test(src)) {
    fail('dailyVideo.js 没有用 cloud.storage.createSignedUrl 取播放地址（自己拼地址真机域名校验过不了）');
  }
  if (!/MAX_UPLOAD_BYTES/.test(src)) {
    fail('dailyVideo.js 缺少上传体积上限校验（大文件会撑爆内存）');
  } else {
    pass('上传走 shared/<uid>/（已登录用户可读）、播放地址现签、上传前有体积上限');
  }
}
let localVideo = 0;
(function findLocalVideo(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) findLocalVideo(p);
    else if (/\.(mp4|mov|m4v|avi|webm)$/i.test(name)) {
      fail(`包内存在视频文件 ${rel(p)} —— 视频必须放云存储，主包余量放不下`);
      localVideo++;
    }
  }
})(root);
if (!localVideo) pass('包内无本地视频文件');

/* ---------- 4e. SDK 能不能传二进制 ----------
   SDK 的 miniprogram fetch 原本硬拦截非字符串 body：
     throw new Error('createMiniProgramFetch: 暂不支持非字符串 body（ArrayBuffer/FormData 待补）。')
   而上传视频必须传 ArrayBuffer（wx.getFileSystemManager().readFile 读出来的二进制），
   所以不放开这条就永远传不上去，报错还指向 SDK 内部、很难联想。
   官方 dev 与 latest 都没修，只能本地打补丁 —— 补丁脚本 starwords-miniprogram-scripts/patch-sdk-body.cjs。
   重新生成 / 升级 SDK 后若忘了重打，上传会再次静默失败，所以在自检里固化。 */
console.log('[4e] SDK 二进制上传能力');
const sdkPath = path.join(root, 'lib', 'workbuddy-cloud-sdk.js');
if (!fs.existsSync(sdkPath)) {
  fail('缺少 lib/workbuddy-cloud-sdk.js');
} else {
  const sdkSrc = fs.readFileSync(sdkPath, 'utf8');
  const stillBlocked = sdkSrc.indexOf('\\u6682\\u4E0D\\u652F\\u6301\\u975E\\u5B57\\u7B26\\u4E32 body') !== -1;
  const hasPatch = sdkSrc.indexOf('requestBody=init.body;case 3:') !== -1;
  if (stillBlocked) {
    fail('SDK 仍在拦截非字符串 body —— 视频永远传不上去，请跑 node patch-sdk-body.cjs');
  } else if (!hasPatch) {
    fail('SDK 里找不到二进制 body 通道，补丁未应用或 SDK 结构已变，请跑 node patch-sdk-body.cjs');
  } else {
    pass('SDK 已放开 ArrayBuffer body（视频可走 wx.request 二进制上传）');
  }
}

// 代码用到的隐私接口必须同步写进隐私清单，否则真机调用直接失败
const privacyName = fs.readdirSync(root).find((n) => n.endsWith('.privacy.json'));
const allJsSource = jsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const privacyNeeds = [];
if (/wx\.chooseMessageFile/.test(allJsSource)) privacyNeeds.push('MessageFile');
if (/wx\.chooseMedia\b|wx\.chooseVideo|wx\.chooseImage/.test(allJsSource)) privacyNeeds.push('Album');
if (/RecorderManager|wx\.startRecord/.test(allJsSource)) privacyNeeds.push('Record');
if (privacyNeeds.length === 0) {
  pass('未使用隐私接口');
} else if (!privacyName) {
  fail('包内没有隐私清单文件');
} else {
  const keys = JSON.parse(fs.readFileSync(path.join(root, privacyName), 'utf8')).map((o) => Object.keys(o)[0]);
  const missing = privacyNeeds.filter((k) => keys.indexOf(k) === -1);
  if (missing.length) fail(`代码调用了需要「${missing.join('/')}」的隐私接口，但隐私清单未声明`);
  else pass(`隐私清单已声明 ${privacyNeeds.join(' / ')}`);
}

/* ---------- 4f. 分享能力（转发给好友 / 分享到朋友圈）----------
   微信要求页面实现 onShareAppMessage / onShareTimeline 才会启用转发入口；
   本项目在 app.js 用 Page 包装器统一注入（实现放在 utils/share.js）。
   静态只能确认「代码写对了」；运行时行为另跑 `node share-runtime-check.cjs` 验证。
   ⚠️ 账号侧还需【微信认证】+【ICP 备案】，否则微信会限制「被分享 / 被搜索」能力 ——
      这时按钮照样是灰的，代码改不了，只能去小程序后台处理。 */
console.log('[4f] 分享能力');
const sharePath = path.join(root, 'utils', 'share.js');
const appSrc = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
if (!fs.existsSync(sharePath)) {
  fail('缺少 utils/share.js（转发 / 朋友圈分享配置）');
} else if (appSrc.indexOf('Page = function') === -1 || appSrc.indexOf('share.attach(') === -1) {
  fail('app.js 未通过 Page 包装器给页面注入分享能力');
} else if (fs.readFileSync(sharePath, 'utf8').indexOf('onShareAppMessage') === -1) {
  fail('utils/share.js 未定义 onShareAppMessage');
} else {
  pass('所有页面已注入转发 / 朋友圈分享能力（账号侧仍需认证 + 备案）');
}

/* ---------- 4g. 跟读星级（界面只给星星，不给分数）----------
   跟读结果四档：>60 分 3 星、>40 分 2 星、>30 分 1 星、其余 0 星（严格大于）。
   30 分是"完全没听到声音"的专属分数 → 0 星。
   分数被 clamp 在 45~96，所以「真开口读了」至少 2 星；1 星给"读太短没读完"，0 星给"没出声"。
   行为验证另跑 `node record-score-check.cjs`（合成波形，8 种情况 + 边界）。 */
console.log('[4g] 跟读星级');
const recPath = path.join(root, 'utils', 'record-score.js');
if (!fs.existsSync(recPath)) {
  fail('缺少 utils/record-score.js');
} else {
  const rec = fs.readFileSync(recPath, 'utf8');
  if (!/function starsFor\s*\(/.test(rec)) {
    fail('record-score.js 缺少 starsFor()：分数 → 星级换算');
  } else if (
    !/>\s*60\s*\)\s*return 3/.test(rec) ||
    !/>\s*40\s*\)\s*return 2/.test(rec) ||
    !/>\s*30\s*\)\s*return 1/.test(rec)
  ) {
    fail('星级阈值被改动：约定为 >60 → 3 星、>40 → 2 星、>30 → 1 星、其余 0 星');
  } else if (rec.indexOf('starCount') === -1) {
    fail('record-score.js 未返回 starCount（界面拿不到星级）');
  } else if (!/starCount:\s*0/.test(rec) || !/level:\s*'none'/.test(rec)) {
    fail('「完全没听到声音」未映射到 0 星（应返回 starCount: 0 / level: none）');
  } else {
    pass('星级换算 3/2/1/0 = >60 / >40 / >30 / 其余（严格大于）');
  }

  const learnWxml = fs.readFileSync(path.join(root, 'pages', 'learn', 'learn.wxml'), 'utf8');
  if (learnWxml.indexOf('stars-row') === -1) {
    fail('learn.wxml 未渲染三颗星');
  } else if (/\{\{\s*autoScore\s*\}\}/.test(learnWxml)) {
    fail('learn.wxml 仍在显示分数（约定只显示星星）');
  } else if (learnWxml.indexOf('autoStarCount') === -1) {
    fail('learn.wxml 未使用 autoStarCount');
  } else if (!/recorded && autoLevel/.test(learnWxml)) {
    // 0 星也要出反馈，所以判 autoLevel 而不是 autoStarCount > 0
    fail('learn.wxml 的评分卡片条件不是 autoLevel：0 星时反馈会整块消失');
  } else {
    pass('跟读反馈只显示 3 颗星 + 鼓励语（含 0 星）');
  }
}

/* ---------- 4h. 配对闯关（学完当天 5 词后的第 4 步）----------
   出题逻辑在 utils/match.js；那条「右列不能等于左列原序」的硬约束
   由 `node match-check.cjs`（25 项）行为验证，这里只固化接线别被拆掉。 */
console.log('[4h] 配对闯关');
const matchPath = path.join(root, 'utils', 'match.js');
if (!fs.existsSync(matchPath)) {
  fail('缺少 utils/match.js（配对出题逻辑）');
} else {
  const mjs = fs.readFileSync(matchPath, 'utf8');
  if (!/buildPuzzle/.test(mjs) || !/isMatch/.test(mjs)) {
    fail('utils/match.js 未导出 buildPuzzle / isMatch');
  } else if (!/module\.exports/.test(mjs)) {
    fail('utils/match.js 缺少 module.exports');
  } else {
    pass('utils/match.js 提供 buildPuzzle / isMatch');
  }

  const learnJs2 = fs.readFileSync(path.join(root, 'pages', 'learn', 'learn.js'), 'utf8');
  if (!/require\('\.\.\/\.\.\/utils\/match'\)/.test(learnJs2)) {
    fail('learn.js 未引入 utils/match');
  } else if (
    learnJs2.indexOf('startMatch(') === -1 ||
    learnJs2.indexOf('tryMatch(') === -1 ||
    learnJs2.indexOf('onMatchFinish(') === -1
  ) {
    fail('learn.js 缺少配对方法（startMatch / tryMatch / onMatchFinish）');
  } else if (learnJs2.indexOf('clearMatchTimer(') === -1) {
    fail('learn.js 缺少 clearMatchTimer（页面卸载后定时器仍会 setData）');
  } else {
    pass('learn.js 已接入配对流程（含定时器清理）');
  }

  const learnWxml2 = fs.readFileSync(path.join(root, 'pages', 'learn', 'learn.wxml'), 'utf8');
  if (learnWxml2.indexOf('match-board') === -1) {
    fail('learn.wxml 缺少配对棋盘（match-board）');
  } else if (learnWxml2.indexOf('onPickMatchLeft') === -1 || learnWxml2.indexOf('onPickMatchRight') === -1) {
    fail('learn.wxml 缺少配对点击绑定（onPickMatchLeft / onPickMatchRight）');
  } else if (!/step === 4/.test(learnWxml2)) {
    fail('learn.wxml 未按 step === 4 渲染配对卡片');
  } else if (/第 \{\{step\}\}\/3 步/.test(learnWxml2)) {
    // 第 5 个词有 4 步，硬编码 /3 会让步数显示不对
    fail('learn.wxml 步数标签仍是硬编码 /3（应使用 maxStep）');
  } else if (learnWxml2.indexOf('{{step}}/{{maxStep}}') === -1) {
    fail('learn.wxml 步数标签未使用 maxStep');
  } else {
    pass('配对棋盘渲染正确，步数标签已动态化（maxStep）');
  }
}

/* ---------- 4i. WXML 标签平衡（不平衡 = 页面白屏，且平台预览只编译入口页，抓不到）----------
   ⚠️ preview-compile 只编译入口页 index，**不会编译其它页面的 wxml** ——
   所以 learn/mine/... 的 wxml 写坏了，编译照样报 ready，真机点进去才白屏。
   这里对所有页面做一次标签配对检查兜住。 */
console.log('[4i] WXML 标签平衡');
{
  // WXML 里这些标签是自闭合语义，不参与配对
  const VOID_TAGS = ['image', 'input', 'import', 'include', 'wxs', 'icon', 'slot'];
  const wxmlFiles = [];
  (function collect(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) collect(p);
      else if (name.endsWith('.wxml')) wxmlFiles.push(p);
    }
  })(root);

  let structuralError = null;
  for (const file of wxmlFiles) {
    const src = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const stack = [];
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    let m;
    let err = null;
    while ((m = re.exec(src))) {
      const isClose = m[1] === '/';
      const tag = m[2];
      const isSelf = m[4] === '/';
      if (isClose) {
        const top = stack.pop();
        if (top !== tag) {
          err = `</${tag}> 与 <${top || '(空)'}> 不匹配（偏移 ${m.index}）`;
          break;
        }
      } else if (!isSelf && VOID_TAGS.indexOf(tag) === -1) {
        stack.push(tag);
      }
    }
    if (!err && stack.length) err = '未闭合：' + stack.join(' > ');
    if (err) {
      fail(`${rel(file)} 标签不平衡 → ${err}`);
      structuralError = true;
    }
  }
  if (!structuralError) pass(`${wxmlFiles.length} 个 wxml 标签全部平衡`);
}

/* ---------- 5. wxml 事件处理函数都有定义 ---------- */
console.log('[5] 事件处理函数');
let missingHandler = 0;
for (const pg of app.pages) {
  const wxml = fs.readFileSync(path.join(root, pg + '.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(root, pg + '.js'), 'utf8');
  for (const m of wxml.matchAll(/bind\w+="(\w+)"/g)) {
    if (!new RegExp('(^|[\\s,{])' + m[1] + '\\s*\\(').test(js)) {
      fail(`${rel(path.join(root, pg + '.js'))} 缺少处理函数 ${m[1]}`);
      missingHandler++;
    }
  }
}
if (!missingHandler) pass('wxml 中所有 bind* 处理函数均已定义');

/* ---------- 6. JSON 可解析 + 关键配置 ---------- */
console.log('[6] 配置');
const jsonFiles = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'scripts') continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.json')) jsonFiles.push(p);
  }
})(root);
for (const f of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    fail(`${rel(f)} JSON 解析失败：${e.message}`);
  }
}
pass(`${jsonFiles.length} 个 JSON 文件可解析`);
if (app.lazyCodeLoading !== 'requiredComponents') fail('lazyCodeLoading 未设为 requiredComponents');
else pass('lazyCodeLoading = requiredComponents');

/* ---------- 7. 包体积（双口径计量：KiB 与十进制 KB 都必须过） ---------- */
console.log('[7] 包体积');
const packCfg = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
const ignored = ((packCfg.packOptions && packCfg.packOptions.ignore) || [])
  .filter((i) => i.type === 'folder')
  .map((i) => i.value.replace(/^\.?\//, '').replace(/\/$/, ''));
// 开发脚本目录必须物理移出小程序包（构建链路未必尊重 packOptions.ignore）
for (const bannedDir of ['scripts', 'node_modules', 'miniprogram_npm']) {
  if (fs.existsSync(path.join(root, bannedDir))) {
    fail(`包内存在 ${bannedDir}/ 目录 —— 构建链路可能不读 packOptions.ignore，必须物理移出`);
  }
}
let mainPkg = 0;
let subPkg = 0;
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const r = rel(p);
    if (ignored.some((ig) => r === ig || r.startsWith(ig + '/'))) continue;
    if (subs.some((s) => s.root.replace(/\/$/, '') === r)) {
      subPkg += sizeOf(p);
      continue;
    }
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else mainPkg += st.size;
  }
})(root);

const kb = Math.round(mainPkg / 1024);
if (mainPkg > 2048 * 1024) fail(`主包 ${kb}KiB 超过微信 2MiB 限制`);
else if (mainPkg > 2000000) fail(`主包 ${kb}KiB(${mainPkg}B) 超过十进制 2MB(2000000B) —— 部分构建链路按此口径`);
else pass(`主包 ${kb}KiB / ${Math.round(mainPkg / 1000)}KB(十进制)（双口径均 < 2MB，余量 ${2000000 - mainPkg}B）`);
for (const s of subs) {
  const dir = path.join(root, s.root);
  if (!fs.existsSync(dir)) continue;
  const size = Math.round(sizeOf(dir) / 1024);
  if (size > 2048) fail(`分包 ${s.root} ${size}KB 超过 2MB 限制`);
  else pass(`分包 ${s.root} ${size}KB（< 2048KB）`);
}
if (kb + Math.round(subPkg / 1024) > 20480) fail('总包超过 20MB 限制');

/* ---------- 8. 发布前置：禁忌文件与临时产物 ---------- */
console.log('[8] 发布前置');
for (const banned of ['node_modules', 'package.json', 'package-lock.json', 'miniprogram_npm']) {
  if (fs.existsSync(path.join(root, banned))) {
    fail(`存在 ${banned}，会导致发布「依赖构建失败」，必须删除`);
  }
}
// 中间产物（如 TTS 原始音频）一旦留在包内会把体积撑爆
(function findTemp(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      if (/^_|^tmp|\.tmp$/i.test(name)) fail(`存在临时目录 ${rel(p)}，请清理后再交付`);
      findTemp(p);
    }
  }
})(root);
pass('无 node_modules / package.json / miniprogram_npm / 临时产物');

console.log(failed === 0 ? '\n全部检查通过 ✓' : `\n${failed} 项未通过 ✗`);
process.exit(failed === 0 ? 0 : 1);
