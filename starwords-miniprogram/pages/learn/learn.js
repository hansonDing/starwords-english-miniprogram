const { getWeekWords, WORDS, WORDS_PER_WEEK, MAX_WEEK } = require('../../utils/words');
const store = require('../../utils/store');
const scheduler = require('../../utils/scheduler');
const audio = require('../../utils/audio');
const recordScore = require('../../utils/record-score');
const match = require('../../utils/match');
const leaderboard = require('../../utils/leaderboard');

const SPEAK_GOOD = 95;
const SPEAK_SKIP = 70;
const QUIZ_BONUS = 5;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

Page({
  data: {
    phase: 'learning', // learning | celebrate
    week: 1,
    wordIndex: 0,
    step: 1,
    // 最后一个单词多一步「配对闯关」：前 4 个词 3 步，第 5 个词 4 步
    maxStep: 3,
    word: null,
    quiz: null,
    quizAnswered: false,
    quizCorrect: false,
    pickedIdx: -1,
    recording: false,
    recorded: false,
    playingBack: false,
    spokeWell: false,
    wordScore: 0,
    // 自动评分（录音结束后本地分析得出，界面只显示星星）
    autoLevel: '',
    autoStarCount: 0,
    autoMsg: '',
    // 配对闯关（第 4 步）：左列单词 / 右列打乱的中文含义
    matchLeft: [],
    matchRight: [],
    matchSolved: 0,
    matchTotal: 0,
    matchAllDone: false,
    finishedCount: 0,
    weekWordsView: [],
    newAchievements: [],
    // 奖励动画片：1 星星出场 → 2 跳舞撒花 → 3 单词巡游
    rewardStage: 0,
    rewardWords: [],
    confetti: [],
  },

  wordScores: {},
  recorder: null,
  recordPath: null,
  playbackCtx: null,
  rewardTimers: [],
  // 配对闯关：matchPlayed 保证整组只出现一次；matchWords 存原词对象以取读音
  matchPlayed: false,
  matchWords: [],
  matchTimer: null,

  onLoad() {
    const progress = store.getProgress();
    const week = progress.currentWeek;
    const words = getWeekWords(week);
    // 跳过本周已学完的词（如昨天学了一半）
    const firstIdx = words.findIndex((w) => {
      const wp = progress.words.find((x) => x.wordId === w.id);
      return !(wp && wp.learned);
    });
    const startIdx = firstIdx === -1 ? 0 : firstIdx;
    this.wordScores = {};
    // 从最后一个词进入才需要第 4 步配对；中途恢复学习则仍是 3 步
    const startsAtLast = startIdx === words.length - 1;
    this.setData({
      week,
      wordIndex: startIdx,
      word: words[startIdx],
      step: 1,
      maxStep: startsAtLast ? 4 : 3,
      weekWordsView: words.map((w) => ({ id: w.id, learned: false })),
    });
    this.initRecorder();
    // 进入卡片自动朗读：先读单词，再读例句
    wx.nextTick(() => this.playWord().then(() => this.playPhrase({ silent: true })));
  },

  onUnload() {
    this.clearRewardTimers();
    this.clearMatchTimer();
    audio.stop();
    if (this.playbackCtx) {
      try {
        this.playbackCtx.destroy();
      } catch (e) {
        /* ignore */
      }
    }
  },

  /* ---------- 发音 ---------- */
  playWord() {
    const w = this.data.word;
    if (!w) return Promise.resolve();
    return audio.play(w.audio).catch(() => {
      wx.showToast({ title: '播放失败，请再试一次', icon: 'none' });
    });
  },

  // 例句发音（与单词发音同在包内，无需额外加载）
  // 自动朗读时传 { silent: true }，失败不弹提示以免打扰
  playPhrase(opts) {
    const w = this.data.word;
    if (!w || !w.phraseAudio) return Promise.resolve();
    const silent = !!(opts && opts.silent);
    return audio.playPhrase(w.phraseAudio).catch(() => {
      if (!silent) {
        wx.showToast({ title: '例句播放失败，请再试一次', icon: 'none' });
      }
    });
  },

  /* ---------- Step 1 → Step 2 ---------- */
  onStep1Done() {
    this.goStep(2);
  },

  // 单词图已合并为单张精灵图（assets/sprite.jpg），没有第二份可降级的图源，
  // 这里保留空实现仅为了兜住 <image> 的 binderror。
  onImgError() {},

  /* ---------- 录音跟读 ---------- */
  initRecorder() {
    this.recorder = wx.getRecorderManager();
    this.recorder.onStart(() => {
      this.setData({ recording: true, recorded: false });
    });
    this.recorder.onStop((res) => {
      this.recordPath = res.tempFilePath || null;
      this.setData({ recording: false, recorded: !!this.recordPath });
      if (this.recordPath) this.gradeRecording(this.recordPath);
    });
    this.recorder.onError(() => {
      this.setData({ recording: false });
      wx.showToast({ title: '录音不可用，可以直接跳过跟读', icon: 'none' });
    });
  },

  // 录音结束后自动评分：本地分析时长/响度/有声占比 → 换算成 0~3 颗星（0 星 = 完全没听到声音）
  gradeRecording(path) {
    recordScore.gradeFile(path).then((r) => {
      if (!r) return; // 解析失败就不显示评分，不影响原有流程
      this.setData({
        autoLevel: r.level,
        autoStarCount: r.starCount,
        autoMsg: r.message,
      });
    });
  },

  onStartRecord() {
    if (this.data.recording) return;
    // 重录 / 新录：先清掉上一次的星级反馈，避免旧星星残留
    this.setData({ recorded: false, spokeWell: false, autoLevel: '', autoStarCount: 0, autoMsg: '' });
    // 用 WAV 格式：包内可解析 PCM，供自动评分分析
    this.recorder.start({ duration: 6000, format: 'wav', sampleRate: 16000, numberOfChannels: 1 });
  },

  onStopRecord() {
    if (!this.data.recording) return;
    this.recorder.stop();
  },

  onPlayBack() {
    if (!this.recordPath) return;
    if (this.playbackCtx) {
      try {
        this.playbackCtx.stop();
        this.playbackCtx.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    const ctx = wx.createInnerAudioContext();
    this.playbackCtx = ctx;
    ctx.src = this.recordPath;
    ctx.onPlay(() => this.setData({ playingBack: true }));
    ctx.onEnded(() => this.setData({ playingBack: false }));
    ctx.onError(() => {
      this.setData({ playingBack: false });
      wx.showToast({ title: '回放失败', icon: 'none' });
    });
    ctx.play();
  },

  onSpeakGood() {
    this.wordScores[this.data.word.id] = SPEAK_GOOD;
    this.setData({ spokeWell: true, wordScore: SPEAK_GOOD });
    this.goStep(3);
  },

  onSpeakSkip() {
    this.wordScores[this.data.word.id] = SPEAK_SKIP;
    this.setData({ spokeWell: false, wordScore: SPEAK_SKIP });
    this.goStep(3);
  },

  /* ---------- 小测验 ---------- */
  buildQuiz(word) {
    const type = Math.random() < 0.5 ? 'listen-pick' : 'meaning-pick';
    const others = WORDS.filter((x) => x.id !== word.id);
    const distractors = shuffle(others).slice(0, 3);
    const options = shuffle([word].concat(distractors)).map((x) => ({
      id: x.id,
      word: x.word,
      meaning: x.meaning,
    }));
    return { type, options, answerIdx: options.findIndex((x) => x.id === word.id) };
  },

  onPickOption(e) {
    if (this.data.quizAnswered) return;
    const idx = e.currentTarget.dataset.idx;
    const correct = idx === this.data.quiz.answerIdx;
    if (correct) {
      const base = this.wordScores[this.data.word.id] || SPEAK_SKIP;
      this.wordScores[this.data.word.id] = Math.min(100, base + QUIZ_BONUS);
    }
    this.setData({ quizAnswered: true, quizCorrect: correct, pickedIdx: idx });
    if (this.data.quiz.type === 'listen-pick') {
      this.playWord();
    }
  },

  /* ---------- 步骤流转 ---------- */
  goStep(step) {
    if (step === 3 && !this.data.quiz) {
      this.setData({ quiz: this.buildQuiz(this.data.word), quizAnswered: false, pickedIdx: -1, step: 3 });
      if (this.data.quiz && this.data.quiz.type === 'listen-pick') {
        wx.nextTick(() => this.playWord());
      }
      return;
    }
    this.setData({ step });
  },

  /* ---------- Step 4：配对闯关（学完当天 5 词后的整组复习） ---------- */
  // 只有最后一个单词才会走到这里；前 4 个词仍是 3 步。
  // 出题逻辑在 utils/match.js（纯函数，由 match-check.cjs 锁住「右列不能是原序」）。
  clearMatchTimer() {
    if (this.matchTimer) {
      clearTimeout(this.matchTimer);
      this.matchTimer = null;
    }
  },

  startMatch(words) {
    this.clearMatchTimer();
    this.matchWords = words || [];
    const puzzle = match.buildPuzzle(this.matchWords);
    const blank = (it) => Object.assign({}, it, { picked: false, done: false, wrong: false });
    this.setData({
      matchLeft: puzzle.left.map(blank),
      matchRight: puzzle.right.map(blank),
      matchSolved: 0,
      matchTotal: puzzle.left.length,
      matchAllDone: false,
    });
  },

  onPickMatchLeft(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.matchLeft.find((x) => x.id === id);
    if (!item || item.done) return; // 已配对的锁定，重复点无效
    // 同一列只允许一个选中
    this.setData({
      matchLeft: this.data.matchLeft.map((x) => Object.assign({}, x, { picked: x.id === id, wrong: false })),
    });
    // 点单词顺便听读音（配不上也不打扰，只是加深印象）
    const w = this.matchWords.find((x) => x.id === id);
    if (w) audio.play(w.audio).catch(() => {});
    this.tryMatch();
  },

  onPickMatchRight(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.matchRight.find((x) => x.id === id);
    if (!item || item.done) return;
    if (!this.data.matchLeft.some((x) => x.picked)) {
      wx.showToast({ title: '先点左边的单词哦', icon: 'none' });
      return;
    }
    this.setData({
      matchRight: this.data.matchRight.map((x) => Object.assign({}, x, { picked: x.id === id, wrong: false })),
    });
    this.tryMatch();
  },

  // 两边都有选中时才判：对 → 双双锁定变绿；错 → 抖动 600ms 后自动复位（零惩罚）
  tryMatch() {
    const li = this.data.matchLeft.find((x) => x.picked);
    const ri = this.data.matchRight.find((x) => x.picked);
    if (!li || !ri) return;

    if (match.isMatch(li.id, ri.id)) {
      const left = this.data.matchLeft.map((x) => (x.id === li.id ? Object.assign({}, x, { done: true, picked: false }) : x));
      const right = this.data.matchRight.map((x) => (x.id === ri.id ? Object.assign({}, x, { done: true, picked: false }) : x));
      const solved = left.filter((x) => x.done).length;
      const allDone = solved >= left.length;
      this.setData({ matchLeft: left, matchRight: right, matchSolved: solved, matchAllDone: allDone });
      if (allDone && typeof wx.vibrateShort === 'function') {
        try {
          wx.vibrateShort({ type: 'light' });
        } catch (e) {
          /* 机型不支持则忽略 */
        }
      }
      return;
    }

    // 配错：两边抖动提示。⚠️ 同时清掉 picked —— 否则孩子在这 600ms 内点新单词时，
    // 会立刻拿对侧残留的旧选择去比对，白白再判一次错。
    this.setData({
      matchLeft: this.data.matchLeft.map((x) => (x.picked ? Object.assign({}, x, { picked: false, wrong: true }) : x)),
      matchRight: this.data.matchRight.map((x) => (x.picked ? Object.assign({}, x, { picked: false, wrong: true }) : x)),
    });
    this.clearMatchTimer();
    this.matchTimer = setTimeout(() => {
      this.matchTimer = null;
      // 只复位标了 wrong 的项：若这 600ms 内孩子已经点选了下一次，不要动他的新选择
      this.setData({
        matchLeft: this.data.matchLeft.map((x) => (x.wrong ? Object.assign({}, x, { wrong: false }) : x)),
        matchRight: this.data.matchRight.map((x) => (x.wrong ? Object.assign({}, x, { wrong: false }) : x)),
      });
    }, 600);
  },

  // 全部配对完成 → 接进原有的庆祝三幕
  onMatchFinish() {
    this.clearMatchTimer();
    this.setData({ phase: 'celebrate' });
    this.startRewardShow(getWeekWords(this.data.week));
  },

  onNextWord() {
    const word = this.data.word;
    const score = this.wordScores[word.id] || SPEAK_SKIP;
    store.markWordLearned(word.id, score);
    // 学习量变化后立刻更新排行榜（未登录时静默跳过）
    leaderboard.push();
    const added = store.refreshAchievements();
    const view = this.data.weekWordsView.map((v) => (v.id === word.id ? Object.assign({}, v, { learned: true }) : v));
    const finishedCount = view.filter((v) => v.learned).length;
    const nextIndex = this.data.wordIndex + 1;
    const words = getWeekWords(this.data.week);

    if (nextIndex >= words.length) {
      // 5 词全部学完 → **立刻**结算日会话。
      // 刻意放在配对之前：孩子在配对环节中途退出，也不会丢掉当天的完成记录与连续天数。
      store.completeDailySession(MAX_WEEK, scheduler.localToday());
      store.refreshAchievements();
      store.syncToCloud();
      // 连学天数 / 当前周次也变了，再推一次排行榜
      leaderboard.push();
      const newAchievements = added.map((id) => store.ACHIEVEMENTS.find((a) => a.id === id)).filter(Boolean);

      if (!this.matchPlayed) {
        // 第 4 步：整组配对闯关（只在最后一个词之后出现一次，由 matchPlayed 把住）
        this.matchPlayed = true;
        this.setData({
          step: 4,
          maxStep: 4,
          weekWordsView: view,
          finishedCount,
          newAchievements,
          quiz: null,
          quizAnswered: false,
          quizCorrect: false,
          pickedIdx: -1,
        });
        this.startMatch(words);
        return;
      }

      this.setData({
        phase: 'celebrate',
        weekWordsView: view,
        finishedCount,
        newAchievements,
      });
      this.startRewardShow(words);
      return;
    }
    // 推进到最后一个词时要立刻把步数上限切到 4：
    // 否则第 5 个词会显示「第 4/3 步」，步骤 3 的按钮也不会变成「去配对 →」
    const enteringLastWord = nextIndex === words.length - 1;
    this.setData({
      wordIndex: nextIndex,
      word: words[nextIndex],
      step: 1,
      maxStep: enteringLastWord ? 4 : 3,
      quiz: null,
      quizAnswered: false,
      quizCorrect: false,
      pickedIdx: -1,
      recording: false,
      recorded: false,
      spokeWell: false,
      wordScore: 0,
      autoLevel: '',
      autoStarCount: 0,
      autoMsg: '',
      weekWordsView: view,
      finishedCount,
    });
    wx.nextTick(() => this.playWord().then(() => this.playPhrase({ silent: true })));
  },

  /* ---------- 奖励动画片（纯 CSS 动画，不联网、不占包体） ---------- */
  buildConfetti() {
    const icons = ['🎉', '✨', '⭐', '🎈', '🌈', '💫', '🎊', '🌟', '🍀', '🎁', '🎵', '💖'];
    const list = [];
    for (let i = 0; i < icons.length; i++) {
      list.push({
        id: i,
        icon: icons[i],
        left: 4 + Math.round(Math.random() * 88),
        delay: Math.round(Math.random() * 20) / 10, // 0 ~ 2.0s
        dur: (2 + Math.random()).toFixed(1), // 2.0 ~ 3.0s
        size: 26 + Math.round(Math.random() * 22),
      });
    }
    return list;
  },

  clearRewardTimers() {
    const timers = this.rewardTimers || [];
    for (let i = 0; i < timers.length; i++) clearTimeout(timers[i]);
    this.rewardTimers = [];
  },

  // 三幕演出：1 星星出场 → 2 小动物跳舞撒花 → 3 单词巡游 + 成就
  startRewardShow(words) {
    this.clearRewardTimers();
    this.setData({
      rewardStage: 1,
      rewardWords: (words || []).map((w) => ({
        id: w.id,
        word: w.word,
        meaning: w.meaning,
        imgTx: w.imgTx,
        imgTy: w.imgTy,
      })),
      confetti: this.buildConfetti(),
    });
    if (typeof wx.vibrateShort === 'function') {
      try {
        wx.vibrateShort({ type: 'medium' });
      } catch (e) {
        /* 机型不支持则忽略 */
      }
    }
    this.rewardTimers = [
      setTimeout(() => this.setData({ rewardStage: 2 }), 2600),
      setTimeout(() => this.setData({ rewardStage: 3 }), 5400),
    ];
  },

  onSkipReward() {
    this.clearRewardTimers();
    this.setData({ rewardStage: 3 });
  },

  onBackHome() {
    this.clearRewardTimers();
    wx.switchTab({ url: '/pages/index/index' });
  },
});
