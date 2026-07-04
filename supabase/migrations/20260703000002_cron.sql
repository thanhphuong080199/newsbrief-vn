-- newsbrief-vn: scheduled jobs (pg_cron + pg_net)
--
-- The two Edge Function jobs read the project URL and service role key from
-- Supabase Vault at RUN time. Before they can succeed, create the secrets once
-- (SQL editor in the dashboard):
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<service-role-key>', 'service_role_key');

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Ingest: fetch feeds + group new articles, hourly at :05
select cron.schedule(
  'ingest-hourly',
  '5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

-- Summarize: process pending summaries (doubles as the retry pass), every 15 min
select cron.schedule(
  'summarize-15min',
  '*/15 * * * *',
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

-- Cleanup: delete non-pinned story groups past retention (articles + summaries
-- cascade). Pure SQL — no Edge Function. Daily 20:00 UTC = 03:00 Vietnam time.
select cron.schedule(
  'cleanup-daily',
  '0 20 * * *',
  $$
  delete from public.article_groups g
  where g.first_seen_at < now() - make_interval(
          days => (select (value #>> '{}')::int from public.app_config where key = 'retention_days'))
    and not exists (select 1 from public.pins p where p.group_id = g.id);
  $$
);
