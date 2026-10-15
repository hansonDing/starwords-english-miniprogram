// 我的星星形象：先选男孩 / 女孩，再从 6 个星星形象里挑一个。
//
// 设计要点：
//   · **未登录也能设置** —— 形象先存本机（progress.avatarId），登录后随进度自动上云。
//     孩子点开 PK 卡片时通常没登录，不能因为要选形象就把人挡在登录墙外。
//   · 进来时若**已经设过形象**，直接进第 2 步并选中当前形象 —— 这时用户是来「换」的，
//     不该逼他重新走一遍性别选择。
//   · 换性别时，如果该性别下已有保存的形象，自动选回它（避免「选了半天回去一趟就没了」）。
//   · 确认后回到上一页（「我的」或登录引导过来的那一页）；万一没有上一页就回「我的」。
const store = require('../../utils/store');
const avatar = require('../../utils/avatar');

Page({
  data: {
    step: 'gender', // gender（选性别）| pick（选形象）
    from: '', // 'login' = 登录成功后引导过来的
    genders: [], // [{ id, name, tx, ty }] 卡片预览用该性别的第 1 个形象
    gender: '',
    list: [], // 当前性别的 6 个形象（含 tx/ty）
    selectedId: '',
    preview: null, // 顶部大图预览
    saving: false,
    spriteSrc: avatar.SPRITE.src,
  },

  onLoad(query) {
    const q = query || {};
    const genders = avatar.GENDERS.map(function (g) {
      const t = avatar.tileOf(avatar.listByGender(g.id)[0].id);
      return { id: g.id, name: g.name, tx: t.tx, ty: t.ty };
    });

    const cur = store.getAvatar();
    const chosen = store.hasAvatar();
    this.setData({
      from: q.from === 'login' ? 'login' : '',
      genders: genders,
      gender: chosen ? cur.gender : '',
      list: chosen ? this.buildList(cur.gender) : [],
      selectedId: chosen ? cur.id : '',
      preview: chosen ? cur : null,
      step: chosen ? 'pick' : 'gender',
    });
  },

  /** 某个性别的 6 个形象，转成带取图坐标的图块 */
  buildList(gender) {
    return avatar.listByGender(gender).map(function (x) {
      return avatar.tileOf(x.id);
    });
  },

  /* ---------- 第 1 步：选性别 ---------- */
  onPickGender(e) {
    const gender = e.currentTarget.dataset.id;
    if (gender !== 'boy' && gender !== 'girl') return;
    // 该性别下已经有保存过形象 → 自动选回它（换过去看看再换回来不丢选择）
    const saved = store.getAvatar();
    const keep = store.hasAvatar() && saved.gender === gender;
    this.setData({
      gender: gender,
      step: 'pick',
      list: this.buildList(gender),
      selectedId: keep ? saved.id : '',
      preview: keep ? saved : null,
    });
  },

  onBackGender() {
    this.setData({ step: 'gender', selectedId: '', preview: null });
  },

  /* ---------- 第 2 步：选形象 ---------- */
  onPickAvatar(e) {
    const id = e.currentTarget.dataset.id;
    const t = avatar.tileOf(id);
    if (t.id !== id) return; // 非法 id（正常点不到）→ 什么都不做，别把选择清掉
    this.setData({ selectedId: t.id, preview: t });
  },

  onConfirm() {
    if (this.data.saving) return;
    if (!this.data.selectedId) {
      wx.showToast({ title: '先挑一个星星形象吧', icon: 'none' });
      return;
    }
    const id = store.setAvatar(this.data.selectedId);
    this.setData({ saving: true, selectedId: id });
    wx.showToast({ title: '这就是我啦！', icon: 'success' });
    setTimeout(() => {
      // 正常是从「我的」或登录引导 navigateTo 过来，有上一页；
      // 万一没有（直接进入）→ 回「我的」，绝不停在一个回不去的页面
      if (getCurrentPages().length > 1) wx.navigateBack();
      else wx.switchTab({ url: '/pages/mine/mine' });
    }, 700);
  },
});
