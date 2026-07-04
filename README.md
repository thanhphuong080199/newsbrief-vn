# newsbrief-vn

Personal news aggregator app that pulls articles from Vietnamese & international sources, deduplicates overlapping stories, and generates Vietnamese summaries via Gemini. Built with Expo + Supabase (Edge Functions, Postgres, Cron). Research/personal project, not for production use.

📖 **[SPEC.md](SPEC.md)** — what the system should do (schema, functions, config).
📋 **[PROGRESS.md](PROGRESS.md)** — what's actually done, changelog, decisions.

## Repo layout

```
supabase/
  migrations/           # schema + RLS + seeds, then cron jobs
  functions/
    _shared/            # db client, config, gemini client, rss, extraction
    ingest/             # hourly: fetch feeds -> extract -> embed -> group
    summarize/          # every 15 min: pending summaries -> Gemini (with fallback)
```

## Deploying the backend (one-time setup)

1. Create a Supabase project at [database.new](https://database.new) (free tier).
2. Link and push the schema:
   ```sh
   npm install
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```
3. Set the Gemini API key (from [AI Studio](https://aistudio.google.com/apikey)) as a function secret:
   ```sh
   npx supabase secrets set GEMINI_API_KEY=<your-key>
   ```
4. Deploy the Edge Functions:
   ```sh
   npx supabase functions deploy ingest summarize
   ```
5. Give the cron jobs credentials to call the functions — run once in the dashboard SQL editor:
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
   select vault.create_secret('<service-role-key>', 'service_role_key');
   ```
   (Service role key: dashboard → Settings → API keys.)

Cron jobs (`ingest-hourly`, `summarize-15min`, `cleanup-daily`) are created by the migrations automatically.

## Manual test

```sh
curl -X POST https://<project-ref>.supabase.co/functions/v1/ingest \
  -H "Authorization: Bearer <service-role-key>"
curl -X POST https://<project-ref>.supabase.co/functions/v1/summarize \
  -H "Authorization: Bearer <service-role-key>"
```

## Local development

Requires Docker Desktop running.

```sh
npx supabase start                                  # local stack + migrations
npx supabase functions serve --env-file .env        # needs GEMINI_API_KEY in .env
curl -X POST http://127.0.0.1:54321/functions/v1/ingest -H "Authorization: Bearer <local-anon-key>"
```
