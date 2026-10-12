// 艾宾浩斯复习调度：与 Web 版 lib/scheduler.ts 逻辑一致
const REVIEW_INTERVALS = [1, 2, 4, 7, 15]; // 学后第 1、2、4、7、15 天各复习一次
const GRADUATED_STAGE = REVIEW_INTERVALS.length; // 通过全部 5 次复习即毕业
const MAX_DAILY_REVIEWS = 15;

/** 设备本地日期 YYYY-MM-DD（不用 toISOString，那是 UTC） */
function localToday(now) {
  now = now || new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

/** 在本地日期串上加减天数（按本地日历） */
function addDays(dateStr, days) {
  const parts = dateStr.split('-').map(Number);
  return localToday(new Date(parts[0], parts[1] - 1, parts[2] + days));
}

/** 今日是否还能学新词：严格自然日，学完即锁到明天 */
function canLearnToday(progress, today) {
  return progress.lastLearnedDate !== today;
}

/** 到期复习队列：过期最久的优先，截断到 limit */
function getDueReviews(progress, today, limit) {
  limit = limit || MAX_DAILY_REVIEWS;
  return progress.words
    .filter((w) => w.learned && w.nextReviewDate !== null && w.nextReviewDate <= today && w.reviewStage < GRADUATED_STAGE)
    .sort((a, b) => {
      if (a.nextReviewDate !== b.nextReviewDate) {
        return a.nextReviewDate < b.nextReviewDate ? -1 : 1;
      }
      return 0;
    })
    .slice(0, limit);
}

/** 复习作答结果 → 新的调度状态：答对晋级，答错退级（最低 0）明天再来 */
function applyReviewResult(wp, correct, today) {
  const stage = correct ? Math.min(wp.reviewStage + 1, GRADUATED_STAGE) : Math.max(wp.reviewStage - 1, 0);
  const graduated = stage >= GRADUATED_STAGE;
  return {
    wordId: wp.wordId,
    learned: wp.learned,
    score: wp.score,
    attempts: wp.attempts,
    lastAttemptAt: wp.lastAttemptAt,
    learnedDate: wp.learnedDate,
    reviewStage: stage,
    nextReviewDate: graduated ? null : addDays(today, correct ? REVIEW_INTERVALS[stage] : 1),
  };
}

module.exports = {
  REVIEW_INTERVALS,
  GRADUATED_STAGE,
  MAX_DAILY_REVIEWS,
  localToday,
  addDays,
  canLearnToday,
  getDueReviews,
  applyReviewResult,
};
