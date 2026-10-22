-- 2026-10-22 「我的」页「我发起的 PK」支持手工删除
--
-- 背景：pk_challenges 原来只有 insert / select / update 三条策略，
--       前端 delete 会被 RLS 静默挡掉（0 行，不报错）。
--       之所以走「真删」而不是加一个 deleted 标记列：
--       现有 update 策略是 USING (status = 'pending')，
--       已完成的挑战（status='done'）根本 update 不动，标记列写不进去。
--
-- 权限：authenticated 已有 DELETE 表权限（anon 没有，也不需要 ——
--       创建挑战要求登录，insert 策略本身就依赖 auth.uid()）。
-- 范围：只能删自己发起的行（challenger_id = 当前登录用户）。

DROP POLICY IF EXISTS pk_challenges_delete ON pk_challenges;

CREATE POLICY pk_challenges_delete ON pk_challenges
  FOR DELETE
  TO authenticated
  USING (challenger_id = auth.uid());
