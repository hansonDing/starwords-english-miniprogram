// 发起 PK：勾选我学过的单词 → 生成挑战（写入云端）→ 用 button open-type="share" 转发
//
// ⚠️ 小程序没有服务端推送，出题者**没法把 PK 直接送到对方手机上**。
//    唯一通路是分享卡片，由出题者手动转发给那个人。所以从排行榜点进来的
//    target/name 只是「标记挑战对象 + 让卡片带上对方名字」，不保证对方真的收到。
//    UI 文案必须诚实（ready 态会写明「转发给他，他点开才能作答」），
//    否则用户会以为点完按钮对方就收到了。
//
// ⚠️ 另一条硬约束：分享卡片的 path 在**点击转发按钮的那一刻**由 onShareAppMessage 产出，
//    所以必须先把挑战写进云端拿到 id，再显示分享按钮。pkId 为空时绝不显示 share 按钮。
const { getWordById } = require('../../utils/words');
const { cloud } = require('../../utils/cloud');
const store = require('../../utils/store');
const pk = require('../../utils/pk');
const pkCloud = require('../../utils/pkCloud');
const leaderboard = require('../../utils/leaderboard');

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
    mode: 'pick', // pick（选题）| ready（待分享）| fail（失败）
    targetId: '',
    targetName: '',
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

  /* ---------- 分享 ---------- */
  // 覆盖 app.js 注入的默认分享：把 path 指向这场 PK。
  // 必须用 this.data.pkId（ready 态才渲染分享按钮，所以这里不会为空）。
  onShareAppMessage() {
    const nick = leaderboard.getNickname();
    const who = this.data.targetName || '小伙伴';
    return {
      title: nick + ' 用单词考你，' + who + ' 敢来 PK 吗？',
      path: '/pages/pk-play/pk-play?id=' + this.data.pkId,
    };
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
