// 生成「奖励动画片」的可视化演示页（浏览器打开即可看三幕演出）
// 做法：从 learn.wxss / app.wxss 里抽取庆祝相关的样式块（含 @keyframes），
// 把 rpx 按 750rpx = 375px 折算成 px，再套上与小程序的 WXML 同构的 DOM。
// 好处：演示页用的就是真实样式，改了 wxss 重跑一遍即可看到最新效果。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const MP = path.join(ROOT, '..', 'starwords-miniprogram')

/* ---------- 1. 极简 CSS 块解析（按花括号配对切块，支持 @keyframes 嵌套） ---------- */
function splitBlocks(css) {
  const blocks = []
  const n = css.length
  let i = 0
  while (i < n) {
    // 跳过空白与注释
    if (/\s/.test(css[i])) {
      i++
      continue
    }
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    const braceIdx = css.indexOf('{', i)
    if (braceIdx === -1) break
    const selector = css.slice(i, braceIdx).trim()
    let depth = 1
    let j = braceIdx + 1
    while (j < n && depth > 0) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    blocks.push({ selector, raw: css.slice(i, j).trim() })
    i = j
  }
  return blocks
}

const KEEP = /\.(celebrate|skip-btn|stage|confetti-item|mascot|bubble|parade|achv|back-btn|btn-primary)|@keyframes/

function extractCss() {
  const out = []
  for (const file of ['app.wxss', path.join('pages', 'learn', 'learn.wxss')]) {
    const css = fs.readFileSync(path.join(MP, file), 'utf8')
    for (const { selector, raw } of splitBlocks(css)) {
      if (KEEP.test(selector)) out.push(raw)
    }
  }
  // rpx → px（设计宽 750rpx = 375px）
  return out
    .join('\n\n')
    .replace(/(-?\d*\.?\d+)rpx/g, (_, n) => `${Math.round((parseFloat(n) / 2) * 100) / 100}px`)
}

/* ---------- 2. 取第一周 5 个词 + 精灵图偏移 ---------- */
const words = JSON.parse(fs.readFileSync(path.join(ROOT, 'words.json'), 'utf8')).slice(0, 5)
const sprite = JSON.parse(fs.readFileSync(path.join(ROOT, 'sprite-map.json'), 'utf8'))
const { cols, rows } = sprite
const fmt = (n) => {
  const v = Math.round(n * 1000) / 1000
  return v === 0 ? 0 : v
}

/* ---------- 3. 组装 HTML ---------- */
const confettiIcons = ['🎉', '✨', '⭐', '🎈', '🌈', '💫', '🎊', '🌟', '🍀', '🎁', '🎵', '💖']
const rand = (a, b) => a + Math.random() * (b - a)
const confetti = confettiIcons
  .map(
    (icon) =>
      `<span class="confetti-item" style="left:${Math.round(rand(4, 92))}%;animation-delay:${(
        Math.round(rand(0, 20)) / 10
      ).toFixed(1)}s;animation-duration:${rand(2, 3).toFixed(1)}s;font-size:${Math.round(rand(26, 48))}px">${icon}</span>`
  )
  .join('\n      ')

