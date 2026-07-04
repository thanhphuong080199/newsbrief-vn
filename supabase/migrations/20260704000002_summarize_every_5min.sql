-- Run summarize every 5 minutes instead of every 15.
--
-- The feed orders groups newest-first, and each summarize run only clears
-- `summarize_batch_size` groups (5, to stay under the ~150s Edge Function
-- limit). At */15 the backlog drained slower than new groups arrived, so the
-- top of the feed was perpetually "Đang tóm tắt…". */5 tripling the run rate
-- (~60 groups/hr) keeps intake and summarization roughly balanced.
--
-- Cron cadence does NOT increase Gemini usage: the function only calls the API
-- for `pending` rows, so idle runs (nothing pending) make zero calls. Total
-- daily calls are bounded by new-group volume, not run frequency.
--
-- The old job was already deployed under the name 'summarize-15min'; drop it
-- and recreate under an accurate name. unschedule is guarded so a fresh DB
-- (where the old job never existed) still applies cleanly.

do $$
begin
  perform cron.unschedule('summarize-15min');
exception when others then
  null; -- job didn't exist (fresh database) — ignore
end $$;

select cron.schedule(
  'summarize-5min',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/summarize',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
