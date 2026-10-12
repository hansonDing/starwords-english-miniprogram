// WorkBuddy 云客户端：全应用唯一实例
// SDK 产物为自包含 CommonJS 单文件（lib/workbuddy-cloud-sdk.js），
// 这里用「相对路径」直接引入，不依赖小程序的 npm 构建 / miniprogram_npm 映射，
// 因此在开发者工具、预览模拟器和真机体验版上解析行为完全一致。
const publicConfig = require('./config')
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')

let cloud = null
let cloudError = ''

try {
  const sdk = require('../lib/workbuddy-cloud-sdk.js')
  const factory = sdk && (sdk.createMiniProgramWorkBuddyCloud || (sdk.default && sdk.default.createMiniProgramWorkBuddyCloud))
  if (typeof factory !== 'function') {
    throw new Error('SDK 未导出 createMiniProgramWorkBuddyCloud')
  }
  cloud = factory({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
    wx: createDiagnosticWx(wx),
  })
} catch (e) {
  // 云功能不可用时降级为纯本地模式：本地学习、复习、进度全部不受影响
  cloud = null
  cloudError = e && e.message ? e.message : String(e)
  console.error('[cloud] SDK 加载失败，已降级为纯本地模式：', cloudError)
}

module.exports = { cloud, cloudError, available: !!cloud }
