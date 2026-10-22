// 答题页：点分享卡片进来的一方在这里作答
//
// 关键约束：
//   1. **未登录也能答** —— 孩子点开卡片时大概率没登录，绝不能卡在登录墙。
//      RLS 对 anon 开放了 select/update，所以未登录也能读挑战、也能回传成绩
//      （played_by 写 null，出题者看到的是「星星小伙伴答对 4/5」）。
//   2. **结算顺序不能反**：先 store.creditPkStars（本地入账、不依赖网络），
//      再 pkCloud.submitResult（回传）。反过来的话网络一挂，
//      孩子明明答完了却拿不到星星。
//   3. **一场 PK 只能被作答一次**（先到先得）由数据库保证：
//      回传时 RLS 的 USING (status='pending') 会让第二个人的 update 命中 0 行。
//      本机星星照给（那是他自己答对的），只是成绩不覆盖别人的。
//   4. 答错**不揭示正确答案**（只雷击 + 变黑），留到结算页的错题回顾统一讲。
const { WORDS } = require('../../utils/words');
const { cloud } = require('../../utils/cloud');
const store = require('../../utils/store');
const avatar = require('../../utils/avatar');
const pk = require('../../utils/pk');
const pkCloud = require('../../utils/pkCloud');
const leaderboard = require('../../utils/leaderboard');

// 答对：看小人跳一下就走；答错：让雷击 + 变黑演完再走
const DELAY_RIGHT = 900;
const DELAY_WRONG = 1300;

