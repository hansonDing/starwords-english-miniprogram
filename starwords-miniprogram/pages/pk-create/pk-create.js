// 发起 PK：勾选我学过的单词 → 生成挑战（写入云端）
//
// 两条路径靠 URL 上有没有 target 区分，**出口完全不同**：
//  ① 指定对手（排行榜「挑战」进来，带 target）→ 站内发送。对方下次打开小程序
//     在首页弹窗 /「我的」页「新的挑战」里看到，不依赖微信转发。
//  ② 开放式挑战（「我的」→「发起单词PK」，无 target）→ 微信转发。没有 target_id
//     站内通知送不到任何人，唯一通路就是分享卡片，谁点开谁答。
//
// ⚠️ ① 的卡片不能指向这场 PK：那等于把「专门考某人」的题泄到群里，谁先点开谁替他答了
//    （数据库先到先得，他反而永远答不了）。所以 ① 的转发卡片只回首页。
// ⚠️ ② 的 path 在点转发那一刻产出，必须先写云端拿到 id 再显示按钮；pkId 为空绝不拼 `?id=`。
const { getWordById } = require('../../utils/words');
const { cloud } = require('../../utils/cloud');
const store = require('../../utils/store');
const pk = require('../../utils/pk');
const pkCloud = require('../../utils/pkCloud');
const leaderboard = require('../../utils/leaderboard');
const share = require('../../utils/share');

