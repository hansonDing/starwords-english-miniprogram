const dv = require('../../utils/dailyVideo');
const admin = require('../../utils/admin');
const { available: cloudAvailable } = require('../../utils/cloud');

Page({
  data: {
    cloudAvailable: cloudAvailable,
    loggedIn: false,
    isAdmin: false,
    canManage: false,
    loading: true,
    week: [],
    current: null,
    videoUrl: '',
    preparing: false,
    placeholderText: '正在准备今天的动画…',
    videoError: '',
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  refresh() {
    this.setData({ loading: true, videoError: '' });
    return admin
      .check()
      .then((st) => {
        this.setData({
          loggedIn: st.loggedIn,
          isAdmin: st.isAdmin,
          // 还没绑定过管理员时，任何登录用户都能进去设置家长账号；
          // 绑定之后入口就只对管理员本人显示了
          canManage: st.isAdmin || !st.bound,
        });
        return dv.fetchManifest().then((manifest) => {
          const week = dv.buildWeek(manifest);
          const today = dv.todayIndex();
          let current = null;
          for (let i = 0; i < week.length; i++) {
            if (week[i].dayIndex === today) current = week[i];
          }
          if (!current) current = week[0];
          this.setData({ week: week, current: current, loading: false, videoUrl: '' });
          return this.prepare(current);
        });
      })
      .catch(() => {
        this.setData({ loading: false, placeholderText: '加载失败，下拉可以刷新重试' });
      });
  },

  // 取签名播放地址（云存储没有公开地址，每次现签，最长 1 小时）
  prepare(day) {
    if (!day) return Promise.resolve();
    if (!day.uploaded) {
      this.setData({
        preparing: false,
        placeholderText: this.data.loggedIn ? '这一天的动画还没上传' : '登录后就能观看每日动画',
      });
      return Promise.resolve();
    }
    this.setData({ preparing: true, videoError: '', placeholderText: '正在准备今天的动画…' });
    return dv.signUrl(day.objectPath).then((url) => {
      this.setData({ preparing: false, videoUrl: url });
      if (!url) {
        this.setData({ videoError: '播放地址获取失败，请下拉刷新重试' });
      }
    });
  },

  onPickDay(e) {
    const dayIndex = Number(e.currentTarget.dataset.day);
    let day = null;
    for (let i = 0; i < this.data.week.length; i++) {
      if (this.data.week[i].dayIndex === dayIndex) day = this.data.week[i];
    }
    if (!day) return;
    if (!day.unlocked) {
      wx.showToast({ title: '还没到这一天，明天再来吧', icon: 'none' });
      return;
    }
    if (!day.uploaded) {
      wx.showToast({ title: '这一天的动画还没上传', icon: 'none' });
      return;
    }
    if (this.data.current && this.data.current.dayIndex === dayIndex && this.data.videoUrl) return;
    this.setData({ current: day, videoUrl: '', videoError: '' });
    this.prepare(day);
  },

  onVideoError(e) {
    const detail = (e && e.detail) || {};
    const msg = detail.errMsg || detail.errCode || '未知错误';
    this.setData({ videoError: '播放失败：' + msg });
  },

  onGoLogin() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },

  onGoManage() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  },
});
