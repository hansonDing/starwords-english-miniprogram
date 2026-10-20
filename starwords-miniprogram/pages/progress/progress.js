const { WORDS } = require('../../utils/words');
const store = require('../../utils/store');

Page({
  data: {
    currentWeek: 1,
    learnedCount: 0,
    streakDays: 0,
    graduatedCount: 0,
    totalWords: WORDS.length,
    achievementsView: [],
    // 按年级分段的进度视图（年级名 + 词数 + 百分比 + 状态）
    gradeSegments: [],
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const progress = store.getProgress();
    const learned = progress.words.filter((w) => w.learned);
    const graduated = progress.words.filter((w) => w.reviewStage >= 5);
    const achievementsView = store.ACHIEVEMENTS.map((a) => ({
      id: a.id,
      name: a.name,
      icon: a.icon,
      description: a.description,
      unlocked: progress.achievements.indexOf(a.id) !== -1,
    }));
    // 年级分段：进度全部由 store 从「已学记录」推导，这里只负责挑展示状态
    const gradeSegments = store.gradeList().map((g) => {
      let state = 'todo';
      let statusText = '未开始';
      if (!g.available) {
        state = 'locked';
        statusText = '即将上线';
      } else if (g.active) {
        state = 'active';
        statusText = g.completed ? '已完成' : g.learned + '/' + g.total;
      } else if (g.completed) {
        state = 'done';
        statusText = '已完成';
      } else if (g.learned > 0) {
        state = 'doing';
        statusText = g.learned + '/' + g.total;
      }
      return { id: g.id, name: g.name, learned: g.learned, total: g.total, percent: g.percent, state, statusText };
    });
    this.setData({
      currentWeek: progress.currentWeek,
      learnedCount: learned.length,
      streakDays: progress.streakDays,
      graduatedCount: graduated.length,
      journeyPercent: Math.round((learned.length / WORDS.length) * 100),
      achievementsView,
      gradeSegments,
    });
  },

  onReset() {
    wx.showModal({
      title: '重置学习进度',
      content: '将清空所有学习记录、星星和成就，无法恢复。确定要重置吗？',
      confirmText: '重置',
      confirmColor: '#ef4444',
      success: (res) => {
        if (res.confirm) {
          store.resetProgress();
          this.refresh();
          wx.showToast({ title: '已重置', icon: 'success' });
        }
      },
    });
  },
});
