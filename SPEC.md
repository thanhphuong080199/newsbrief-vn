# SPEC — newsbrief-vn

> Source of truth for what we're building. Keep updated as the design evolves.
> Last updated: 2026-07-09 (v1 shipped + deployed; added §7 feature backlog to build one at a time — see PROGRESS.md)

## 1. Product Overview

A personal news aggregator mobile app for **research/testing purposes only** (3–4 test users, no commercialization). The backend automatically pulls articles from news sources, groups near-duplicate stories covered by multiple outlets, and summarizes every story **in Vietnamese** (translating foreign-language articles).

## 2. Features

### 2.1 Source management
- Predefined list of popular Vietnamese news sites (VnExpress, Tuổi Trẻ, Thanh Niên, Dân Trí, VietnamNet, …) seeded in the DB.
- Users can subscribe/unsubscribe to predefined sources and add custom sources by URL or RSS feed.
- Foreign-language (e.g., English) sources are supported.

### 2.2 Fetching
- Prefer RSS feeds. For a custom URL without a known feed, discover it via `<link rel="alternate" type="application/rss+xml">` in the page head.
- If no feed exists, fall back to readability-style content extraction on the page.
- If the RSS item body is thin (description only), fetch the article page and extract full text for better summarization — **capped at `max_page_extractions_per_run` (default 8) per ingest run**, because Edge Functions get ~2s CPU per request and readability parsing costs ~100–250ms/page. Over-budget articles keep their RSS description (the summarizer copes with short content).

### 2.3 Deduplication (story grouping)
- Two layers:
  1. **Exact dedup**: SHA-256 hash of the normalized article URL (`url_hash`, unique) — an article is never ingested or summarized twice.
  2. **Story grouping**: embed `title + first ~300 chars` with `gemini-embedding-001` (free tier; batch calls chunked to 40 texts with 30s pacing — the free tier counts each batched text against the ~100 RPM quota), store in pgvector. A new article joins an existing `article_group` if cosine similarity ≥ threshold (start at **0.85**, tune later) against groups first seen in the last **72h**; otherwise it starts a new group.
- Scale is tiny (a few hundred articles/day), so group matching is a brute-force `ORDER BY embedding <=> $1 LIMIT 1` query over recent groups — no ANN index needed.
- Decision rationale: pure text similarity (pg_trgm) misses paraphrased headlines across outlets; embeddings are free on Gemini and pgvector is built into Supabase, so the "smarter" option costs nothing extra. (See PROGRESS.md decisions log.)

### 2.4 Summarization (Vietnamese, with fallback)
- One summary **per article group** (not per article), generated from the group's articles' content.
- All summaries are in Vietnamese regardless of source language (prompt instructs translate-then-summarize).
- **Fallback chain** (free-tier models only — Gemini Pro models left the free tier in April 2026):
  1. `gemini-3.5-flash` (primary)
  2. `gemini-3.1-flash-lite`
  3. `gemini-2.5-flash-lite` (last resort, highest free RPD)
- Per model: on HTTP 429/503, retry up to 2 times with exponential backoff + jitter (~2s, ~5s), honoring `Retry-After` if present. Then move to the next model.
- If all models fail: the summary row stays `pending` with `attempts` incremented — a later cron run retries it. Never fails the whole batch; each group is processed independently.
- The `model` column records which model actually produced each summary (quota monitoring/debugging).
- Batch cap per run (default **10** groups) to stay inside free-tier RPM/RPD.

### 2.5 Data lifecycle & pinning
- Non-pinned story groups (with their articles and summaries) are deleted after **7 days** (configurable via `app_config.retention_days`).
- A user can pin a story with an optional note. A group pinned by **any** user is never auto-deleted.

### 2.6 Scheduling
- Backend-driven via Supabase `pg_cron` + `pg_net` (HTTP-invokes Edge Functions); independent of the app being open.
- `ingest`: hourly (configurable by editing the cron schedule).
- `summarize`: every 15 minutes (acts as both the main summarization pass and the retry pass for `pending` items).
- `cleanup`: daily at 03:00 — pure SQL, no Edge Function.