// 昵称经 encodeURIComponent 传参后可能已被框架解码过一次，再解码会抛错（含 % 时）
function safeDecode(v) {
  const s = String(v == null ? '' : v);
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

Page({
  data: {
    mode: 'pick', // pick（选题）| ready（待发送/待转发）| fail（失败）
    targetId: '',
    targetName: '',
    hasTarget: false, // true = 指定对手（站内发送）；false = 开放式挑战（微信转发）
    headTitle: '发起 PK',
    candidates: [], // [{ id, word, meaning, phonetic, picked }]
    pickedCount: 0,
    questionCount: 0,
    pkId: '',
    creating: false,
    canCreate: false,
    failText: '',
    minQuestions: pk.MIN_QUESTIONS,
    maxQuestions: pk.MAX_QUESTIONS,
  },

  onLoad(query) {
    const q = query || {};
    const targetId = q.target ? String(q.target) : '';
    const targetName = q.name ? safeDecode(q.name) : '';
    this.setData({
      targetId,
      targetName,
      // 只有真的带了对手 uid 才算「指定对手」。昵称单独传进来但 uid 为空时，
      // 站内通知依然送不到，必须按开放式挑战处理（否则又是一个假成功）。
      hasTarget: !!targetId,
      headTitle: targetName ? '挑战 ' + targetName : '发起 PK',
    });
    wx.setNavigationBarTitle({ title: targetName ? '挑战 ' + targetName : '发起 PK' });
    this.loadCandidates();
  },

  // 「我学过的单词」= progress.words 里 learned 的条目，经词库还原出中文含义
  loadCandidates() {
    let learned = [];
    try {
      learned = (store.getProgress().words || []).filter((w) => w.learned);
    } catch (e) {
      learned = [];
    }
    const candidates = [];
    for (let i = 0; i < learned.length; i++) {
      const word = getWordById(learned[i].wordId);
      if (!word) continue;
      candidates.push({
        id: word.id,
        word: word.word,
        meaning: word.meaning,
        phonetic: word.phonetic || '',
        picked: false,
      });
    }
    this.setData({ candidates, pickedCount: 0, canCreate: false });
  },

  /* ---------- 勾选 ---------- */
  applyList(list) {
    let n = 0;
    for (let i = 0; i < list.length; i++) if (list[i].picked) n++;
    this.setData({ candidates: list, pickedCount: n, canCreate: n >= pk.MIN_QUESTIONS });
  },

  onToggle(e) {
    const id = e.currentTarget.dataset.id;
    const list = this.data.candidates.slice();
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const item = list[idx];
    // 上限保护：不静默丢弃，明确告诉孩子为什么点不亮
    if (!item.picked && this.data.pickedCount >= pk.MAX_QUESTIONS) {
      wx.showToast({ title: '最多选 ' + pk.MAX_QUESTIONS + ' 个', icon: 'none' });
      return;
    }
    list[idx] = Object.assign({}, item, { picked: !item.picked });
    this.applyList(list);
  },

  onSelectAll() {
    const list = this.data.candidates.slice();
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const pick = n < pk.MAX_QUESTIONS;
      if (pick) n++;
      list[i] = Object.assign({}, list[i], { picked: pick });
    }
    this.applyList(list);
    if (list.length > pk.MAX_QUESTIONS) {
      wx.showToast({ title: '最多 ' + pk.MAX_QUESTIONS + ' 个，已选前 ' + pk.MAX_QUESTIONS + ' 个', icon: 'none' });
    }
  },

  onClearAll() {
    this.applyList(
      this.data.candidates.map((c) => Object.assign({}, c, { picked: false }))
    );
  },

  /* ---------- 生成挑战 ---------- */
  currentUid() {
    if (!cloud) return Promise.resolve('');
    return cloud.auth
      .getSession()
      .then(({ data: session }) => (session && session.user ? session.user.id : ''))
      .catch(() => '');
  },

  onCreate() {
    if (this.data.creating) return;
    if (!this.data.canCreate) {
      wx.showToast({ title: '至少选 ' + pk.MIN_QUESTIONS + ' 个单词', icon: 'none' });
      return;
    }
    const ids = this.data.candidates
      .filter((c) => c.picked)
      .map((c) => c.id);
    this.setData({ creating: true });

    this.currentUid()
      .then((uid) => {
        if (!uid) {
          // 发起方必须有 uid（出题者身份要写进挑战行），这跟「答题方可以未登录」不同
          this.setData({
            creating: false,
            mode: 'fail',
            failText: '需要先登录才能发起挑战。去「我的」页登录后再试。',
          });
          return null;
        }
        const id = pk.makeChallengeId();
        return pkCloud
          .create({
            id,
            challengerId: uid,
            challengerName: leaderboard.getNickname(),
            // 出题者形象写进挑战行：答题方结算时要显示「我 ↔ 对方」两个形象。
            // 没设过形象时存的就是默认形象 id，对方看到的也就是这个（不会空白）。
            challengerAvatar: store.getAvatar().id,
            targetId: this.data.targetId,
            targetName: this.data.targetName,
            wordIds: ids,
          })
          .then((ok) => {
            if (!ok) {
              this.setData({
                creating: false,
                mode: 'fail',
                failText: '挑战生成失败，请检查网络后重试。',
              });
              return;
            }
            this.setData({ creating: false, mode: 'ready', pkId: id, questionCount: ids.length });
          });
      })
      .catch(() => {
        this.setData({ creating: false, mode: 'fail', failText: '挑战生成失败，请检查网络后重试。' });
      });
  },

  /* ---------- 转发（只有开放式挑战才指向这场 PK）---------- */
  // app.js 的 share.attach 只在页面没定义时才注入，这里一旦定义就全归自己管，
  // 所以必须自己兜住「还没生成挑战」的情形 —— 回首页，绝不产出坏链接。
  onShareAppMessage() {
    if (this.data.hasTarget || !this.data.pkId) return share.appMessage();
    return {
      title: leaderboard.getNickname() + ' 用单词考你，敢来 PK 吗？',
      path: '/pages/pk-play/pk-play?id=' + this.data.pkId,
    };
  },

  /* ---------- 发送挑战（仅指定对手）---------- */
  onSendChallenge() {
    if (!this.data.pkId) return;
    // 开放式挑战没有 target_id，点这里说「已发送」就是骗人
    if (!this.data.hasTarget) return;
    const name = this.data.targetName || '小伙伴';
    wx.showToast({ title: '已发送给 ' + name, icon: 'none' });
    setTimeout(() => {
      wx.navigateBack();
    }, 1200);
  },

  /* ---------- 导航 ---------- */
  onBackToPick() {
    this.setData({ mode: 'pick', pkId: '', questionCount: 0 });
  },

  onGoLearn() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onGoMine() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },
});
