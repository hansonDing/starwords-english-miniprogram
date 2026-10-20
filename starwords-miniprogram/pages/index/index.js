const { getWeekWords, WORDS_PER_WEEK } = require('../../utils/words');
const store = require('../../utils/store');
const scheduler = require('../../utils/scheduler');
const audio = require('../../utils/audio');
const dailyVideo = require('../../utils/dailyVideo');

Page({
  data: {
    // 注意：progress.currentWeek 实际含义是「第几个学习日」（每完成一天 +1），
    // 所以对外一律显示成「第 N 天」，这里的字段也叫 dayNo，避免再被误读成自然周。
    dayNo: 1,
    // 今天要学的单元号（从已学记录推导，不等于 dayNo —— 跨年级后两者会分家）
    unitNo: 0,
    gradeName: '',
    gradeEmptyText: '',
    streakDays: 0,
    canLearn: true,
    dueCount: 0,
    learnedTotal: 0,
    weekWords: [],
    progressPercent: 0,
    streakText: '今天开始学习吧!',
    dailyTitle: '',
    dailyEnTitle: '',
  },

  onShow() {
    // 启动异常可见化：app.onError 暂存的错误在此弹出（只弹一次）
    try {
      const err = wx.getStorageSync('__starwords_error');
      if (err) {
        wx.removeStorageSync('__starwords_error');
        wx.showModal({
          title: '启动异常',
          content: String(err).slice(0, 400),
          showCancel: false,
        });
      }
    } catch (e) {
      /* ignore */
    }
    this.refresh();
  },

  onHide() {
    audio.stop();
  },

  refresh() {
    const progress = store.getProgress();
    const today = scheduler.localToday();
    const canLearn = scheduler.canLearnToday(progress, today);
    const due = scheduler.getDueReviews(progress, today);
    // 今天学哪个单元：从已学记录推导（currentWeek 是「第几个学习日」，不是单元号）
    const grade = store.currentGrade();
    const unit = store.nextUnitInGrade(grade.id);
    const unitNo = unit === null ? 0 : unit;
    const weekWords = unitNo
      ? getWeekWords(unitNo).map((w) => {
          const wp = progress.words.find((x) => x.wordId === w.id);
          return {
            id: w.id,
            word: w.word,
            meaning: w.meaning,
            imgTx: w.imgTx,
            imgTy: w.imgTy,
            learned: !!(wp && wp.learned),
          };
        })
      : [];
    const learnedInWeek = weekWords.filter((w) => w.learned).length;
    let gradeEmptyText = '';
    if (unitNo === 0) {
      const stats = store.gradeStats(grade.id);
      gradeEmptyText = stats.available ? grade.name + '的单词都学完啦' : grade.name + '即将上线';
    }
    // 今天的动画片名（本地按星期几算，不用联网）
    const todayShow = dailyVideo.getShow(dailyVideo.todayIndex());
    this.setData({
      dayNo: progress.currentWeek,
      unitNo,
      gradeName: grade.name,
      gradeEmptyText,
      streakDays: progress.streakDays,
      canLearn,
      dueCount: due.length,
      learnedTotal: progress.words.filter((w) => w.learned).length,
      weekWords,
      progressPercent: unitNo ? Math.round((learnedInWeek / WORDS_PER_WEEK) * 100) : 0,
      streakText: progress.streakDays > 0 ? '已连续学习 ' + progress.streakDays + ' 天' : '今天开始学习吧!',
      dailyTitle: todayShow.title,
      dailyEnTitle: todayShow.enTitle,
    });
  },

  onGoGrades() {
    wx.navigateTo({ url: '/pages/grades/grades' });
  },

  onGoDailyVideo() {
    wx.navigateTo({ url: '/pages/video/video' });
  },

  onStartLearn() {
    if (this.data.gradeEmptyText) {
      // 本年级没有可学的新词（学完了 / 还没上线）→ 引导去切年级
      wx.showModal({
        title: this.data.gradeName,
        content: this.data.gradeEmptyText + '。去看看其他年级吧？',
        confirmText: '切换年级',
        success: (r) => {
          if (r.confirm) this.onGoGrades();
        },
      });
      return;
    }
    if (!this.data.canLearn) {
      wx.showToast({ title: '今天学完啦，明天继续!', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/learn/learn' });
  },

  onGoReview() {
    wx.switchTab({ url: '/pages/review/review' });
  },

  onPreviewWord(e) {
    const id = e.currentTarget.dataset.id;
    // ⚠️ 必须用 unitNo（今天学的单元号），不能用 dayNo（第几个学习日）—— 跨年级后两者会错位
    const w = getWeekWords(this.data.unitNo).find((x) => x.id === id);
    if (w) audio.play(w.audio).catch(() => {});
  },

  // 单词图已合并为单张精灵图（assets/sprite.jpg），没有第二份可降级的图源，
  // 这里保留空实现仅为了兜住 <image> 的 binderror，避免控制台报未定义处理函数。
  onImgError() {},
});
