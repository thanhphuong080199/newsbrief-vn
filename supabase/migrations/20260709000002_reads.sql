-- Per-user read state (feature #4). One row = "this user opened this story".
-- Client upserts on detail-open; the feed dims already-read groups. Cascades on
-- both sides so deleting a user or a cleaned-up group drops the read rows.
-- Only the authenticated client touches this table (never the Edge Functions),
-- so no service_role grant is needed — cleanup relies on the FK cascade.

create table public.reads (
  user_id  uuid not null references auth.users (id) on delete cascade,
  group_id uuid not null references public.article_groups (id) on delete cascade,
  read_at  timestamptz not null default now(),
  primary key (user_id, group_id)
);

alter table public.reads enable row level security;

grant select, insert, update, delete on public.reads to authenticated;

create policy "manage own reads" on public.reads
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
