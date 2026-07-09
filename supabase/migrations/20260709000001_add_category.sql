-- Story category on summaries. The `summarize` Edge Function fills it from the
-- SAME Gemini call that writes summary_vi (no extra API quota). Nullable: rows
-- summarized before this migration stay null and are treated as "uncategorized"
-- in the app (they only fall out of retention within ~7 days anyway).
--
-- No CHECK constraint on the value: the taxonomy is validated in the function
-- (unknown/absent -> null) and kept loose here so tweaking the list later needs
-- no schema change. No index: filtering is client-side over a tiny feed.
-- The existing table-level `grant select ... to authenticated` covers this new
-- column automatically.

alter table public.summaries add column if not exists category text;
