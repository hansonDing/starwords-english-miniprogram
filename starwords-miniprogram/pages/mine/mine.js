const { cloud, cloudError, available: cloudAvailable } = require('../../utils/cloud');
const store = require('../../utils/store');
const leaderboard = require('../../utils/leaderboard');

Page({
  data: {
    loggedIn: false,
    nickname: '',
    userId: '',
    syncing: false,
    syncText: '',
    leaderboard: [],
    myRank: 0,
    // 跟读攒下的星星总数（账户余额，将来可用于消耗活动）
    stars: 0,
    cloudAvailable: cloudAvailable,
    cloudError: cloudError,
  },

  onShow() {
    this.loadNickname();
    this.setData({ stars: store.getStarBalance() });
    // 先确定登录态（isMe / myRank 依赖 userId），再把自己的最新昵称与学习量推上去，
    // 最后拉榜 —— 顺序不能乱，否则会出现「榜上还是旧名字/旧学习量」
    this.refreshLogin().then(() => this.refreshBoard());
  },

  loadNickname() {
    this.setData({ nickname: leaderboard.getNickname() });
  },

  // 推送自己那一行 → 拉取榜单
  refreshBoard() {
    return leaderboard.push().then(() => this.loadLeaderboard());
  },

  refreshLogin() {
    if (!cloud) {
      this.setData({ loggedIn: false, userId: '' });
      return Promise.resolve();
    }
    return cloud.auth
      .getSession()
      .then(({ data: session }) => {
        this.setData({
          loggedIn: !!session,
          userId: session && session.user ? session.user.id : '',
        });
        if (session) store.syncToCloud();
      })
      .catch(() => this.setData({ loggedIn: false }));
  },

  /* ---------- 微信登录 ---------- */
  onLogin() {
    if (!cloud) {
      wx.showToast({ title: '云服务暂不可用，进度已保存在本机', icon: 'none' });
      return;
    }
    wx.login({
      success: ({ code }) => {
        wx.showLoading({ title: '登录中…' });
        const appid = wx.getAccountInfoSync().miniProgram.appId;
        cloud.auth
          .signInWithWechat(code, appid)
          .then(({ data: session, error }) => {
            wx.hideLoading();
            if (error || !session) {
              wx.showToast({ title: '微信登录失败，请重试', icon: 'none' });
              return;
            }
            this.setData({
              loggedIn: true,
              userId: session.user ? session.user.id : '',
            });
            wx.showToast({ title: '登录成功', icon: 'success' });
            // 登录后：上传本地进度，再尝试拉取云端进度，最后把自己的排行榜行写上去
            store.syncToCloud().then(() => store.pullFromCloud());
            leaderboard.push().then(() => this.loadLeaderboard());
          })
          .catch(() => {
            wx.hideLoading();
            wx.showToast({ title: '微信登录失败，请重试', icon: 'none' });
          });
      },
      fail: (error) => {
        console.error('[StarWords] login failed', JSON.stringify({ stage: 'wx.login', message: error.errMsg }));
        wx.showToast({ title: '微信登录失败，请重试', icon: 'none' });
      },
    });
  },

  onLogout() {
    if (!cloud) {
      this.setData({ loggedIn: false, userId: '' });
      return;
    }
    cloud.auth
      .signOut()
      .catch(() => {})
      .then(() => {
        this.setData({ loggedIn: false, userId: '' });
        wx.showToast({ title: '已退出登录', icon: 'none' });
      });
  },

  /* ---------- 昵称 ---------- */
  onNicknameInput(e) {
    const nickname = leaderboard.setNickname(e.detail.value);
    this.setData({ nickname });
    // 改完昵称立刻同步到排行榜（登录后才有意义）
    if (this.data.loggedIn) {
      leaderboard.push().then((ok) => {
        if (ok) this.loadLeaderboard();
      });
    }
  },

  /* ---------- 云同步 ---------- */
  onManualSync() {
    if (!cloud) {
      wx.showToast({ title: '云服务暂不可用，进度已保存在本机', icon: 'none' });
      return;
    }
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    this.setData({ syncing: true, syncText: '' });
    store
      .syncToCloud()
      .then(() => store.pullFromCloud())
      .then(() => {
        this.setData({ syncing: false, syncText: '同步完成 ✓' });
        this.loadLeaderboard();
        setTimeout(() => this.setData({ syncText: '' }), 2000);
      })
      .catch(() => {
        this.setData({ syncing: false, syncText: '同步失败，请检查网络' });
      });
  },

  /* ---------- 排行榜 ---------- */
  loadLeaderboard() {
    if (!cloud) {
      this.setData({ leaderboard: [], myRank: 0 });
      return;
    }
    cloud.database
      .from('leaderboard')
      .select('owner_name, learned_count, streak_days, current_week, owner_id')
      .order('learned_count', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(20)
      .then(({ data, error }) => {
        if (error || !Array.isArray(data)) {
          this.setData({ leaderboard: [] });
          return;
        }
        const leaderboard = data.map((row, i) => ({
          rank: i + 1,
          name: row.owner_name || '星星学员',
          learned: row.learned_count,
          streak: row.streak_days,
          week: row.current_week,
          isMe: this.data.loggedIn && row.owner_id === this.data.userId,
        }));
        const myIdx = leaderboard.findIndex((r) => r.isMe);
        this.setData({ leaderboard, myRank: myIdx + 1 });
      })
      .catch(() => this.setData({ leaderboard: [] }));
  },
});
