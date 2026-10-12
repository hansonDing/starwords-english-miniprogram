// 给小程序版云 SDK 打补丁：放开「非字符串 body」的限制。
//
// 背景（别删这段说明）：
//   SDK 的 miniprogram 版 fetch（createMiniProgramFetch）里有一道硬拦截 ——
//     if (typeof init.body !== 'string') throw new Error('暂不支持非字符串 body（ArrayBuffer/FormData 待补）。')
//   而上传视频必须传 ArrayBuffer（wx.getFileSystemManager().readFile 读出来的二进制），
//   于是 cloud.storage.upload 必然失败，云存储里永远传不进任何文件。
//   已核实 @tencent-ai/workbuddy-cloud-sdk 的 dev(0.1.2-dev.1b37f73) 与 latest(0.1.3)
//   两个版本**都还没修**，所以不能靠升级 SDK 解决。
//
//   微信的 wx.request 本身完全支持 ArrayBuffer 作为 data（会原样作为二进制 body 发出），
//   这道拦截纯属多余。这里把它替换成直接赋值，让二进制走通。
//
// 幂等：重复跑不会重复改。重新生成 / 升级 SDK 后需要再跑一次本脚本。
//
// 用法：node patch-sdk-body.cjs
const fs = require('fs');
const path = require('path');

const SDK_PATH = path.join(__dirname, '..', 'starwords-miniprogram', 'lib', 'workbuddy-cloud-sdk.js');

// 源码里这段中文是 \uXXXX 转义形式，下面用双反斜杠表示字面反斜杠。
// 末尾的分号要一起匹配，否则替换后会留下多余分号。
const NEEDLE =
  'throw new Error("createMiniProgramFetch: \\u6682\\u4E0D\\u652F\\u6301\\u975E\\u5B57\\u7B26\\u4E32 body\\uFF08ArrayBuffer/FormData \\u5F85\\u8865\\uFF09\\u3002");';
const REPLACEMENT = 'requestBody=init.body;';

// 补丁完成后的特征形态
const APPLIED_MARK = '}requestBody=init.body;case 3:';

function main() {
  if (!fs.existsSync(SDK_PATH)) {
    console.error('✗ 找不到 SDK 文件：' + SDK_PATH);
    process.exit(1);
  }

  let src = fs.readFileSync(SDK_PATH, 'utf8');
  let changed = false;

  // 1) 清理历史遗留的双分号（早期版本替换时漏匹配了原分号）
  if (src.indexOf('requestBody=init.body;;') !== -1) {
    src = src.split('requestBody=init.body;;').join('requestBody=init.body;');
    changed = true;
    console.log('· 规范化多余分号');
  }

  // 2) 移除「非字符串 body」拦截
  const hits = src.split(NEEDLE).length - 1;
  if (hits > 1) {
    console.error('✗ 目标代码出现 ' + hits + ' 次，不唯一，拒绝自动替换');
    process.exit(1);
  }
  if (hits === 1) {
    src = src.replace(NEEDLE, REPLACEMENT);
    changed = true;
    console.log('· 移除「非字符串 body」拦截');
  }

  if (changed) {
    fs.writeFileSync(SDK_PATH, src, 'utf8');
    console.log('✓ 补丁完成：ArrayBuffer body 现在会直接交给 wx.request');
    console.log('  文件：' + SDK_PATH);
    return;
  }

  if (src.indexOf(APPLIED_MARK) !== -1) {
    console.log('✓ 补丁已存在，无需重复应用');
    return;
  }

  console.error('✗ 没找到目标代码，SDK 结构可能已变化，请人工检查 createMiniProgramFetch');
  process.exit(1);
}

main();
