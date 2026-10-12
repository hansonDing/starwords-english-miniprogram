const dv = require('../../utils/dailyVideo');
const admin = require('../../utils/admin');
const { available: cloudAvailable } = require('../../utils/cloud');

// 允许上传的视频后缀（要与云存储里写死的 contentType: video/mp4 保持一致）
const VIDEO_EXT = ['mp4', 'mov', 'm4v'];

Page({
  data: {
    cloudAvailable: cloudAvailable,
    checking: true,
    loggedIn: false,
    bound: false,
    isAdmin: false,
    passcode: '',
    binding: false,
    week: [],
    busy: false,
    busyText: '',
  },

  onShow() {
    this.load();
  },

  load() {
    return admin.check().then((st) => {
      this.setData({
        checking: false,
        loggedIn: st.loggedIn,
        bound: st.bound,
        isAdmin: st.isAdmin,
      });
      // 只有管理员才需要拉 7 天清单，其他情况不浪费请求
      if (!st.isAdmin) {
        this.setData({ week: [] });
        return null;
      }
      return dv.fetchManifest().then((manifest) => {
        this.setData({ week: dv.buildWeek(manifest) });
      });
    });
  },

  /* ---------- 绑定管理员 ---------- */
  onPasscodeInput(e) {
    this.setData({ passcode: e.detail.value });
  },

  onClaim() {
    if (this.data.binding) return;
    this.setData({ binding: true });
    admin.claim(this.data.passcode).then((out) => {
      this.setData({ binding: false, passcode: '' });
      if (!out || !out.ok) {
        wx.showModal({
          title: '绑定失败',
          content: (out && out.error) || '请重试',
          showCancel: false,
        });
        return;
      }
      wx.showToast({ title: '已设为管理员', icon: 'success' });
      this.load();
    });
  },

  findDay(dayIndex) {
    for (let i = 0; i < this.data.week.length; i++) {
      if (this.data.week[i].dayIndex === dayIndex) return this.data.week[i];
    }
    return null;
  },

  /* ---------- 选择视频 ----------
   * 两条路都要给：
   *   ① 相册（chooseMedia）—— 最省事，手机里拍/存的视频直接选，不依赖聊天记录
   *   ② 聊天文件（chooseMessageFile）—— 视频已经发到聊天里时用
   */
  onPickFile(e) {
    const dayIndex = Number(e.currentTarget.dataset.day);
    if (this.data.busy) return;
    if (!this.data.isAdmin) {
      wx.showToast({ title: '只有家长账号能上传', icon: 'none' });
      return;
    }
    if (typeof wx.showActionSheet !== 'function') {
      this.pickFromAlbum(dayIndex);
      return;
    }
    wx.showActionSheet({
      itemList: ['从手机相册选择视频（推荐）', '从聊天记录里的文件选择'],
      success: (res) => {
        if (res.tapIndex === 0) this.pickFromAlbum(dayIndex);
        else if (res.tapIndex === 1) this.pickFromChat(dayIndex);
      },
      fail: () => {
        /* 用户取消，忽略 */
      },
    });
  },

  pickFromAlbum(dayIndex) {
    if (typeof wx.chooseMedia !== 'function') {
      wx.showModal({
        title: '当前环境不支持选择视频',
        content: '选择相册视频需要在微信开发者工具或真机上操作，预览模拟器里没有这个能力。',
        showCancel: false,
      });
      return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album'],
      success: (res) => {
        const file = res && res.tempFiles && res.tempFiles[0];
        if (!file || !file.tempFilePath) return;
        this.doUpload(dayIndex, file.tempFilePath, file.size || 0);
      },
      fail: () => {
        /* 用户取消，忽略 */
      },
    });
  },

  pickFromChat(dayIndex) {
    if (typeof wx.chooseMessageFile !== 'function') {
      wx.showModal({
        title: '当前环境不支持选择聊天文件',
        content: '选择聊天文件需要在微信开发者工具或真机上操作，预览模拟器里没有这个能力。',
        showCancel: false,
      });
      return;
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      // 故意不传 extension：微信的扩展名过滤对聊天里的文件经常匹配不上，
      // 会让明明存在的文件在列表里凭空消失。改成选完再判断，问题可见、也好提示。
      success: (res) => {
        const file = res && res.tempFiles && res.tempFiles[0];
        if (!file || !file.path) return;
        // 微信自己标成 video 的就直接放行；否则看原始文件名后缀
        if (file.type !== 'video' && !this.isVideoName(file.name)) {
          wx.showModal({
            title: '这不是视频文件',
            content: '请选择 mp4 / mov 格式的视频。如果这个 mp4 在聊天里是能直接点开播放的「视频」，说明它是视频消息而不是文件，选不到是正常的 —— 请改用「从手机相册选择」。',
            showCancel: false,
          });
          return;
        }
        // 注意：path 常常是没有后缀的临时路径，真正的文件名在 name 里
        this.doUpload(dayIndex, file.path, file.size || 0);
      },
      fail: () => {
        /* 用户取消，忽略 */
      },
    });
  },

  isVideoName(name) {
    const m = /\.([A-Za-z0-9]{2,5})$/.exec(String(name || ''));
    if (!m) return true; // 拿不到后缀就不拦（微信临时路径经常没有后缀），交给体积和播放去兜
    return VIDEO_EXT.indexOf(m[1].toLowerCase()) >= 0;
  },

  /* ---------- 上传 / 替换 ---------- */
  doUpload(dayIndex, filePath, size) {
    const day = this.findDay(dayIndex);
    const show = dv.getShow(dayIndex);
    if (size > dv.MAX_UPLOAD_BYTES) {
      wx.showModal({
        title: '视频太大了',
        content: '当前 ' + dv.formatSize(size) + '，请压缩到 50MB 以内再上传，否则孩子加载会很慢。',
        showCancel: false,
      });
      return;
    }
    this.setData({ busy: true, busyText: '正在上传「' + show.title + '」…' });
    if (typeof wx.showLoading === 'function') wx.showLoading({ title: '上传中…', mask: true });

    dv.uploadDay(dayIndex, filePath, size).then((out) => {
      if (typeof wx.hideLoading === 'function') wx.hideLoading();
      this.setData({ busy: false, busyText: '' });
      if (!out || !out.saved) {
        wx.showModal({ title: '上传失败', content: (out && out.error) || '请重试', showCancel: false });
        return;
      }
      const wasUploaded = !!(day && day.uploaded);
      wx.showToast({ title: wasUploaded ? '已替换' : '上传成功', icon: 'success' });
      this.load();
    });
  },

  /* ---------- 删除 ---------- */
  onDelete(e) {
    const dayIndex = Number(e.currentTarget.dataset.day);
    const day = this.findDay(dayIndex);
    if (!day || !day.uploaded || this.data.busy) return;
    if (!this.data.isAdmin) return;
    const show = dv.getShow(dayIndex);
    wx.showModal({
      title: '删除这段动画？',
      content: '「' + show.title + '」的视频会从云存储中删除，删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#ef4444',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ busy: true, busyText: '正在删除…' });
        dv.removeDay(day).then((out) => {
          this.setData({ busy: false, busyText: '' });
          if (!out || !out.saved) {
            wx.showModal({ title: '删除失败', content: (out && out.error) || '请重试', showCancel: false });
            return;
          }
          wx.showToast({ title: '已删除', icon: 'none' });
          this.load();
        });
      },
    });
  },

  onGoLogin() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },
});
