-- PK 挑战改为站内通知：给被挑战者加「已读」标记
-- 应用：wbapp_EcdkdnGaleXC7Dje1430RC（WorkBuddy 云数据库 / PostgreSQL）
-- 已执行于 2026-10-22 14:36（通过 workbuddy_cloudservice_db_exec_sql，mode=migrate）
--
-- 用途：
--   utils/pkCloud.js 的 listIncoming(uid) 查「我收到的未读挑战」，条件为
--   target_id = uid AND status = 'pending' AND target_read = false
--   被挑战者点开答题页后 markRead(id) 把它置为 true，避免反复提示。
--
-- 注意：本工具单次只支持一条语句，故拆成两条分别执行。

ALTER TABLE pk_challenges ADD COLUMN IF NOT EXISTS target_read boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_pk_challenges_target_incoming
  ON pk_challenges (target_id, status, target_read, created_at DESC);
