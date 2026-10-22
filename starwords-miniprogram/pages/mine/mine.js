const { cloud, cloudError, available: cloudAvailable } = require('../../utils/cloud');
const store = require('../../utils/store');
const leaderboard = require('../../utils/leaderboard');
const pkCloud = require('../../utils/pkCloud');
const wordLib = require('../../utils/words');

// 「我发起的 PK」折叠时露几条（剩下的靠「展开全部」）
const PK_COLLAPSED = 3;

Page({
  data: {
    loggedIn: false,
    nickname: '',
    userId: '',
    syncing: false,
    syncText: '',
    leaderboard: [],
    myRank: 0,
    // 我发起的 PK（最多 10 条）：{ id, who, total, done, text }
    // pkList 是全部，pkShown 是实际渲染的那部分（展开 / 折叠）
    pkList: [],
    pkShown: [],
    pkHasMore: false,
    pkExpanded: false,
    pkDeleting: '',
    // 我收到的未读挑战：{ id, name, total }
    incomingList: [],
    showIncoming: false,
    // 跟读攒下的星星总数（账户余额，将来可用于消耗活动）
    stars: 0,
    // 我的星星形象（没设置过时是默认形象，不会是空对象）
    avatar: null,
    hasAvatar: false,
    cloudAvailable: cloudAvailable,
    cloudError: cloudError,
  },

  onShow() {
    this.loadNickname();
    this.setData({
      stars: store.getStarBalance(),
      // 从形象页返回时 onShow 会再跑一次，这里的预览自动刷新成刚选的形象
      avatar: store.getAvatar(),
      hasAvatar: store.hasAvatar(),
    });
    // 先确定登录态（isMe / myRank / PK 列表都依赖 userId），再把自己的最新昵称与学习量推上去，
    // 最后拉榜 —— 顺序不能乱，否则会出现「榜上还是旧名字/旧学习量」
    this.refreshLogin().then(() => {
      this.refreshBoard();
      this.loadPkList();
      this.loadIncoming();
    });
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
        // ⚠️ 顺序必须是「先拉后推」：新设备上本地是空档，先推就会把云端进度整份擦掉。
        if (session) store.pullFromCloud().then(() => store.syncToCloud());
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
            // 登录后：先拉云端（新设备 / 换手机时这才是孩子真正的进度），再推本地。
            // ⚠️ 反过来会先把空档推上去，云端进度就没了。
            store.pullFromCloud().then(() => store.syncToCloud());
            leaderboard.push().then(() => this.loadLeaderboard());
            // 第一次登录 → 引导选一次形象。
            // ⚠️ 只在「登录」这个动作里触发，**不做 onShow 轮询** ——
            //    否则孩子每次从形象页返回都会再被弹进去一次。
            //    已经设过形象（换设备重登）也不跳。
            if (!store.hasAvatar()) {
              wx.navigateTo({ url: '/pages/avatar/avatar?from=login' });
            }
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
      .select('owner_name, learned_count, streak_days, current_week, grade_id, owner_id')
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
          // 保留 uid：发起 PK 时要当 query 传给 pk-create（不能靠昵称认人，昵称可重名）
          uid: row.owner_id || '',
          learned: row.learned_count,
          streak: row.streak_days,
          week: row.current_week,
          // 老行没有 grade_id → 空串，模板自动省略
          gradeName: row.grade_id ? (wordLib.gradeById(row.grade_id) || {}).name || '' : '',
          isMe: this.data.loggedIn && row.owner_id === this.data.userId,
        }));
        const myIdx = leaderboard.findIndex((r) => r.isMe);
        this.setData({ leaderboard, myRank: myIdx + 1 });
      })
      .catch(() => this.setData({ leaderboard: [] }));
  },

  /* ---------- 星星形象 ---------- */
  // 未登录也能设置（形象先存本机，登录后随进度上云）
  onEditAvatar() {
    wx.navigateTo({ url: '/pages/avatar/avatar' });
  },

  /* ---------- PK 挑战 ---------- */
  // 折叠视图：pkList 存全部，pkShown 只给模板渲染 —— 否则记录越攒越多，页面一路往下长
  applyPkView(list) {
    const all = Array.isArray(list) ? list : [];
    this.setData({
      pkList: all,
      pkShown: this.data.pkExpanded ? all : all.slice(0, PK_COLLAPSED),
      pkHasMore: all.length > PK_COLLAPSED,
    });
  },

  onTogglePkExpand() {
    this.setData({ pkExpanded: !this.data.pkExpanded });
    this.applyPkView(this.data.pkList);
  },

  // 我发起的挑战（最近 10 条）。未登录 / 云端不可用 → 静默不渲染这个区块。
  loadPkList() {
    if (!this.data.loggedIn) {
      this.applyPkView([]);
      return;
    }
    pkCloud
      .listMine(this.data.userId)
      .then((rows) => {
        const list = (Array.isArray(rows) ? rows : []).map((row) => {
          const total = Array.isArray(row.word_ids) ? row.word_ids.length : 0;
          const result = row.result || {};
          const correct = typeof result.correctCount === 'number' ? result.correctCount : 0;
          const done = row.status === 'done';
          return {
            id: row.id,
            who: row.target_name || '小伙伴',
            total: total,
            done: done,
            // 「先到先得」：done 就是已经有人答过了（可能是匿名作答）
            text: done ? (row.played_name || '小伙伴') + ' 答对 ' + correct + '/' + total + ' 题' : '等待接受',
          };
        });
        this.applyPkView(list);
      })
      .catch(() => this.applyPkView([]));
  },

  // 删除一场我发起的挑战：云端真删（RLS 只允许删 challenger_id = 自己的行）
  onDeletePk(e) {
    const ds = e.currentTarget.dataset;
    const id = ds.id;
    const done = ds.done === true || ds.done === 'true';
    if (!id || this.data.pkDeleting) return;
    wx.showModal({
      title: '删除这场挑战？',
      content: done ? '删除后你这边不再显示这条记录。' : '还没人作答。删除后对方将看不到这场挑战。',
      confirmText: '删除',
      confirmColor: '#e5484d',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ pkDeleting: id });
        pkCloud.remove(id).then((ok) => {
          this.setData({ pkDeleting: '' });
          if (!ok) {
            // 失败就不动列表 —— 假装删掉的话，下拉刷新又会冒出来
            wx.showToast({ title: '删除失败，请检查网络', icon: 'none' });
            return;
          }
          wx.showToast({ title: '已删除', icon: 'success' });
          this.applyPkView(
            this.data.pkList.filter(function (x) {
              return x.id !== id;
            })
          );
        });
      },
    });
  },

  onChallenge(e) {
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先登录，再来挑战', icon: 'none' });
      return;
    }
    const ds = e.currentTarget.dataset;
    const uid = ds.uid || '';
    if (!uid) return;
    // 昵称里可能有 & % = 等字符，必须编码后再拼进 query
    const name = encodeURIComponent(ds.name || '');
    wx.navigateTo({ url: '/pages/pk-create/pk-create?target=' + uid + '&name=' + name });
  },

  // 我收到的未读挑战（站内通知）
  loadIncoming() {
    if (!this.data.loggedIn || !this.data.userId) {
      this.setData({ incomingList: [], showIncoming: false });
      return;
    }
    pkCloud
      .listIncoming(this.data.userId)
      .then((rows) => {
        const list = (Array.isArray(rows) ? rows : []).map((row) => ({
          id: row.id,
          name: row.challenger_name || '小伙伴',
          total: Array.isArray(row.word_ids) ? row.word_ids.length : 0,
        }));
        this.setData({ incomingList: list, showIncoming: list.length > 0 });
      })
      .catch(() => this.setData({ incomingList: [], showIncoming: false }));
  },

  onPlayChallenge(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/pk-play/pk-play?id=' + id });
  },

  onCreatePk() {
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先登录，再来出题', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/pk-create/pk-create' });
  },
});
