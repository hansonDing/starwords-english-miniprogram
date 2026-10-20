# StarWords 星星英语 · 微信小程序

给孩子的英语启蒙小程序：**每天 5 个单词** —— 看图 → 听音 → 跟读打分 → 小测验 → 奖励动画。走完 200 词（40 天）。

纯微信小程序原生开发（CommonJS + WXML/WXSS），**不经任何打包器**：没有 `miniprogram_npm`，小程序目录里也没有 `package.json` / `node_modules`。

## 目录结构

```
starwords-miniprogram/            小程序本体
├── app.js / app.json / app.wxss
├── pages/                        8 个页面
│   ├── index/     首页（第 N 天、今天的动画）
│   ├── learn/     学习三步：听一听 → 跟读 → 小测验 → 配对闯关
│   ├── review/    复习
│   ├── progress/  进度 + 星星图
│   ├── grades/    年级选择（一年级 ~ 九年级；跳级需家长确认）
│   ├── mine/      我的（昵称、排行榜）
│   ├── video/     每日动画（7 天日程）
│   └── admin/     家长后台（上传动画、绑定家长账号）
├── utils/                        业务逻辑
│   ├── store.js          进度存取（本地 + 云端同步）+ 年级划分与指针推导
│   ├── cloud.js          云服务封装
│   ├── config.js         云服务公开配置
│   ├── words.js          词库（由脚本生成，含 GRADES 年级区间表）
│   ├── audio.js          音频播放（周包分段定位；真机 / 模拟器路径降级）
│   ├── audioPackMap.js   音频周包段表（由脚本生成）
│   ├── record-score.js   跟读评分（WAV 本地解析）
│   ├── leaderboard.js    排行榜
│   ├── dailyVideo.js     每日动画（签名地址 / 上传 / 清单）
│   ├── admin.js          家长账号绑定
│   ├── share.js          转发 / 分享到朋友圈
│   └── wx-compat.js      预览模拟器缺失 API 兜底
├── lib/workbuddy-cloud-sdk.js    云服务 SDK（已本地打补丁，见下）
└── assets/                       200 词读音、200 条例句音频、单词精灵图、tab 图标

starwords-miniprogram-scripts/    资源管线 + 自检脚本（**与小程序目录平级，不进小程序包**）
```

## ⚠️ 资源管线依赖网页版词库

本小程序的词库源在网页版仓库 `hansonDing/starwords-english-learning` 的 `src/data/wordData.ts`：

```
wordData.ts ──extract-words.mjs──► words.json ──gen-words-js.mjs──► utils/words.js
```

只拿这个小程序仓库**可以直接运行**（音频、图片、词库都已提交），但**改单词 / 例句要回网页版仓库一起改**，再跑一遍上面的管线并重生成对应音频。

### 年级划分

`starwords-miniprogram-scripts/grade-plan.json` 是**年级区间的唯一可编辑源头**：

| 年级 | id | 单元范围 | 词数 |
|---|---|---|---|
| 一年级 | g1 | 1–40 | 200（= 现有内容，零迁移） |
| 二年级 | g2 | 41–75 | 175 |
| 三年级 | g3 | 76–110 | 175 |
| 四年级 | g4 | 111–140 | 150 |
| 五年级 | g5 | 141–170 | 150 |
| 六年级 | g6 | 171–200 | 150 |
| 七年级 | g7 | 201–240 | 200 |
| 八年级 | g8 | 241–280 | 200 |
| 九年级 | g9 | 281–320 | 200 |

合计 320 单元 = 1600 词（当前只灌了一年级的 200 词）。`gen-words-js.mjs` 读它产出 `words.js` 里的 `GRADES`
→**改划分只改这个 JSON、重跑生成器即可，不动任何代码**。区间必须连续覆盖 1..320、无缺口重叠（`grade-check.cjs` 强制）。

## 交付前自检

```bash
cd starwords-miniprogram-scripts
node check-static.cjs      # 模块引用、页面四件套、体积、文件数、隐私清单、分享能力……
node grade-check.cjs       # 年级划分表（连续覆盖 / GRADES 一致 / 词条不含 grade 字段）
node preview-compile.cjs   # 本地复现平台预览编译
```

完整清单共 16 个脚本：`check-static` `phonetic-check` `grade-check` `share-runtime-check` `record-score-check`
`match-check` `match-runtime-check` `stars-check` `review-runtime-check` `avatar-check` `avatar-runtime-check`
`pk-check` `pk-runtime-check` `audio-pack-check` `audio-runtime-check` `grade-runtime-check`。

## 关键约束（改代码前必读）

1. **不做小程序 npm 构建**：不要 `miniprogram_npm`、不要裸包名 `require`；小程序目录内不能出现 `node_modules` / `package.json`。
2. 页面必须 **`pages/<n>/{js,json,wxml,wxss}` 四件套齐** —— 缺 `.json` 真机四个 tab 页会一起白屏。
3. `<image>` 用相对路径 `../../assets/...`；`InnerAudioContext` **真机不支持 `../`**，必须用 `/assets/...`。
4. 禁 `?.`、省略绑定的 `catch {}`、裸 `globalThis`（老 iOS 引擎解析报错 → 白屏）。
5. **包体积**：< 2,000,000B（十进制）且 < 2,097,152B（2MiB）。
6. **文件数 < 500**（预览编译器的硬上限；超了预览首页打不开，而且**没有任何报错**）。
7. 不用分包（`subPackages[].pages` 为空即非法配置）。
8. `lib/workbuddy-cloud-sdk.js` 打过一次**本地补丁**（放开非字符串 body，否则视频传不上去）。升级 / 重新生成 SDK 后必须重跑 `node starwords-miniprogram-scripts/patch-sdk-body.cjs`；`check-static.cjs` 会拦住漏打。

## 云服务

云配置在 `utils/config.js`，其中 `publishableKey` 是**可随前端分发的公开值**（类似 Supabase 的 anon key），私密凭据全部保存在服务端。
