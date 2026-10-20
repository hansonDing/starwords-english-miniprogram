const store = require('../../utils/store');
const { cloud } = require('../../utils/cloud');

// 跳级 = 家长行为 → 要求已登录（未登录只能留在一年级按顺序学）。
// 相邻年级直接切，跨级弹一次确认。
Page({
  data: {
    grades: [],
    loggedIn: false,
    totalLearned: 0,
    totalWords: 0,
    totalPercent: 0,
  },

  onShow() {
    // 先拿登录态再算卡片：未登录时非一年级要显示锁态
    this.refreshLogin().then(() => this.refresh());
  },

  refreshLogin() {
    if (!cloud) {
      this.setData({ loggedIn: false });
      return Promise.resolve();
    }
    return cloud.auth
      .getSession()
      .then(({ data }) => this.setData({ loggedIn: !!(data && data.user) }))
      .catch(() => this.setData({ loggedIn: false }));
  },

  refresh() {
    const stats = store.totalStats();
    const list = store.gradeList();
    const firstId = list.length > 0 ? list[0].id : '';
    const view = list.map((g) => {
      let state = 'todo';
      let statusText = '未开始';
      if (!g.available) {
        state = 'locked';
        statusText = '即将上线';
      } else if (g.active) {
        state = 'active';
        statusText = g.completed ? '已完成' : '学习中';
      } else if (!this.data.loggedIn && g.id !== firstId) {
        state = 'locked';
        statusText = '登录解锁';
      } else if (g.completed) {
        state = 'done';
        statusText = '已完成';
      } else if (g.learned > 0) {
        state = 'doing';
        statusText = '已学 ' + g.learned + ' 词';
      }
      return Object.assign({}, g, { state: state, statusText: statusText });
    });
    this.setData({
      grades: view,
      totalLearned: stats.learned,
      totalWords: stats.total,
      totalPercent: stats.percent,
    });
  },

  onPickGrade(e) {
    const id = e.currentTarget.dataset.id;
    const list = this.data.grades;
    const target = list.filter((g) => g.id === id)[0];
    if (!target || target.active) return;
    if (!target.available) {
      wx.showToast({ title: target.name + '的单词正在准备中', icon: 'none' });
      return;
    }
    if (!this.data.loggedIn) {
      wx.showModal({
        title: '需要先登录',
        content: '切换年级是家长操作。学习记录不受影响，登录后会自动同步到云端。',
        confirmText: '去登录',
        success: (r) => {
          if (r.confirm) wx.switchTab({ url: '/pages/mine/mine' });
        },
      });
      return;
    }
    const ids = list.map((g) => g.id);
    const curIdx = ids.indexOf(store.currentGrade().id);
    const tgtIdx = ids.indexOf(id);
    if (Math.abs(tgtIdx - curIdx) <= 1) {
      this.applyGrade(id, target.name);
      return;
    }
    wx.showModal({
      title: '切换年级',
      content: '确定让孩子从' + list[curIdx].name + '跳到' + target.name + '吗？学过的单词不会丢，随时可以切回来。',
      confirmText: '确定切换',
      success: (r) => {
        if (r.confirm) this.applyGrade(id, target.name);
      },
    });
  },

  applyGrade(id, name) {
    store.setGrade(id);
    this.refresh();
    wx.showToast({ title: '已切换到' + name, icon: 'success' });
  },

  onGoLearn() {
    wx.navigateTo({ url: '/pages/learn/learn' });
  },
});
