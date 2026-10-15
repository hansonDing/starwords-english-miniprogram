const { WORDS, getWordById } = require('../../utils/words');
const store = require('../../utils/store');
const scheduler = require('../../utils/scheduler');
const audio = require('../../utils/audio');

const DISTRACTORS = 'abcdefghilmnoprstuw';

// 学习记录每页条数（「加载更多」每次追加这么多）
const RECORDS_PAGE_SIZE = 10;

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
    mode: 'quick', // quick | spelling | records
    // 快速复习
    dueWords: [],
    quizIndex: -1,
    quiz: null,
    quizAnswered: false,
    quizCorrect: false,
    pickedIdx: -1,
    reviewDone: false,
    reviewedCount: 0,
    totalReviewed: 0,
    // 错题本：本轮复习做错的单词（含正确含义），复习结束时展示
    wrongList: [],
    // 拼写
    spellWords: [],
    spellIndex: -1,
    spell: null, // { word, meaning, image, tiles: [{char, used}], filled: [] }
    spellFeedback: '',
    spellDone: false,
    // 记录
    records: [],
    recordsTotal: 0,
    recordsHasMore: false,
  },

  sessionResults: [],
  // 全部已学单词（按最近学习倒序）。只显示前若干条，避免一次性塞给 setData
  allRecords: [],

  onShow() {
    this.refresh();
  },

  onHide() {
    audio.stop();
  },

  refresh() {
    const progress = store.getProgress();
    const today = scheduler.localToday();
    const due = scheduler.getDueReviews(progress, today).map((wp) => getWordById(wp.wordId)).filter(Boolean);
    // 学习记录：显示**所有**学过的单词（按最近学习倒序），首页只取一页，其余靠「加载更多」追加
    const learnedIds = progress.words
      .filter((w) => w.learned)
      .sort((a, b) => (a.lastAttemptAt < b.lastAttemptAt ? 1 : -1));
    this.allRecords = learnedIds
      .map((wp) => {
        const wd = getWordById(wp.wordId);
        if (!wd) return null;
        return {
          id: wp.wordId,
          word: wd.word,
          meaning: wd.meaning,
          imgTx: wd.imgTx,
          imgTy: wd.imgTy,
          score: wp.score,
          date: wp.learnedDate || '',
        };
      })
      .filter(Boolean);
    const firstPage = this.allRecords.slice(0, RECORDS_PAGE_SIZE);
    this.setData({
      dueWords: due,
      records: firstPage,
      recordsTotal: this.allRecords.length,
      recordsHasMore: this.allRecords.length > firstPage.length,
      reviewDone: false,
      quizIndex: -1,
      spellDone: false,
      spellIndex: -1,
      wrongList: [],
    });
    if (this.data.mode === 'quick' && due.length > 0) {
      this.startQuickQuiz();
    }
  },

  /** 学习记录：再显示一页 */
  onLoadMoreRecords() {
    const shown = this.data.records.length;
    if (shown >= this.allRecords.length) return;
    const next = this.allRecords.slice(0, shown + RECORDS_PAGE_SIZE);
    this.setData({
      records: next,
      recordsHasMore: next.length < this.allRecords.length,
    });
  },

  /* ---------- 模式切换 ---------- */
  onModeChange(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({ mode, reviewDone: false, spellDone: false, quizIndex: -1, spellIndex: -1, quizAnswered: false, wrongList: [] });
    if (mode === 'quick') this.startQuickQuiz();
    if (mode === 'spelling') this.startSpelling();
  },

  /* ---------- 快速复习（选择题） ---------- */
  startQuickQuiz() {
    const due = this.data.dueWords;
    if (due.length === 0) return;
    this.sessionResults = [];
    this.setData({ quizIndex: 0, quizAnswered: false, pickedIdx: -1 });
    this.setupQuiz(due[0]);
  },

  setupQuiz(word) {
    const type = Math.random() < 0.5 ? 'listen-pick' : 'meaning-pick';
    const others = WORDS.filter((x) => x.id !== word.id);
    const options = shuffle([word].concat(shuffle(others).slice(0, 3))).map((x) => ({
      id: x.id,
      word: x.word,
      meaning: x.meaning,
    }));
    this.setData({
      quiz: { type, options, answerIdx: options.findIndex((x) => x.id === word.id) },
      currentWord: word,
    });
    if (type === 'listen-pick') {
      wx.nextTick(() => audio.play(word.audio).catch(() => {}));
    }
  },

  onPlayQuizAudio() {
    if (this.data.currentWord) audio.play(this.data.currentWord.audio).catch(() => {});
  },

  onPickOption(e) {
    if (this.data.quizAnswered) return;
    const idx = e.currentTarget.dataset.idx;
    const correct = idx === this.data.quiz.answerIdx;
    store.recordReviewResult(this.data.currentWord.id, correct);
    store.syncToCloud();
    this.sessionResults.push({ wordId: this.data.currentWord.id, correct });
    this.setData({ quizAnswered: true, quizCorrect: correct, pickedIdx: idx });
  },

  onNextReview() {
    const next = this.data.quizIndex + 1;
    if (next >= this.data.dueWords.length) {
      const correctCount = this.sessionResults.filter((r) => r.correct).length;
      // 错题本：本轮答错的单词 + 正确含义（复习结束时给孩子一个「回头看」的清单）
      const wrongList = this.sessionResults
        .filter((r) => !r.correct)
        .map((r) => {
          const wd = getWordById(r.wordId);
          if (!wd) return null;
          return {
            id: r.wordId,
            word: wd.word,
            meaning: wd.meaning,
            phonetic: wd.phonetic || '',
            imgTx: wd.imgTx,
            imgTy: wd.imgTy,
          };
        })
        .filter(Boolean);
      store.refreshAchievements();
      this.setData({
        reviewDone: true,
        quizIndex: -1,
        reviewedCount: correctCount,
        totalReviewed: this.sessionResults.length,
        wrongList: wrongList,
      });
      return;
    }
    this.setData({ quizIndex: next, quizAnswered: false, pickedIdx: -1 });
    this.setupQuiz(this.data.dueWords[next]);
  },

  /* ---------- 拼写挑战 ---------- */
  startSpelling() {
    const progress = store.getProgress();
    const learned = progress.words
      .filter((w) => w.learned)
      .sort(() => Math.random() - 0.5)
      .slice(0, 5)
      .map((wp) => getWordById(wp.wordId))
      .filter(Boolean);
    if (learned.length === 0) {
      this.setData({ spellDone: true, spellIndex: -1 });
      return;
    }
    this.setData({ spellWords: learned, spellIndex: 0, spellDone: false, spellFeedback: '' });
    this.setupSpelling(learned[0]);
  },

  setupSpelling(word) {
    const letters = word.word.toLowerCase().replace(/[^a-z]/g, '').split('');
    const extra = shuffle(DISTRACTORS.split('').filter((c) => letters.indexOf(c) === -1)).slice(0, 2);
    const tiles = shuffle(letters.concat(extra)).map((char, idx) => ({ char, used: false, idx }));
    this.setData({
      spell: { word, tiles, filled: [], target: letters },
    });
    wx.nextTick(() => audio.play(word.audio).catch(() => {}));
  },

  onPlaySpellAudio() {
    const s = this.data.spell;
    if (s) audio.play(s.word.audio).catch(() => {});
  },

  onTileTap(e) {
    const idx = e.currentTarget.dataset.idx;
    const spell = this.data.spell;
    if (spell.tiles[idx].used) return;
    if (spell.filled.length >= spell.target.length) return;
    const tiles = spell.tiles.map((t, i) => (i === idx ? Object.assign({}, t, { used: true }) : t));
    const filled = spell.filled.concat([{ char: spell.tiles[idx].char, from: idx }]);
    this.setData({ spell: Object.assign({}, spell, { tiles, filled }) });
    // 集齐后自动判定
    if (filled.length === spell.target.length) {
      const guess = filled.map((f) => f.char).join('');
      const target = spell.target.join('');
      const correct = guess === target;
      store.recordReviewResult(spell.word.id, correct);
      store.syncToCloud();
      store.refreshAchievements();
      this.setData({
        spellCorrect: correct,
        spellFeedback: correct ? '太棒了！拼写正确 🎉' : '正确拼写：' + spell.word.word,
      });
    }
  },

  onUndoTap() {
    const spell = this.data.spell;
    if (spell.filled.length === 0) return;
    const last = spell.filled[spell.filled.length - 1];
    const tiles = spell.tiles.map((t, i) => (i === last.from ? Object.assign({}, t, { used: false }) : t));
    this.setData({ spell: Object.assign({}, spell, { tiles, filled: spell.filled.slice(0, -1) }) });
  },

  onNextSpell() {
    const next = this.data.spellIndex + 1;
    if (next >= this.data.spellWords.length) {
      this.setData({ spellDone: true, spellIndex: -1 });
      return;
    }
    this.setData({ spellIndex: next, spellFeedback: '' });
    this.setupSpelling(this.data.spellWords[next]);
  },

  // 单词图已合并为单张精灵图（assets/sprite.jpg），没有第二份可降级的图源，
  // 下面两个空实现仅为了兜住 <image> 的 binderror。
  onSpellImgError() {},

  onRecordImgError() {},
});