## 3. Tech Stack
- **Mobile app**: Expo SDK 57 (React Native 0.86, React 19.2), plain React Native components, no navigation library (hand-rolled 2-tab bar). Uses `react-native-safe-area-context` for device insets (RN's own `SafeAreaView` is a no-op on Android). Lives in `mobile/`. Supabase client with AsyncStorage session persistence; config via `EXPO_PUBLIC_*` env vars in `mobile/.env`. UI language: Vietnamese.
- **Backend**: Supabase free tier — Postgres (+ `pgvector`, `pg_cron`, `pg_net`), Edge Functions (Deno). No separate server.
- **LLM**: Google Gemini API free tier (models above; `gemini-embedding-001` for dedup embeddings).
- **Auth**: Supabase **anonymous** auth — no login screen. On first launch the app calls `signInAnonymously()`, creating a per-device `auth.users` row whose session persists in AsyncStorage; every later launch reuses the same anonymous user id. This keeps `auth.uid()` / RLS / the `auth.users` FKs unchanged. Tradeoff: clearing app storage or reinstalling creates a fresh identity (pins/subscriptions don't survive it). Requires `enable_anonymous_sign_ins = true` (in `config.toml` for local; must also be enabled in the hosted project's Auth settings).

## 4. Database Schema

```
sources
  id            uuid PK default gen_random_uuid()
  name          text not null
  homepage_url  text
  feed_url      text                -- null until discovered; null + scrape method = extract from page
  fetch_method  text not null default 'rss'   -- 'rss' | 'scrape'
  lang          text not null default 'vi'    -- ISO 639-1 hint for the summarizer
  is_predefined boolean not null default false
  added_by      uuid FK -> auth.users, null   -- null for predefined
  active        boolean not null default true
  last_fetched_at timestamptz
  last_error    text                -- last fetch failure, for debugging
  created_at    timestamptz default now()
  UNIQUE (feed_url)

user_sources                        -- per-user subscriptions
  user_id       uuid FK -> auth.users
  source_id     uuid FK -> sources ON DELETE CASCADE
  PK (user_id, source_id)

article_groups                      -- one row = one underlying story
  id            uuid PK
  title         text not null       -- title of the first article in the group
  embedding     vector(768)         -- embedding of the first article; new articles match against this
  first_seen_at timestamptz default now()
  article_count int not null default 1

articles
  id            uuid PK
  source_id     uuid FK -> sources ON DELETE CASCADE
  group_id      uuid FK -> article_groups ON DELETE CASCADE
  url           text not null
  url_hash      text not null UNIQUE   -- sha256 of normalized URL (exact dedup)
  title         text not null
  content       text                -- extracted body text (input to summarizer)
  lang          text
  published_at  timestamptz
  fetched_at    timestamptz default now()

summaries                           -- one per group
  id            uuid PK
  group_id      uuid UNIQUE FK -> article_groups ON DELETE CASCADE
  summary_vi    text                -- null while pending
  model         text                -- model that produced summary_vi
  status        text not null default 'pending'  -- 'pending' | 'success' | 'failed'
  attempts      int not null default 0
  last_error    text
  created_at    timestamptz default now()
  updated_at    timestamptz default now()

pins
  id            uuid PK
  user_id       uuid FK -> auth.users
  group_id      uuid FK -> article_groups   -- NO cascade; blocks/exempts cleanup
  note          text
  created_at    timestamptz default now()
  UNIQUE (user_id, group_id)

app_config                          -- runtime-tunable settings
  key           text PK
  value         jsonb not null
  -- seeded rows:
  --   retention_days: 7
  --   dedup_similarity_threshold: 0.85
  --   dedup_window_hours: 72
  --   summarize_batch_size: 10
  --   summarize_max_attempts: 8
  --   max_items_per_source: 20
  --   max_page_extractions_per_run: 8
  --   model_fallback_order: ["gemini-3.5-flash","gemini-3.1-flash-lite","gemini-2.5-flash-lite"]
```

Status lifecycle of `summaries.status`:
- `pending` → `success` (summary produced) — terminal.
- `pending` stays `pending` on transient failure (429/503 on all models), `attempts++`.
- `pending` → `failed` when `attempts >= summarize_max_attempts` or on a permanent error (e.g., safety block, empty content). `failed` rows are skipped by cron but visible for debugging.

### RLS policy sketch
- All app users are authenticated Supabase users.
- `sources`, `article_groups`, `articles`, `summaries`: SELECT for authenticated; no client writes (Edge Functions use service role key and bypass RLS). Exception: authenticated users may INSERT into `sources` (custom sources).
- `user_sources`, `pins`: full CRUD where `user_id = auth.uid()`.

## 5. Edge Functions

Both functions are invoked by `pg_cron` via `pg_net` HTTP POST with the service-role key. Shared code lives in `supabase/functions/_shared/`.

### 5.1 `ingest` — fetch + group (hourly)
- **Trigger**: pg_cron, hourly.
- **Input**: none (reads all `sources` where `active = true`).
- **Steps**:
  1. For each active source: fetch feed (or discover feed / scrape per `fetch_method`); parse items.
  2. Normalize each item URL, compute `url_hash`, skip hashes already in `articles` (single `IN` query per source).
  3. For new items with thin RSS content, fetch the article page and extract body text (lightweight readability extraction).
  4. Batch-embed new articles' `title + lead` via `gemini-embedding-001` (one call, up to 100 texts).
  5. For each new article: nearest-group query over groups from the last `dedup_window_hours`; join group if similarity ≥ threshold, else create group + a `pending` summary row.
  6. Update `sources.last_fetched_at` / `last_error` per source; a failing source never aborts the run.
- **Output**: JSON stats `{sources_ok, sources_failed, new_articles, new_groups}` (also `console.log`ged for Supabase function logs).
- **Error handling**: per-source and per-article try/catch; per-source fetch timeout (~10s); overall item cap per run as a safety valve against Edge Function wall-clock limits.

### 5.2 `summarize` — LLM pass + retry pass (every 15 min)
- **Trigger**: pg_cron, every 15 minutes. There is no separate retry function — this same pass naturally picks up leftovers because failed rows stay `pending`.
- **Input**: none (selects up to `summarize_batch_size` `summaries` where `status = 'pending'` and `attempts < summarize_max_attempts`, oldest first).
- **Steps**: for each pending row, build prompt from the group's articles' title+content (truncated to a sane token budget), call Gemini through the fallback chain (§2.4), then update the row (`summary_vi`, `model`, `status`, `attempts`, `last_error`).
- **Sequential, not parallel**, with a small delay between calls — free-tier RPM is the binding constraint.
- **Circuit breaker**: if a model returns 429 with a daily-quota signal, skip that model for the rest of the run.
- **Output**: JSON stats `{succeeded, still_pending, failed, per_model_counts}`.

### 5.3 `cleanup` — pure SQL (daily, no Edge Function)
```sql
DELETE FROM article_groups g
WHERE g.first_seen_at < now() - make_interval(days => (SELECT (value)::int FROM app_config WHERE key = 'retention_days'))
  AND NOT EXISTS (SELECT 1 FROM pins p WHERE p.group_id = g.id);
```
Articles and summaries cascade. Runs directly in pg_cron.

## 6. Configuration

| Setting | Where | Default |
|---|---|---|
| `retention_days` | `app_config` table | 7 |
| `dedup_similarity_threshold` | `app_config` | 0.85 |
| `dedup_window_hours` | `app_config` | 72 |
| `summarize_batch_size` | `app_config` | 10 |
| `summarize_max_attempts` | `app_config` | 8 |
| `max_items_per_source` | `app_config` | 20 |
| `max_page_extractions_per_run` | `app_config` | 8 |
| `model_fallback_order` | `app_config` | 3.5-flash → 3-flash-preview → 3.1-flash-lite → 2.5-flash-lite → gemma-4-31b-it → gemma-4-26b-a4b-it |
| Cron schedules | pg_cron jobs (migration) | ingest hourly, summarize */15, cleanup daily |
| `GEMINI_API_KEY` | Supabase Edge Function secrets | — |

## 7. Planned features / backlog (v1.0 done; these are next)

The v1 SPEC (§1–§6) is fully implemented. These are candidate enhancements, ordered by value-for-effort. **We build them one at a time** — pick the next `[ ]` item, spec the details, implement, then check it off. Mark `[x]` when shipped.

### Cheap wins (reuse existing data model / LLM call — no extra Gemini quota)

- [x] **1. Category / topic tagging + feed filter** *(shipped 2026-07-09)*
  - `summarize` emits a `category` in the **same** Gemini call (no extra API cost), constrained to a fixed VN taxonomy: Thời sự, Thế giới, Kinh tế, Thể thao, Công nghệ, Giải trí, Sức khỏe, Giáo dục, Pháp luật, Khác.
  - Stored as nullable `summaries.category` (migration `20260709000001`); parsed from a labeled `PHÂN LOẠI:` / `TÓM TẮT:` response — parse is resilient (unknown/absent category → null, summary never dropped).
  - Feed shows dynamic filter chips (only categories present in the feed) + a category badge on each card and the detail screen. Rows summarized before the change stay null (uncategorized) and drain within retention.
- [x] **2. "Trending / Nổi bật" sort** *(shipped 2026-07-09)*
  - Feed sort toggle: "Mới nhất" (query's `first_seen_at desc`) / "Nổi bật" (client-sorts the loaded set by `article_count desc`, then recency). Reuses existing `article_count`; no backend change.
- [x] **3. Share button** *(shipped 2026-07-09)*
  - Native share sheet (RN `Share`) on the detail screen — shares title + VN summary + per-source links. Mobile-only, no backend.
- [x] **4. Read / unread state** *(shipped 2026-07-09)*
  - `reads (user_id, group_id, read_at)` table (migration `20260709000002`) with RLS `user_id = auth.uid()`, cascades on user+group delete. Client optimistically upserts on detail-open; read stories show a greyed title in the feed.
- [x] **4b. Vietnamese title translation** *(shipped 2026-07-10)*
  - `summarize` emits a `TIÊU ĐỀ:` (VN title) in the **same** Gemini call (no extra API cost): foreign headlines are translated to Vietnamese, Vietnamese ones kept as-is. Stored as nullable `summaries.title_vi` (migration `20260710000002`), parsed resiliently (absent → null). Feed/detail/share display `title_vi ?? article_groups.title`; per-source rows keep original headlines. Rows summarized before the change fall back to the original title.

### Bigger bets (still free-tier-friendly)

- [ ] **5. Vietnamese full-text search**
  - Postgres `tsvector` over group title + `summary_vi`; search bar in the feed. No LLM cost. VN diacritics/tokenization to be handled in the detailed spec.
- [ ] **6. Daily digest ("Bản tin sáng")**
  - One extra Gemini call/day summarizing the top N groups into a single "N điều đáng chú ý hôm nay" card. One digest table/row + one small daily cron + one screen.
- [ ] **7. Push notifications** *(heaviest lift)*
  - Expo push tokens stored per anonymous user; a cron/function that notifies when a big new story lands in a followed category. Needs token storage, a delivery function, and on-device testing. Depends on #1 (categories) to be useful.

## 8. Out of Scope (unless decided otherwise later)
- No login/sign-up/onboarding flow (identity is per-device anonymous auth), no account recovery/link across devices or reinstalls, or multi-tenant isolation of articles (articles/groups/summaries are shared globally; only subscriptions and pins are per-user).
- No per-user summarization preferences (length, tone).
- No image/media handling — text only.
- No analytics, no payments, no commercialization features.
- No iOS shareable builds (needs a paid Apple account) — Android APK only.
- Paywall bypassing: paywalled articles are summarized from whatever public content the feed/page exposes; we do not circumvent paywalls.

> Note: full-text search (§7 #5) and push notifications (§7 #7) were originally out of scope in v1; they've been promoted to the backlog for consideration.
