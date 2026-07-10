-- Expand the summarize fallback chain from 3 to 6 models. The old chain
-- (3.5-flash, 3.1-flash-lite, 2.5-flash-lite) exhausted its free-tier daily
-- quota around midday. Free-tier quota is PER-MODEL, so adding distinct working
-- models adds real daily capacity. All six were live-tested against the project
-- key (2026-07-10): each returns text via generateContent. The two Gemma models
-- draw from a separate quota pool, and 3-flash-preview is a distinct bucket from
-- 3.5-flash. Order is quality-first, then the cheaper/faster lite + Gemma tiers
-- as capacity fallbacks. Pro and 2.0 models were excluded (429/404 on free tier).
update public.app_config
set value = '["gemini-3.5-flash","gemini-3-flash-preview","gemini-3.1-flash-lite","gemini-2.5-flash-lite","gemma-4-31b-it","gemma-4-26b-a4b-it"]'
where key = 'model_fallback_order';