const parade = words
  .map((w, i) => {
    const [c, r] = sprite.map[w.imageName]
    const tx = fmt(-(c / cols) * 100)
    const ty = fmt(-(r / rows) * 100)
    return `      <div class="parade-item" style="animation-delay:${(i * 0.18).toFixed(2)}s">
        <div class="parade-img sprite">
          <img class="sprite-img" src="../starwords-miniprogram/assets/sprite.jpg" style="transform: translate(${tx}%, ${ty}%)" alt="${w.word}" />
        </div>
        <div class="parade-text">
          <span class="parade-word">${w.word}</span>
          <span class="parade-meaning">${w.meaning}</span>
        </div>
        <span class="parade-star">⭐</span>
      </div>`
  })
  .join('\n')

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>奖励动画片 · 效果演示</title>
<style>
  body{margin:0;padding:24px;background:#f5f3ff;font-family:-apple-system,'PingFang SC','Helvetica Neue',sans-serif;color:#1f2937}
  h1{font-size:19px;margin:0 0 6px}
  .note{font-size:13px;color:#6b7280;line-height:1.7;max-width:760px;margin-bottom:6px}
  .bar{display:flex;gap:10px;align-items:center;margin:14px 0 18px;flex-wrap:wrap}
  .bar button{padding:8px 18px;border-radius:999px;border:none;background:#6d59eb;color:#fff;font-size:13px;font-weight:600;cursor:pointer}
  .bar button.ghost{background:#fff;color:#6d59eb;border:2px solid #6d59eb}
  .act{font-size:13px;color:#6d59eb;font-weight:700}
  /* 手机壳：宽 375px，与小程序设计宽度一致 */
  .phone{width:375px;background:#fff;border-radius:28px;box-shadow:0 10px 40px rgba(109,89,235,.18);overflow:hidden}
  .sprite{position:relative;overflow:hidden;display:block}
  .sprite-img{display:block;width:1600%;height:1300%}

  /* ===== 以下样式从 learn.wxss / app.wxss 抽取（rpx 已折算为 px）===== */
${extractCss()}
</style>
</head>
<body>
  <h1>每天学完 5 个单词 · 奖励动画片</h1>
  <p class="note">这一页用的是小程序里同一份样式（自动从 <code>learn.wxss</code> 抽取，rpx 折算成 px），
  三幕按小程序里的节奏自动播放：<b>星星出场 → 小动物跳舞撒花 → 5 个单词巡游 + 成就</b>。
  真实小程序里第 3 幕后会再显示成就卡片和「回首页」按钮。</p>
  <div class="bar">
    <button id="replay">重播动画</button>
    <button class="ghost" id="skip">直接看结局</button>
    <span class="act" id="act">第 1 幕 / 3</span>
  </div>

  <div class="phone">
    <div class="celebrate">
      <div class="skip-btn">跳过 ▸</div>
      <div class="stage">
      ${confetti}
        <div class="mascot-wrap">
          <span class="mascot" id="mascot">⭐</span>
          <span class="mascot-friend f1" id="f1">🐻</span>
          <span class="mascot-friend f2" id="f2">🐰</span>
          <span class="mascot-friend f3" id="f3">🐼</span>
        </div>
        <div class="bubble" id="bubble">今天 5 个单词全学会啦！</div>
      </div>

      <div class="parade" id="parade" style="display:none">
        <div class="parade-title">🎬 今天学会的单词</div>
${parade}
      </div>

      <div id="final" style="display:none">
        <div class="celebrate-title">太棒了！本周单词全部学会！</div>
        <div class="celebrate-sub">明天会解锁新的 5 个单词哦</div>
        <div class="achv-list">
          <div class="achv-head">获得新成就</div>
          <div class="achv-item">
            <span class="achv-icon">🏅</span>
            <div class="achv-info">
              <span class="achv-name">一周达人</span>
              <span class="achv-desc">连续学习 7 天</span>
            </div>
          </div>
        </div>
        <div class="btn-primary back-btn">回首页</div>
      </div>
    </div>
  </div>

<script>
  const $ = (id) => document.getElementById(id)
  const acts = [$('mascot'), $('bubble'), $('f1'), $('f2'), $('f3')]
  let timers = []

  function clear() { timers.forEach(clearTimeout); timers = [] }

  function reset() {
    clear()
    acts.forEach((el) => el.classList.remove('pop', 'show', 'dance'))
    $('parade').style.display = 'none'
    $('final').style.display = 'none'
    // 彩带动画：重建节点让无限动画从头开始
    document.querySelectorAll('.confetti-item').forEach((el) => {
      const clone = el.cloneNode(true)
      el.parentNode.replaceChild(clone, el)
    })
    $('act').textContent = '第 1 幕 / 3'
    $('mascot').classList.add('pop')
    timers.push(setTimeout(() => {
      acts.forEach((el) => el.classList.add('pop', 'show'))
      $('mascot').classList.add('dance')
      $('act').textContent = '第 2 幕 / 3 · 一起跳舞'
    }, 2600))
    timers.push(setTimeout(showEnd, 5400))
  }

  function showEnd() {
    clear()
    acts.forEach((el) => el.classList.add('pop', 'show'))
    $('mascot').classList.add('dance')
    $('parade').style.display = 'block'
    $('final').style.display = 'block'
    $('act').textContent = '第 3 幕 / 3 · 单词巡游'
  }

  $('replay').addEventListener('click', reset)
  $('skip').addEventListener('click', showEnd)
  reset()
</script>
</body>
</html>
`

fs.writeFileSync(path.join(ROOT, 'reward-preview.html'), html, 'utf8')
const pxCount = (html.match(/animation/g) || []).length
console.log('已生成 reward-preview.html', html.length, 'bytes；animation 出现', pxCount, '次')
