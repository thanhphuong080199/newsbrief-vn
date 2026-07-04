-- Tune summarize batch size for hosted Edge Function limits.
--
-- On Supabase hosted, an Edge Function request is killed at ~150s wall-clock
-- (WORKER_RESOURCE_LIMIT). A batch of 10 summaries at 4s inter-call pacing plus
-- Gemini latency/retries overran that (~152s on the first prod run). Drop the
-- batch to 5 so each run finishes well under the limit; the */15 cron still
-- clears the backlog steadily (and doubles as the retry pass).
update public.app_config set value = '5' where key = 'summarize_batch_size';