Page({
  data: {
    mode: 'loading', // loading | blocked | playing | done
    blockedTitle: '',
    blockedText: '',
    challengerName: '',

    // 形象精灵图取图坐标（自己 / 出题者）。没设置过形象时是默认形象的坐标，不会为空。
    av: null,
    pkAv: null,

    // 答题
    questions: [],
    total: 0,
    qi: 0,
    dots: [],
    current: null,
    pickedIdx: -1,
    pickedCorrect: false,
    answered: false,

    // 动画开关
    figureDark: false,
    figureHit: false,
    figureHappy: false,
    flashing: false,
    floatStar: false,

    // 结算
    correctCount: 0,
    earnedStars: 0,
    wrongList: [],
    sending: false,
    resultSent: false,
    needLogin: false,
  },

  onLoad(query) {
    const q = query || {};
    const id = q.id ? String(q.id) : '';
    this.answerTimer = null;
    this.answers = [];
    this.uid = '';
    this.pkId = id;

    // 登场的主角就是孩子自己选的形象（没设置过 → 默认形象）。未登录也能选，存本机。
    this.setData({ av: store.getAvatar() });

    if (!id) {
      this.block('挑战链接不完整', '让对方重新分享一次吧');
      return;
    }
    this.setData({ pkId: id });

    Promise.all([pkCloud.fetch(id), this.currentUid()])
      .then((res) => {
        const ch = res[0];
        this.uid = res[1] || '';
        if (!ch) {
          this.block('挑战不存在或已失效', '可能已经被删掉了，让对方重新发一次');
          return;
        }
        const playable = pk.isPlayable(ch, this.uid);
        if (!playable.ok) {
          if (playable.reason === 'own') {
            this.block('这是你自己发起的挑战', '把链接发给小伙伴，让他来答吧');
          } else if (playable.reason === 'finished') {
            this.block('这场 PK 已经结束啦', '每个挑战只能被答一次。你可以自己发起一个！');
          } else {
            this.block('挑战不存在或已失效', '让对方重新分享一次吧');
          }
          return;
        }
        this.startPlay(ch);
      })
      .catch(() => {
        this.block('加载失败', '网络好像不太顺畅，稍后再试试');
      });
  },

  onUnload() {
    if (this.answerTimer) {
      clearTimeout(this.answerTimer);
      this.answerTimer = null;
    }
  },

  currentUid() {
    if (!cloud) return Promise.resolve('');
    return cloud.auth
      .getSession()
      .then(({ data: session }) => (session && session.user ? session.user.id : ''))
      .catch(() => '');
  },

  block(title, text) {
    this.setData({ mode: 'blocked', blockedTitle: title, blockedText: text });
  },

  /* ---------- 开始答题 ---------- */
  startPlay(ch) {
    const wordIds = Array.isArray(ch.word_ids) ? ch.word_ids : [];
    const questions = pk.buildQuestions(wordIds, WORDS);
    if (!questions.length) {
      // 词库对不上（老客户端 / 出题者用了新词）—— 不静默，明确说清
      this.block('题目加载不出来', '可能小程序版本不一致，更新后再试一次吧');
      return;
    }
    this.answers = [];
    this.setData({
      mode: 'playing',
      challengerName: ch.challenger_name || '小伙伴',
      // 出题者形象：老记录没有这一列 / 对方没设过 → 兜底成默认形象，绝不空白
      pkAv: avatar.tileOf(ch.challenger_avatar),
      questions,
      total: questions.length,
      qi: 0,
      dots: questions.map((q, i) => ({ id: i, done: false })),
      current: questions[0],
      pickedIdx: -1,
      pickedCorrect: false,
      answered: false,
      figureDark: false,
      figureHit: false,
      figureHappy: false,
      flashing: false,
      floatStar: false,
    });
    // ⚠️ 不在这里 markRead：点开≠作答。若一进来就标已读，而「我收到的挑战」只查
    // target_read = false，孩子点开看一眼就返回后这场挑战会**永久消失**（出题者视角还在等他答）。
    // 标已读放在 finish()，即真正答完之后。
  },

  /* ---------- 选答案 ---------- */
  onPickOption(e) {
    if (this.data.answered) return; // 每题只判一次，连点不会重复触发动画
    const idx = Number(e.currentTarget.dataset.idx);
    const q = this.data.current;
    if (!q || !(idx >= 0)) return;

    const ok = idx === q.answerIdx;
    this.answers[this.data.qi] = idx;
    const dots = this.data.dots.slice();
    dots[this.data.qi] = { id: this.data.qi, done: true };

    this.setData({ pickedIdx: idx, pickedCorrect: ok, answered: true, dots });

    if (ok) {
      this.setData({ figureHappy: true, floatStar: true });
      this.vibrate('light');
      this.answerTimer = setTimeout(() => this.nextQuestion(), DELAY_RIGHT);
    } else {
      // 雷击 + 小人变黑
      this.setData({ figureDark: true, figureHit: true, flashing: true });
      this.vibrate('heavy');
      this.answerTimer = setTimeout(() => {
        // 下一题开始前必须恢复原色，否则后面每道题的小人都是黑的
        this.setData({ figureDark: false, figureHit: false, flashing: false });
        this.nextQuestion();
      }, DELAY_WRONG);
    }
  },

  vibrate(type) {
    // 预览模拟器没有 vibrateShort，兜住避免中断动画流程
    try {
      wx.vibrateShort({ type: type });
    } catch (err) {
      /* ignore */
    }
  },

  nextQuestion() {
    this.answerTimer = null;
    const qi = this.data.qi + 1;
    if (qi >= this.data.total) {
      this.finish();
      return;
    }
    this.setData({
      qi,
      current: this.data.questions[qi],
      pickedIdx: -1,
      pickedCorrect: false,
      answered: false,
      figureDark: false,
      figureHit: false,
      figureHappy: false,
      flashing: false,
      floatStar: false,
    });
  },

  /* ---------- 结算 ---------- */
  finish() {
    const result = pk.scoreQuiz(this.data.questions, this.answers);
    // 答完才算「已读」：这场挑战从「我收到的挑战」里消失，正是此刻该发生的事
    if (this.pkId) pkCloud.markRead(this.pkId);
    // ⚠️ 先入账（纯本地，不依赖网络）
    const earned = store.creditPkStars(this.pkId, result.earnedStars);
    this.setData({
      mode: 'done',
      correctCount: result.correctCount,
      earnedStars: earned,
      wrongList: result.wrongList,
      needLogin: !this.uid,
    });
    // 再回传云端（失败 / 被抢先都不影响本地得星）
    this.submitResult(result);
  },

  submitResult(result) {
    if (!this.pkId) return;
    this.setData({ sending: true });
    pkCloud
      .submitResult(this.pkId, {
        result: {
          total: result.total,
          correctCount: result.correctCount,
          answers: this.answers || [],
        },
        playedBy: this.uid || '',
        playedName: leaderboard.getNickname(),
      })
      .then((ok) => {
        this.setData({
          sending: false,
          resultSent: !!ok,
          // 没回传成功 + 没登录 → 提示登录重试（登录后才有稳定的身份）
          needLogin: !ok && !this.uid,
        });
      })
      .catch(() => {
        this.setData({ sending: false, needLogin: !this.uid });
      });
  },

  /* ---------- 未登录时补登录，再把成绩补传 ---------- */
  onLogin() {
    if (!cloud) {
      wx.showToast({ title: '云服务暂不可用，成绩已存在本机', icon: 'none' });
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
              wx.showToast({ title: '登录失败，请重试', icon: 'none' });
              return;
            }
            this.uid = session.user ? session.user.id : '';
            this.setData({ needLogin: false });
            this.submitResult(pk.scoreQuiz(this.data.questions, this.answers));
          })
          .catch(() => {
            wx.hideLoading();
            wx.showToast({ title: '登录失败，请重试', icon: 'none' });
          });
      },
      fail: () => {
        wx.showToast({ title: '登录失败，请重试', icon: 'none' });
      },
    });
  },

  /* ---------- 导航 ---------- */
  onCreateMine() {
    wx.redirectTo({ url: '/pages/pk-create/pk-create' });
  },

  onGoHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
