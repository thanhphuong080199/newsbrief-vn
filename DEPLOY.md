# DEPLOY — newsbrief-vn (hosted Supabase)

> How to deploy the backend to a hosted Supabase project and point the mobile app at it.
> Reproducible for a redeploy or a brand-new project. Steps done on 2026-07-04 against
> project **`yevgaoyxutlyzmzhhssg`** (region: Singapore / `ap-southeast-1`).

Legend: 🧑 = you do it (interactive / dashboard) · ⚙️ = a CLI command anyone/Claude can run once logged in.

---

## 0. Prerequisites

- **Docker Desktop** running (only needed for `functions deploy` bundling — see the ghcr workaround in step 5).
- **Node + npm** (the CLI is run via `npx supabase`, currently **v2.109**).
- A **Gemini API key** in `supabase/functions/.env` as `GEMINI_API_KEY=…` (gitignored).
- **Expo Go** on your phone for the app.
- A **Supabase account**.

Check the CLI:
```bash
npx supabase --version
```

---

## 1. 🧑 Log in

```bash
npx supabase login    # opens a browser; stores an access token for later commands
```
Verify:
```bash
npx supabase projects list
```

---

## 2. 🧑 Create the hosted project

In the dashboard (https://supabase.com/dashboard):
- **New project** → Name: `newsbrief-vn`
- **Region**: Southeast Asia (Singapore) — closest to VN users + Gemini latency
- **Database password**: set a strong one, keep it handy for step 3

After it provisions, grab from **Project Settings → API**:
- **Project ref** (e.g. `yevgaoyxutlyzmzhhssg`)
- **Project URL** (`https://<ref>.supabase.co`)
- **publishable / anon key** (`sb_publishable_…`) — public, ships in the app
- **service_role / secret key** (`sb_secret_…` or legacy `service_role` JWT) — **SECRET**, only used in step 6

---

## 3. ⚙️ Link the local repo to the project

```bash
npx supabase link --project-ref <ref>    # prompts for the DB password from step 2
```

---

## 4. ⚙️ Push the database schema

```bash
npx supabase db push
```
Applies all `supabase/migrations/*.sql` (schema + RLS + seed, pg_cron jobs, config tuning).

> ⚠️ **Cosmetic warning on CLI 2.109:** after "Applying migration …" you may see
> `failed to cache migrations catalog … Failed to read certificate file '…/pgdelta/pgdelta-target-ca.crt': ENOENT`.
> This is a **non-fatal** post-apply catalog step; the migrations DID apply and exit code is `0`.

Verify what's actually on the remote:
```bash
npx supabase migration list --linked
```
Both migrations should show a `local` **and** `remote` version.

---

## 5. ⚙️ Deploy the Edge Functions

```bash
npx supabase functions deploy ingest summarize
```

> ⚠️ **CloudFront/Docker EOF on this network:** the deploy bundler pulls
> `public.ecr.aws/supabase/edge-runtime:<ver>` (a specific tag, e.g. `v1.73.13`) and it can
> fail with `httpReadSeeker … EOF`. Fix by pulling the same tag from **ghcr.io** and retagging:
> ```bash
> docker pull ghcr.io/supabase/edge-runtime:v1.73.13
> docker tag  ghcr.io/supabase/edge-runtime:v1.73.13 public.ecr.aws/supabase/edge-runtime:v1.73.13
> ```
> Use whatever version the error names, then re-run the deploy. (Alternative: `--use-api`
> bundles server-side with no local Docker.)

---

## 6. ⚙️ Set the Gemini secret (Edge Function env)

```bash
npx supabase secrets set --env-file supabase/functions/.env
```
Sets `GEMINI_API_KEY` for the deployed functions. (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
are injected automatically — do not set them.)

---

## 7. 🧑 Create the Vault secrets (enables pg_cron → Edge Functions)

The pg_cron jobs read the project URL + a bearer key from Vault **at run time**.
Dashboard → **SQL Editor**:
```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<SERVICE_ROLE_OR_SECRET_KEY>', 'service_role_key');
```
- `<SERVICE_ROLE_OR_SECRET_KEY>` = the service_role / `sb_secret_…` key from step 2. Keep it secret.

> ⏱️ **Do this right after step 4**, before the first `ingest` cron tick (:05). If a cron job
> fires before these exist, its HTTP call fails with `null value in column "url" … http_request_queue`
> (url/Authorization come out null). It's harmless — the next tick succeeds once the secrets exist —
> but it produces one confusing failed row.

---

## 8. 🧑 Enable anonymous sign-ins (lets the app log in)

The app uses per-device anonymous auth (no login screen).
Dashboard → **Authentication → Sign In / Providers** → enable **"Allow anonymous sign-ins"** → Save.
(URL: `https://supabase.com/dashboard/project/<ref>/auth/providers`.)
This is the hosted equivalent of `enable_anonymous_sign_ins = true` in `supabase/config.toml`.

---

## 9. ⚙️ Point the mobile app at the hosted project

`mobile/.env`:
```
EXPO_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
```
(Keep the local-stack values commented for easy switch-back.) Then:
```bash
cd mobile && npx expo start
```
Expo/Metro runs on the PC; the app loads in Expo Go and talks to **hosted** Supabase.

---

## 10. Seed + verify

**Invoke a function manually** (CLI `invoke` was removed in 2.109 — use HTTP; the publishable key
passes `verify_jwt`):
```bash
curl -X POST "https://<ref>.supabase.co/functions/v1/ingest" \
  -H "Authorization: Bearer <publishable-key>" \
  -H "Content-Type: application/json" -d "{}"
# then, one or more times:
curl -X POST "https://<ref>.supabase.co/functions/v1/summarize" \
  -H "Authorization: Bearer <publishable-key>" \
  -H "Content-Type: application/json" -d "{}"
```
Expected: `ingest` → `{"sources_ok":6,…,"new_groups":N}`; `summarize` → `{"picked":5,"succeeded":5,…}`.

**Verify pg_cron** (SQL Editor):
```sql
select jobname, schedule, active from cron.job order by jobname;              -- 3 jobs

select j.jobname, r.status, r.start_time, r.return_message                    -- recent runs
from cron.job_run_details r join cron.job j on j.jobid = r.jobid
order by r.start_time desc limit 10;

select id, status_code, timed_out, error_msg, created                        -- HTTP results
from net._http_response order by created desc limit 10;                       -- want 200s
```

**Verify anonymous auth** — launch the app once, then:
```sql
select id, is_anonymous, created_at from auth.users order by created_at desc limit 5;
```

---

## Schedules (from `supabase/migrations/20260703000002_cron.sql`)

| Job | Schedule | What |
|---|---|---|
| `ingest-hourly` | `5 * * * *` | fetch feeds + group new articles |
| `summarize-15min` | `*/15 * * * *` | summarize pending groups (also the retry pass) |
| `cleanup-daily` | `0 20 * * *` (03:00 VN) | delete non-pinned groups past `retention_days` |

---

## Runtime config (tune without redeploying)

All in the `app_config` table (`update public.app_config set value = '<n>' where key = '<key>';`,
or as a migration). Key ones for hosted limits:

| Key | Default | Notes |
|---|---|---|
| `summarize_batch_size` | **5** | lowered from 10 — batch 10 overran the ~150s Edge Function wall-clock limit (`546 WORKER_RESOURCE_LIMIT`). |
| `max_items_per_source` | 20 | lower if `ingest` ever nears 150s on a busy hour. |
| `max_page_extractions_per_run` | 8 | CPU budget for full-text extraction. |
| `model_fallback_order` | 3.5-flash → 3.1-flash-lite → 2.5-flash-lite | free-tier Gemini chain. |

---

## Troubleshooting quick reference

| Symptom | Cause | Fix |
|---|---|---|
| `pgdelta-target-ca.crt ENOENT` on `db push` | cosmetic CLI 2.109 catalog step | ignore; verify with `migration list --linked` |
| `httpReadSeeker … EOF` on `functions deploy` | CloudFront/ECR pull fails on this network | `docker pull ghcr.io/supabase/edge-runtime:<ver>` + retag to the ECR name |
| `Unknown subcommand "invoke"` | removed in CLI 2.109 | invoke over HTTP with curl (step 10) |
| cron: `null value in column "url" … http_request_queue` | Vault secrets missing when the job fired | create the Vault secrets (step 7); next tick succeeds |
| function `546 WORKER_RESOURCE_LIMIT` | ~150s Edge Function wall-clock limit | lower `summarize_batch_size` / `max_items_per_source` |
| app hangs on spinner / "Không thể khởi tạo…" | anonymous sign-ins not enabled | step 8 |
