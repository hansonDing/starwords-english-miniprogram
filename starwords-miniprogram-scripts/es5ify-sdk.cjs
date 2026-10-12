// 将 SDK 产物转译为 ES5，避免老手机系统（iOS<13.4 等）因 ?. / catch{} 报错白屏
// 用法：NODE_PATH=<babel 所在 node_modules> node scripts/es5ify-sdk.cjs
const babel = require('@babel/core');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'starwords-miniprogram');
const src = path.join(root, 'lib', 'workbuddy-cloud-sdk.js');

const presetEnv = require.resolve('@babel/preset-env', {
  paths: ['C:/Users/PC/.workbuddy/binaries/node/workspace/node_modules/@babel/preset-env'],
});

const before = fs.statSync(src).size;
const out = babel.transformFileSync(src, {
  presets: [[presetEnv, { targets: { chrome: '53', safari: '9' }, modules: 'commonjs' }]],
  sourceType: 'script',
  compact: true,
  comments: false,
});

// 老引擎兜底：globalThis 不存在时挂到全局对象上
const poly = [
  '// [es5-polyfill] 老引擎 globalThis 兜底（现代引擎无操作）',
  "if (typeof globalThis === 'undefined') {",
  '  var __wbG = (function () { return this; })();',
  '  if (__wbG) { __wbG.globalThis = __wbG; }',
  '}',
  '',
].join('\n');

fs.writeFileSync(src, poly + out.code);
console.log('transpiled:', before, '->', fs.statSync(src).size, 'bytes at', src);
