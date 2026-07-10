-- Vietnamese group title. The `summarize` Edge Function fills it from the SAME
-- Gemini call that writes summary_vi + category (no extra API quota): foreign
-- headlines get translated to VN, Vietnamese ones are kept as-is. Nullable:
-- rows summarized before this migration (or where the model omitted it) stay
-- null, and the app falls back to article_groups.title (the original headline).
-- No index; the existing table-level grant covers the new column.
alter table public.summaries add column if not exists title_vi text;
