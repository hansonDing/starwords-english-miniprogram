const { WORDS, MAX_WEEK } = require('../../utils/words');
const store = require('../../utils/store');

Page({
  data: {
    currentWeek: 1,
    learnedCount: 0,
    streakDays: 0,
    graduatedCount: 0,
    totalWords: WORDS.length,
    achievementsView: [],
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const progress = store.getProgress();
    const learned = progress.words.filter((w) => w.learned);
    const graduated = progress.words.filter((w) => w.reviewStage >= store.ACHIEVEMENTS.length && w.reviewStage >= 5);
    const achievementsView = store.ACHIEVEMENTS.map((a) => ({
      id: a.id,
      name: a.name,
      icon: a.icon,
      description: a.description,
      unlocked: progress.achievements.indexOf(a.id) !== -1,
    }));
    this.setData({
      currentWeek: progress.currentWeek,
      maxWeek: MAX_WEEK,
      learnedCount: learned.length,
      streakDays: progress.streakDays,
      graduatedCount: graduated.length,
      journeyPercent: Math.round((learned.length / WORDS.length) * 100),
      achievementsView,
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
