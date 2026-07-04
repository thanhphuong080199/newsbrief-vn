-- newsbrief-vn: initial schema
-- Extensions ---------------------------------------------------------------

create extension if not exists vector with schema extensions;
create extension if not exists moddatetime with schema extensions;

-- Tables --------------------------------------------------------------------

create table public.sources (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  homepage_url    text,
  feed_url        text unique,
  fetch_method    text not null default 'rss' check (fetch_method in ('rss', 'scrape')),
  lang            text not null default 'vi',
  is_predefined   boolean not null default false,
  added_by        uuid references auth.users (id) on delete set null,
  active          boolean not null default true,
  last_fetched_at timestamptz,
  last_error      text,
  created_at      timestamptz not null default now()
);

create table public.user_sources (
  user_id   uuid not null references auth.users (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, source_id)
);

create table public.article_groups (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  embedding     extensions.vector(768) not null,
  first_seen_at timestamptz not null default now(),
  article_count int not null default 0 -- maintained by trigger on articles
);

create index article_groups_first_seen_idx on public.article_groups (first_seen_at);

create table public.articles (
  id           uuid primary key default gen_random_uuid(),
  source_id    uuid not null references public.sources (id) on delete cascade,
  group_id     uuid not null references public.article_groups (id) on delete cascade,
  url          text not null,
  url_hash     text not null unique,
  title        text not null,
  content      text,
  lang         text,
  published_at timestamptz,
  fetched_at   timestamptz not null default now()
);

create index articles_group_idx on public.articles (group_id);
create index articles_source_idx on public.articles (source_id);

create or replace function public.sync_group_article_count()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.article_groups set article_count = article_count + 1 where id = new.group_id;
  elsif tg_op = 'DELETE' then
    update public.article_groups set article_count = greatest(article_count - 1, 0) where id = old.group_id;
  end if;
  return null;
end
$$;

create trigger articles_sync_group_count
  after insert or delete on public.articles
  for each row execute function public.sync_group_article_count();

create table public.summaries (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null unique references public.article_groups (id) on delete cascade,
  summary_vi text,
  model      text,
  status     text not null default 'pending' check (status in ('pending', 'success', 'failed')),
  attempts   int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index summaries_pending_idx on public.summaries (created_at) where status = 'pending';

create trigger summaries_set_updated_at
  before update on public.summaries
  for each row execute function extensions.moddatetime (updated_at);

create table public.pins (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  group_id   uuid not null references public.article_groups (id), -- no cascade: pins exempt groups from cleanup
  note       text,
  created_at timestamptz not null default now(),
  unique (user_id, group_id)
);

create table public.app_config (
  key   text primary key,
  value jsonb not null
);

-- Dedup: nearest recent group above similarity threshold ---------------------

create or replace function public.match_article_group(
  query_embedding extensions.vector(768),
  similarity_threshold float,
  window_hours int
) returns uuid
language sql stable
set search_path = ''
as $$
  select g.id
  from public.article_groups g
  where g.first_seen_at > now() - make_interval(hours => window_hours)
    and 1 - (g.embedding operator(extensions.<=>) query_embedding) >= similarity_threshold
  order by g.embedding operator(extensions.<=>) query_embedding
  limit 1
$$;

-- Grants ----------------------------------------------------------------------
-- New public tables are no longer auto-exposed to the Data API roles
-- (config.toml auto_expose_new_tables default), so grant explicitly.
-- RLS below still restricts what `authenticated` can actually touch.

grant select on public.sources, public.article_groups, public.articles,
  public.summaries, public.app_config to authenticated;
grant insert, update, delete on public.sources to authenticated;
grant select, insert, update, delete on public.user_sources, public.pins to authenticated;
grant all on all tables in schema public to service_role;

-- Row Level Security ----------------------------------------------------------
-- Edge Functions use the service role key and bypass RLS entirely.

alter table public.sources enable row level security;
alter table public.user_sources enable row level security;
alter table public.article_groups enable row level security;
alter table public.articles enable row level security;
alter table public.summaries enable row level security;
alter table public.pins enable row level security;
alter table public.app_config enable row level security;

create policy "read sources" on public.sources
  for select to authenticated using (true);

create policy "add custom sources" on public.sources
  for insert to authenticated
  with check (added_by = auth.uid() and is_predefined = false);

create policy "manage own custom sources" on public.sources
  for update to authenticated
  using (added_by = auth.uid()) with check (added_by = auth.uid() and is_predefined = false);

create policy "delete own custom sources" on public.sources
  for delete to authenticated using (added_by = auth.uid() and is_predefined = false);

create policy "manage own subscriptions" on public.user_sources
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "read groups" on public.article_groups
  for select to authenticated using (true);

create policy "read articles" on public.articles
  for select to authenticated using (true);

create policy "read summaries" on public.summaries
  for select to authenticated using (true);

create policy "manage own pins" on public.pins
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "read config" on public.app_config
  for select to authenticated using (true);

-- Seed: runtime config --------------------------------------------------------

insert into public.app_config (key, value) values
  ('retention_days',             '7'),
  ('dedup_similarity_threshold', '0.85'),
  ('dedup_window_hours',         '72'),
  ('summarize_batch_size',       '10'),
  ('summarize_max_attempts',     '8'),
  ('max_items_per_source',       '20'),
  ('max_page_extractions_per_run', '8'),
  ('model_fallback_order',       '["gemini-3.5-flash","gemini-3.1-flash-lite","gemini-2.5-flash-lite"]');

-- Seed: predefined sources (feed URLs verified 2026-07-03) ---------------------

insert into public.sources (name, homepage_url, feed_url, fetch_method, lang, is_predefined, active) values
  ('VnExpress',        'https://vnexpress.net',   'https://vnexpress.net/rss/tin-moi-nhat.rss', 'rss', 'vi', true, true),
  ('Tuổi Trẻ',         'https://tuoitre.vn',      'https://tuoitre.vn/rss/tin-moi-nhat.rss',    'rss', 'vi', true, true),
  ('Thanh Niên',       'https://thanhnien.vn',    'https://thanhnien.vn/rss/home.rss',          'rss', 'vi', true, true),
  ('Dân Trí',          'https://dantri.com.vn',   'https://dantri.com.vn/rss/home.rss',         'rss', 'vi', true, true),
  ('VietnamNet',       'https://vietnamnet.vn',   'https://vietnamnet.vn/rss/thoi-su.rss',      'rss', 'vi', true, true),
  ('BBC News (World)', 'https://www.bbc.com/news','http://feeds.bbci.co.uk/news/world/rss.xml', 'rss', 'en', true, true);
