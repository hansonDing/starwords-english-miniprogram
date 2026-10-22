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

// 音频已包化：400 个单文件 → 40+40 个周包（gen-audio-packs.py → utils/audioPackMap.js）。
// words.js 的 audio / phraseAudio 现在是「词条 id」，不再是页面相对路径 —— 所以这里
// 不再查单文件存在性，改为查「id 能在映射表里找到段」+「段所在的周包存在」。
// ⚠️ 两份映射表键完全相同（都是词条 id），单词段在 SEG、例句段在 PSEG，查错表会「假绿」。
const mapMod = { exports: {} };
new Function('module', 'exports', 'require', fs.readFileSync(path.join(root, 'utils', 'audioPackMap.js'), 'utf8'))(
  mapMod,
  mapMod.exports,
  () => {
    throw new Error('audioPackMap.js 不应有外部依赖');
  }
);
const SEG = (mapMod.exports && mapMod.exports.SEG) || {};
const PSEG = (mapMod.exports && mapMod.exports.PSEG) || {};
const neededPacks = new Set();

const stepX = 100 / SPRITE.cols;
const stepY = 100 / SPRITE.rows;
for (const w of WORDS) {
  if (!w.audio || !w.phraseAudio) {
    fail(`${w.id} 资源字段为空`);
    bad++;
    continue;
  }
  if (w.audio.startsWith('/') || w.phraseAudio.startsWith('/')) {
    fail(`${w.id} 的音频字段应是词条 id，不应是路径（${w.audio} / ${w.phraseAudio}）`);
    bad++;
  }
  for (const [label, id, table] of [
    ['单词', w.audio, SEG],
    ['例句', w.phraseAudio, PSEG],
  ]) {
    const seg = table[id];
    if (!seg) {
      fail(`${w.id} ${label}音频段未登记在映射表里：${id}（改过词库后要先重跑 gen-audio-packs.py）`);
      bad++;
      continue;
    }
    neededPacks.add(seg.p);
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
// 段声明的周包必须真的存在 —— 映射表与 assets 不同步时，真机表现是「静默无声」
for (const p of neededPacks) {
  const dir = p.slice(0, 2) === 'wp' ? 'assets/audio' : 'assets/phrases';
  if (!fs.existsSync(path.resolve(root, dir, p + '.mp3'))) {
    fail(`周包缺失 ${dir}/${p}.mp3 —— 映射表与 assets 不同步，请重跑 gen-audio-packs.py`);
    bad++;
  }
}
if (!failed) pass(`200 个词条的单词/例句音频段均已登记，${neededPacks.size} 个周包齐备`);

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

/* ---------- 4j. 星星账户（跟读星星累计 + 每词只记一次最好成绩）----------
   规则：每个单词只记一次、取最好成绩；账户余额 progress.stars 只增不减地累积。
   坏掉是静默的（数字不对但界面正常），行为验证另跑 `node stars-check.cjs`。 */
console.log('[4j] 星星账户');
{
  const storeSrc = fs.readFileSync(path.join(root, 'utils', 'store.js'), 'utf8');
  const schedSrc = fs.readFileSync(path.join(root, 'utils', 'scheduler.js'), 'utf8');
  const learnSrc = fs.readFileSync(path.join(root, 'pages', 'learn', 'learn.js'), 'utf8');
  const mineWxml = fs.readFileSync(path.join(root, 'pages', 'mine', 'mine.wxml'), 'utf8');

  // ⚠️ 别改回 `DEFAULT_PROGRESS[\s\S]{0,600}?stars:0` 那种「窗口 + 距离」写法 ——
  // 字段上方一加注释就会把 stars 挤出窗口，误报「缺少 stars 字段」。
  // 正确做法：先把 DEFAULT_PROGRESS 的块抠出来，再在块内找字段。
  const defaultBlock = (storeSrc.match(/DEFAULT_PROGRESS = \{[\s\S]*?\n\};/) || [''])[0];
  if (!/stars:\s*0/.test(defaultBlock)) {
    fail('store.js 的 DEFAULT_PROGRESS 缺少 stars 字段（账户余额）');
  } else if (!/function creditStars\s*\(/.test(storeSrc) || !/function getStarBalance\s*\(/.test(storeSrc)) {
    fail('store.js 缺少 creditStars() / getStarBalance()');
  } else if (storeSrc.indexOf('creditStars,') === -1 || storeSrc.indexOf('getStarBalance,') === -1) {
    fail('store.js 未导出 creditStars / getStarBalance');
  } else if (!/credited/.test(storeSrc) || !/stars:\s*\(prev\.stars \|\| 0\) \+ gained/.test(storeSrc)) {
    fail('creditStars 未按「只补差额」实现（同一个词会被重复计星）');
  } else if (!/stars:\s*wp\.stars \|\| 0/.test(schedSrc)) {
    fail('scheduler.applyReviewResult 未透传 stars（复习一次就会把去重依据丢掉）');
  } else {
    const mi = learnSrc.indexOf('store.markWordLearned(');
    const ci = learnSrc.indexOf('store.creditStars(');
    if (mi === -1 || ci === -1) {
      fail('learn.js 未在学完一个词时结算星星（store.creditStars）');
    } else if (ci < mi) {
      fail('learn.js 的 creditStars 必须在 markWordLearned **之后**调用（账本需要词条已存在）');
    } else if (mineWxml.indexOf('{{stars}}') === -1) {
      fail('mine.wxml 未展示星星总数');
    } else {
      pass('星星账本接线正确（只补差额 / 先建词条再计星 / 我的页展示）');
    }
  }
}

/* ---------- 4k. 复习页：错题本 + 学习记录分页 ---------- */
console.log('[4k] 复习错题本与记录分页');
{
  const reviewSrc = fs.readFileSync(path.join(root, 'pages', 'review', 'review.js'), 'utf8');
  const reviewWxml = fs.readFileSync(path.join(root, 'pages', 'review', 'review.wxml'), 'utf8');

  if (reviewSrc.indexOf('wrongList') === -1) {
    fail('review.js 未构建错题列表（wrongList）');
  } else if (reviewSrc.indexOf('onLoadMoreRecords') === -1) {
    fail('review.js 缺少 onLoadMoreRecords()');
  } else if (/\.slice\(0,\s*12\)/.test(reviewSrc)) {
    fail('review.js 仍在截断学习记录为 12 条（应显示全部 + 分页）');
  } else if (!/recordsTotal/.test(reviewSrc) || !/recordsHasMore/.test(reviewSrc)) {
    fail('review.js 缺少分页状态 recordsTotal / recordsHasMore');
  } else if (reviewWxml.indexOf('wrongList') === -1) {
    fail('review.wxml 未渲染错题列表');
  } else if (reviewWxml.indexOf('onLoadMoreRecords') === -1 || reviewWxml.indexOf('recordsHasMore') === -1) {
    fail('review.wxml 未渲染「加载更多」按钮');
  } else {
    pass('错题本（含答案）+ 学习记录全量分页 接线正确');
  }
}

/* ---------- 4l. PK 挑战（发起 → 站内通知 → 作答 → 本地入账 → 回传）----------
   这里锁几处**静默坏掉**的地方（界面都正常，只是功能不生效或白丢东西）：
     ① 结算顺序 —— store.creditPkStars 必须在 pkCloud.submitResult **之前**。
        反过来的话网络一挂，孩子明明答完了却拿不到星星（而界面照样显示成绩）。
     ② 站内通知 —— pk-create 生成挑战后要走「发送挑战」按钮，并把未读状态落库；
        mine / index 要查询我收到的未读挑战；pk-play 加载成功后要 markRead。
   行为验证另跑 `node pk-check.cjs` 与 `node pk-runtime-check.cjs`。 */
console.log('[4l] PK 挑战');
{
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const pkSrc = read('utils/pk.js');
  const cloudSrc = read('utils/pkCloud.js');
  const storeSrc = read('utils/store.js');
  const createSrc = read('pages/pk-create/pk-create.js');
  const createWxml = read('pages/pk-create/pk-create.wxml');
  const playSrc = read('pages/pk-play/pk-play.js');
  const playWxml = read('pages/pk-play/pk-play.wxml');
  const mineSrc = read('pages/mine/mine.js');
  const mineWxml = read('pages/mine/mine.wxml');
  const indexSrc = read('pages/index/index.js');

  const missingPk = ['buildQuestions', 'scoreQuiz', 'makeChallengeId', 'isPlayable'].filter(
    (n) => pkSrc.indexOf(n) === -1
  );
  const missingCloud = ['function create', 'function fetch', 'function submitResult', 'function listMine', 'function listIncoming', 'function markRead', 'function remove'].filter(
    (n) => cloudSrc.indexOf(n) === -1
  );
  // ⚠️ 顺序检查必须只看 finish() **方法体内部**：
  //    `pkCloud.submitResult(` 在 submitResult() 的方法定义里也出现一次，而那个定义
  //    永远排在 finish() 之后 —— 拿全文件的首次命中去比较的话，
  //    「把本地入账挪到回传之后」这个变异根本不会被发现（变异测试实测过）。
  const finStart = playSrc.indexOf('finish() {');
  let finEnd = finStart === -1 ? 0 : playSrc.indexOf('\n  },', finStart);
  if (finEnd === -1) finEnd = playSrc.length;
  const finBody = finStart === -1 ? '' : playSrc.slice(finStart, finEnd);
  const ci = finBody.search(/store\s*\.\s*creditPkStars\s*\(/);
  const si = finBody.search(/this\s*\.\s*submitResult\s*\(/);

  // 老 iOS 引擎解析不了的语法（与工程硬约束一致）
  const badSyntax = [];
  for (const f of ['utils/pk.js', 'utils/pkCloud.js', 'pages/pk-create/pk-create.js', 'pages/pk-play/pk-play.js', 'pages/mine/mine.js', 'pages/index/index.js']) {
    const src = read(f);
    if (/\?\./.test(src)) badSyntax.push(f + ' 用了可选链 ?.');
    if (/globalThis/.test(src)) badSyntax.push(f + ' 用了裸 globalThis');
    if (/\{\s*\.\.\./.test(src) || /\[\s*\.\.\./.test(src)) badSyntax.push(f + ' 用了展开语法');
  }

  // 删除策略的迁移 SQL：放在仓库的 cloudbase/migrations 下。
  // 读不到时不能直接抛（快照仓库 / 单独拷出 scripts 目录都会缺这个文件），
  // 收敛成空串让下面的断言给出可读的失败原因。
  let delPolicySql = '';
  try {
    delPolicySql = fs.readFileSync(
      path.join(root, '..', 'cloudbase', 'migrations', '20261022190000_add_pk_delete_policy.sql'),
      'utf8'
    );
  } catch (e) {
    delPolicySql = '';
  }

  if (missingPk.length) {
    fail('utils/pk.js 缺少：' + missingPk.join(' / '));
  } else if (missingCloud.length) {
    fail('utils/pkCloud.js 缺少：' + missingCloud.join(' / '));
  } else if (!/pkRewarded/.test(storeSrc) || storeSrc.indexOf('creditPkStars,') === -1) {
    fail('store.js 缺少 pkRewarded / creditPkStars（PK 星星账本与「每场只结算一次」防刷）');
  } else if (app.pages.indexOf('pages/pk-create/pk-create') === -1 || app.pages.indexOf('pages/pk-play/pk-play') === -1) {
    fail('app.json 未注册 pk-create / pk-play 页面');
  } else if (!/onSendChallenge\s*\(/.test(createSrc)) {
    fail('pk-create.js 缺少 onSendChallenge（指定对手时走站内发送）');
  } else if (!/hasTarget/.test(createSrc) || createWxml.indexOf('{{!hasTarget}}') === -1) {
    fail('pk-create 缺少「指定对手 / 开放式挑战」分叉（hasTarget 没接进模板）');
  } else if (createWxml.indexOf('open-type="share"') === -1) {
    fail('pk-create.wxml 缺少开放式挑战的 <button open-type="share">（「发起单词PK」要能转发给微信好友）');
  } else if (!/onShareAppMessage\s*\(/.test(createSrc) || createSrc.indexOf("'/pages/pk-play/pk-play?id='") === -1) {
    fail("pk-create.js 的 onShareAppMessage 未把开放式挑战的卡片指向 pk-play?id=<pkId>");
  } else if (!/mode:\s*'ready'/.test(createSrc) || !/wx:elif="\{\{mode === 'ready'\}\}"/.test(createWxml)) {
    fail('pk-create 缺少「先写云端拿到 pkId，再显示发送按钮」的状态机');
  } else if (indexSrc.indexOf('checkIncoming') === -1) {
    fail('index.js 未在首页检查未读挑战（checkIncoming）');
  } else if (mineSrc.indexOf('loadIncoming') === -1 || mineWxml.indexOf('incoming-card') === -1) {
    fail('mine 页缺少「新的挑战」未读通知区块');
  } else if (playSrc.indexOf('pkCloud.markRead') === -1) {
    fail('pk-play.js 未在加载成功后调用 pkCloud.markRead（未读提示无法消除）');
  } else if (playWxml.indexOf('bolt') === -1 || playWxml.indexOf('dark') === -1) {
    fail('pk-play.wxml 缺少答错反馈（闪电 bolt / 小人变黑 dark）');
  } else if (ci === -1 || si === -1) {
    fail('pk-play.js 的 finish() 未接入结算（缺少 store.creditPkStars 或 this.submitResult）');
  } else if (ci > si) {
    fail('pk-play.js 结算顺序反了：必须先 creditPkStars（本地入账）再 submitResult（回传）—— 否则断网时孩子答完拿不到星星');
  } else if (playSrc.indexOf('clearTimeout(this.answerTimer)') === -1) {
    fail('pk-play.js 未在 onUnload 清理 answerTimer（卸载后 setData 会报错）');
  } else if (mineWxml.indexOf('onChallenge') === -1 || mineSrc.indexOf('onChallenge') === -1) {
    fail('mine 页缺少「挑战」入口（排行榜 → 发起 PK）');
  } else if (mineWxml.indexOf('pkList') === -1 || mineSrc.indexOf('listMine') === -1) {
    fail('mine 页未展示「我发起的 PK」结果列表');
  } else if (cloudSrc.indexOf(".from('pk_challenges')\n    .delete()") === -1 && !/from\('pk_challenges'\)[\s\S]{0,80}\.delete\(\)/.test(cloudSrc)) {
    fail('pkCloud.remove 没有真正走 .delete()（只改本地列表的话，下拉/换设备会复活）');
  } else if (!/challenger_id\s*=\s*auth\.uid\(\)/.test(delPolicySql)) {
    fail('缺少 DELETE 策略迁移（cloudbase/migrations/20261022190000_add_pk_delete_policy.sql）：没有 delete 策略时，前端删除会被 RLS 静默挡掉');
  } else if (mineWxml.indexOf('wx:for="{{pkShown}}"') === -1 || mineSrc.indexOf('onTogglePkExpand') === -1) {
    fail('mine 页「我发起的 PK」未做折叠：wx:for 必须绑 pkShown（绑 pkList 等于无限向下堆）');
  } else if (mineWxml.indexOf('onDeletePk') === -1 || mineSrc.indexOf('onDeletePk') === -1) {
    fail('mine 页缺少手工删除入口（onDeletePk）');
  } else if (!/\.limit\(/.test(cloudSrc.slice(cloudSrc.indexOf('function listMine'), cloudSrc.indexOf('function listIncoming')))) {
    fail('listMine 少了 .limit() —— 会变成全量拉取');
  } else if (badSyntax.length) {
    fail('PK 相关文件含老引擎无法解析的语法：' + badSyntax.join('；'));
  } else {
    pass('PK 接线正确（出题 → 站内通知 → 作答 → 本地入账 → 回传，且站内通知闭环完整）');
  }
}

/* ---------- 4m. 星星形象（Avatar）----------
   锁四处**静默坏掉**的地方（界面全正常，只是形象错位 / 不显示 / 不变黑）：
     ① 精灵图常量三处必须一致：utils/avatar.js 的 SPRITE、gen-avatars.py、app.wxss 的 400%/200%。
        只改一处 → 真机上形象错位成「别的形象的边角」，零报错。
     ② 代码里的 LIST 必须与生成器写出的 avatar-map.json 逐条一致
        → 否则「选了蝴蝶结显示成花环」。
     ③ <image src> 必须写死字面量 → 平台预览只复制字面量引用的资源，用 {{}} 绑定必 404。
     ④ 变黑必须「滤镜 + 黑罩」双保险 → 只写 filter 的机型会静默失效（雷劈了人没黑）。
   另外：PNG 实际尺寸必须等于 cols*cell × rows*cell（读文件头，不是猜的）。
   行为验证另跑 `node avatar-check.cjs` 与 `node avatar-runtime-check.cjs`。 */
console.log('[4m] 星星形象');
{
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const has = (p) => fs.existsSync(path.join(root, p));
  const avatarSrc = has('utils/avatar.js') ? read('utils/avatar.js') : '';
  const appWxss = read('app.wxss');
  const storeSrc = read('utils/store.js');
  const playSrc = read('pages/pk-play/pk-play.js');
  const playWxml = read('pages/pk-play/pk-play.wxml');
  const playWxss = read('pages/pk-play/pk-play.wxss');
  const mineSrc = read('pages/mine/mine.js');
  const mineWxml = read('pages/mine/mine.wxml');
  const createSrc = read('pages/pk-create/pk-create.js');
  const cloudSrc = read('utils/pkCloud.js');
  const pageFiles = ['pages/avatar/avatar.js', 'pages/avatar/avatar.json', 'pages/avatar/avatar.wxml', 'pages/avatar/avatar.wxss'];
  const missingFiles = pageFiles.filter((p) => !has(p));

  const missingApi = ['SPRITE', 'LIST', 'GENDERS', 'DEFAULT_ID', 'findById', 'listByGender', 'normalizeId', 'tileOf', 'defaultTile'].filter(
    (n) => avatarSrc.indexOf(n) === -1
  );

  // 精灵图真实尺寸（PNG 的 IHDR：宽高在偏移 16 / 20，大端 32 位）
  let real = null;
  try {
    const buf = fs.readFileSync(path.join(root, 'assets/avatars.png'));
    real = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch (e) {
    real = null;
  }

  // 生成器写出的落位表 = 代码与美术之间的「合约」
  let map = null;
  try {
    map = JSON.parse(fs.readFileSync(path.join(__dirname, 'avatar-map.json'), 'utf8'));
  } catch (e) {
    map = null;
  }
  const mapIds = map && Array.isArray(map.list) ? map.list.map((x) => x.id) : [];
  const srcIds = (avatarSrc.match(/id: '((?:boy|girl)-\d+)'/g) || []).map((s) => s.replace(/[^']*'([^']+)'.*/, '$1'));

  // 取图常量（SPRITE）
  const sp = avatarSrc.match(/cols:\s*(\d+),\s*rows:\s*(\d+),\s*cell:\s*(\d+)/);
  const sprite = sp ? { cols: Number(sp[1]), rows: Number(sp[2]), cell: Number(sp[3]) } : null;

  // 生成器那份常量
  let pySrc = '';
  try {
    pySrc = fs.readFileSync(path.join(__dirname, 'gen-avatars.py'), 'utf8');
  } catch (e) {
    pySrc = '';
  }
  const pySp = pySrc.match(/CELL = (\d+)\s*\nCOLS = (\d+)\s*\nROWS = (\d+)/);
  const pySprite = pySp ? { cell: Number(pySp[1]), cols: Number(pySp[2]), rows: Number(pySp[3]) } : null;

  // app.wxss 的裁切容器与放大倍数
  const clipOk = /\.avatar-clip\s*\{[^}]*overflow:\s*hidden/.test(appWxss);
  const imgOk =
    /\.avatar-img\s*\{[^}]*width:\s*400%/.test(appWxss) && /\.avatar-img\s*\{[^}]*height:\s*200%/.test(appWxss);

  // ⚠️ 页面预览只复制**字面量**引用的资源：wxml 里出现几次 avatars.png，
  //    就必须有几个写成 src="../../assets/avatars.png"（用 {{}} 绑定的必 404）
  const wxmlAll = ['pages/avatar/avatar.wxml', 'pages/pk-play/pk-play.wxml', 'pages/mine/mine.wxml']
    .filter((p) => has(p))
    .map((p) => read(p))
    .join('\n');
  const pngMentions = (wxmlAll.match(/avatars\.png/g) || []).length;
  const pngLiterals = (wxmlAll.match(/src="\.\.\/\.\.\/assets\/avatars\.png"/g) || []).length;

  // 老 iOS 引擎解析不了的语法（与工程硬约束一致）
  const badSyntax = [];
  for (const f of ['utils/avatar.js', 'pages/avatar/avatar.js']) {
    if (!has(f)) continue;
    const src = read(f);
    if (/\?\./.test(src)) badSyntax.push(f + ' 用了可选链 ?.');
    if (/globalThis/.test(src)) badSyntax.push(f + ' 用了裸 globalThis');
    if (/\{\s*\.\.\./.test(src) || /\[\s*\.\.\./.test(src)) badSyntax.push(f + ' 用了展开语法');
  }

  if (missingFiles.length) {
    fail('形象页四件套缺文件：' + missingFiles.join(' / ') + '（缺 .json 会让真机白屏）');
  } else if (missingApi.length) {
    fail('utils/avatar.js 缺少：' + missingApi.join(' / '));
  } else if (!sprite) {
    fail('utils/avatar.js 的 SPRITE 常量解析不出来（格式应为 cols: 4, rows: 2, cell: 192）');
  } else if (!real) {
    fail('assets/avatars.png 不存在或读不出尺寸（形象图必须随包发布）');
  } else if (real.width !== sprite.cols * sprite.cell || real.height !== sprite.rows * sprite.cell) {
    fail(
      'avatars.png 实际尺寸 ' + real.width + '×' + real.height + ' 与 SPRITE(' + sprite.cols + '×' + sprite.rows + ' 格 @' + sprite.cell + 'px) 不符 —— 取图会整体错位'
    );
  } else if (!pySprite || pySprite.cols !== sprite.cols || pySprite.rows !== sprite.rows || pySprite.cell !== sprite.cell) {
    fail('gen-avatars.py 的 COLS/ROWS/CELL 与 utils/avatar.js 的 SPRITE 不一致（两张图会长得不一样）');
  } else if (!clipOk || !imgOk) {
    fail('app.wxss 缺少 .avatar-clip{overflow:hidden} 或 .avatar-img 的 400%/200%（取图会错位）');
  } else if (!map || mapIds.length !== 8) {
    fail('avatar-map.json 缺失或不是 8 个形象（生成器产出，代码靠它对齐落位）');
  } else if (srcIds.join(',') !== mapIds.join(',')) {
    fail('utils/avatar.js 的 LIST 与 avatar-map.json 不一致：代码 ' + srcIds.join(',') + ' / 美术 ' + mapIds.join(','));
  } else if (avatarSrc.indexOf('migrateId') === -1 || storeSrc.indexOf('avatar.migrateId(') === -1) {
    fail('缺少 migrateId（老存档 girl-6 → girl-1 的同性别兜底）—— 女孩会突然变成男孩');
  } else if (pngMentions !== pngLiterals || pngLiterals < 4) {
    fail(
      'wxml 里的 avatars.png 必须全部写成字面量 src（共 ' + pngLiterals + ' 处字面量 / ' + pngMentions + ' 处引用）—— 平台预览只复制字面量引用的资源'
    );
  } else if (!/avatarId/.test(storeSrc) || storeSrc.indexOf('getAvatar,') === -1 || storeSrc.indexOf('setAvatar,') === -1) {
    fail('store.js 缺少 avatarId / getAvatar / hasAvatar / setAvatar（形象存取）');
  } else if (app.pages.indexOf('pages/avatar/avatar') === -1) {
    fail('app.json 未注册 pages/avatar/avatar');
  } else if (playSrc.indexOf('store.getAvatar()') === -1 || playSrc.indexOf('ch.challenger_avatar') === -1) {
    fail('pk-play.js 未把「自己 / 出题者」的形象读出来（舞台与结算的对战双方）');
  } else if (playWxml.indexOf('{{av.tx}}') === -1 || playWxml.indexOf('{{pkAv.tx}}') === -1) {
    fail('pk-play.wxml 未用形象取图坐标（舞台 / 结算 VS）');
  } else if (playWxml.indexOf('figureDark') === -1 || playWxml.indexOf('class="darken"') === -1) {
    fail('pk-play.wxml 缺少答错变黑（figureDark + 黑罩 darken）');
  } else if (!/\.figure-wrap\.dark\s+\.avatar-img\s*\{[^}]*filter/.test(playWxss)) {
    fail('pk-play.wxss 缺少 .figure-wrap.dark .avatar-img { filter: ... }（变黑的兜底之一）');
  } else if (createSrc.indexOf('challengerAvatar') === -1 || cloudSrc.indexOf('challenger_avatar') === -1) {
    fail('pk-create / pkCloud 未把出题者形象写进挑战行（结算页的「对方」会没有形象）');
  } else if (mineWxml.indexOf('onEditAvatar') === -1 || mineSrc.indexOf('onEditAvatar') === -1) {
    fail('mine 页缺少「我的形象」入口（选完就再也改不了了）');
  } else if (mineSrc.indexOf('!store.hasAvatar()') === -1 || mineSrc.indexOf('/pages/avatar/avatar?from=login') === -1) {
    fail('mine 页缺少「登录成功后引导选形象」（且必须只在登录动作里触发，不能 onShow 轮询）');
  } else if (badSyntax.length) {
    fail('形象相关文件含老引擎无法解析的语法：' + badSyntax.join('；'));
  } else {
    pass('形象接线正确（精灵图 ' + sprite.cols + '×' + sprite.rows + '@' + sprite.cell + '，8 个拟人形象，取图常量三处一致，老 id 可迁移）');
  }
}

/* ---------- 4n. 学习结算页（静态，无庆祝动画） ----------
   做了什么：孩子学完当天 5 词 + 配对闯关后，不再演三幕动画（原来要等 5.4 秒），
   直接进静态结算页。
   为什么单独守一道：删动画是「减法」，最容易做一半 —— 数据字段删了但 wxml 还引用，
   或 wxss 样式留着、代码里又被人加回 setTimeout。这类残留**不报错**，
   只是又白等 5 秒，肉眼很容易忽略。行为验证另跑 `node match-runtime-check.cjs`。 */
console.log('[4n] 学习结算页（静态，无庆祝动画）');
{
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const learnJs = read('pages/learn/learn.js');
  const learnWxml = read('pages/learn/learn.wxml');
  const learnWxss = read('pages/learn/learn.wxss');

  const gone = [
    'rewardStage',
    'rewardWords',
    'rewardTimers',
    'buildConfetti',
    'clearRewardTimers',
    'startRewardShow',
    'onSkipReward',
    'celebrate',
    'confetti',
    'mascot',
    'parade',
  ];
  const leftJs = gone.filter((k) => learnJs.indexOf(k) !== -1);
  const leftWxml = gone.filter((k) => learnWxml.indexOf(k) !== -1);
  const leftWxss = gone.filter((k) => learnWxss.indexOf(k) !== -1);

  // 结算区样式里一点动画都不许有（含 @keyframes），否则「去掉动画」只做了半截
  const from = learnWxss.indexOf('结算页（静态，零动画）');
  const to = learnWxss.indexOf('Step 4');
  const doneCss = from !== -1 && to > from ? learnWxss.slice(from, to) : '';
  const animated = /animation\s*:|@keyframes/.test(doneCss);

  // 结算页里的单词图必须是**字面量** src（平台预览只复制字面量引用的资源）
  const literalSprite = (learnWxml.match(/src="\.\.\/\.\.\/assets\/sprite\.jpg"/g) || []).length;

  if (leftJs.length) {
    fail('learn.js 还残留庆祝动画代码：' + leftJs.join(' / '));
  } else if (leftWxml.length) {
    fail('learn.wxml 还残留庆祝动画：' + leftWxml.join(' / '));
  } else if (leftWxss.length) {
    fail('learn.wxss 还残留庆祝动画样式：' + leftWxss.join(' / '));
  } else if (learnJs.indexOf('enterDone') === -1) {
    fail('learn.js 缺少 enterDone()（学完 5 词的结算入口）');
  } else if (learnWxml.indexOf("phase === 'done'") === -1) {
    fail("learn.wxml 缺少 phase === 'done' 的结算块");
  } else if (learnWxml.indexOf('doneWords') === -1) {
    fail('learn.wxml 未渲染 doneWords（今天学会的单词清单没了）');
  } else if (learnWxml.indexOf('看奖励动画') !== -1) {
    fail('配对按钮文案还写着「看奖励动画」（动画已经删了）');
  } else if (!doneCss) {
    fail('learn.wxss 找不到结算区样式（.done-page 一带的注释标记）');
  } else if (animated) {
    fail('结算区仍含 animation / @keyframes —— 动画只删了一半');
  } else if (literalSprite < 2) {
    fail(
      'learn.wxml 的 sprite.jpg 字面量引用只剩 ' +
        literalSprite +
        ' 处（结算页的单词图也要写成 src="../../assets/sprite.jpg"）'
    );
  } else {
    pass('结算页为纯静态（无庆祝代码残留 / 无动画 / 无定时器）');
  }
}

/* ---------- 4o. 交互去重（重复触发类的静默 bug）----------
 * 两个都只在「用户多点一下 / 多回一次」时才现形，预览走一遍根本碰不到：
 *   ① 首页 onShow 每次都查未读挑战 → 同一个弹窗反复弹，而「稍后」什么都不做。
 *   ② 复习页重复点当前 tab → 整套题被重置，但复习档位已经推进过了。
 */
console.log('[4o] 交互去重');
{
  const idxSrc = fs.readFileSync(path.join(root, 'pages', 'index', 'index.js'), 'utf8');
  const revSrc = fs.readFileSync(path.join(root, 'pages', 'review', 'review.js'), 'utf8');
  if (idxSrc.indexOf('__pk_prompted') === -1 || !/getStorageSync\(PROMPT_KEY\)/.test(idxSrc)) {
    fail('index.js 未记录「已弹过的挑战 id」，同一个「新的挑战」弹窗会每次回首页都重弹');
  } else if (!/if\s*\(mode\s*===\s*this\.data\.mode\)\s*return/.test(revSrc)) {
    fail('review.js 的 onModeChange 没有「重复点当前 tab 直接返回」，会把答到一半的题重置掉');
  } else {
    pass('首页挑战弹窗 / 复习 tab 切换都做了重复触发保护');
  }
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

/* ---------- 5b. 页面路由 ----------
 * 这类 bug 只在点了按钮那一刻炸（switchTab 到非 tab 页 → 静默失败；
 * navigateTo 到 tab 页 → 直接报错），预览未必走到那条分支 → 必须静态拦。
 * ⚠️ 只扫 pages/ 与 utils/：lib/ 里的云 SDK 是压缩产物，含同名 API 字样会误报。
 */
console.log('[5b] 页面路由');
const tabPaths = ((app.tabBar && app.tabBar.list) || []).map((t) => t.pagePath);
const toRoute = (u) => u.split('?')[0].replace(/^\//, '');
let routeBad = 0;
let routeSeen = 0;
const routeFiles = [];
for (const dir of ['pages', 'utils']) {
  (function walkRoute(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walkRoute(p);
      else if (name.endsWith('.js')) routeFiles.push(p);
    }
  })(path.join(root, dir));
}
for (const f of routeFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const where = rel(f);
  for (const m of src.matchAll(/wx\.(navigateTo|redirectTo|switchTab|reLaunch)\s*\(\s*\{[^}]*?url\s*:\s*['"]([^'"]+)['"]/g)) {
    const api = m[1];
    const route = toRoute(m[2]);
    routeSeen++;
    if (app.pages.indexOf(route) < 0) {
      fail(`${where} ${api} 指向未注册页面 ${route}`);
      routeBad++;
      continue;
    }
    const isTab = tabPaths.indexOf(route) >= 0;
    if (api === 'switchTab' && !isTab) {
      fail(`${where} switchTab 指向非 tabBar 页 ${route}（会静默失败，应改 navigateTo）`);
      routeBad++;
    }
    if ((api === 'navigateTo' || api === 'redirectTo') && isTab) {
      fail(`${where} ${api} 指向 tabBar 页 ${route}（会直接报错，应改 switchTab）`);
      routeBad++;
    }
  }
  // 分享卡片 path：写错 = 别人点进来白屏
  for (const m of src.matchAll(/(?:^|[^\w.])path\s*:\s*['"](\/pages\/[^'"]+)['"]/g)) {
    routeSeen++;
    if (app.pages.indexOf(toRoute(m[1])) < 0) {
      fail(`${where} 分享卡片 path 指向未注册页面 ${toRoute(m[1])}`);
      routeBad++;
    }
  }
}
if (!routeBad) pass(`${routeSeen} 处页面跳转 / 分享路径全部合法（tabBar ${tabPaths.length} 页）`);

/* ---------- 5c. 全项目 ES2017+ API 扫描 ----------
 * 比语法检查更隐蔽的一类：语法合法、开发者工具也跑得动，但老 iOS 的 JSCore 里
 * **这个方法根本不存在**，一调就是 `undefined is not a function` → 页面白屏。
 * 2026-10-22 就在这里抓到 `String.padStart`（scheduler.localToday 一进首页就调）。
 * 只扫 pages/ 与 utils/：lib/ 是云 SDK 压缩产物，含同名 API 字样会误报。
 */
console.log('[5c] ES2017+ API');
const ES2017_APIS = [
  ['\\.padStart\\s*\\(', 'String.prototype.padStart'],
  ['\\.padEnd\\s*\\(', 'String.prototype.padEnd'],
  ['Object\\.(values|entries|fromEntries)\\s*\\(', 'Object.values/entries'],
  ['Array\\.prototype\\.(flat|flatMap)|\\]\\.flat(Map)?\\s*\\(', 'Array.prototype.flat/flatMap'],
  ['\\?\\.', '可选链 ?.'],
  ['\\?\\?', '空值合并 ??'],
];
let esBad = 0;
for (const f of routeFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const [re, name] of ES2017_APIS) {
    if (new RegExp(re).test(src)) {
      fail(`${rel(f)} 使用了 ${name}（老 iOS JSCore 没有，会白屏）`);
      esBad++;
    }
  }
}
if (!esBad) pass(`${routeFiles.length} 个业务文件均未使用 ES2017+ API`);

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
