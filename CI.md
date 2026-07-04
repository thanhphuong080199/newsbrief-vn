# CI — newsbrief-vn (GitHub Actions)

| Workflow | File | Trigger | What it does |
|---|---|---|---|
| **Supabase — Deploy** | `.github/workflows/supabase.yml` | push to `main` under `supabase/**` (+ manual) | `supabase db push` (migrations) → `supabase functions deploy ingest summarize --use-api` |
| **Mobile — EAS Update (OTA)** | `.github/workflows/mobile.yml` | push to `main` under `mobile/**` (+ manual) | `npm ci` → `tsc --noEmit` → `eas update --branch main` — **free**, no build credits |
| **Mobile — Build APK (manual)** | `.github/workflows/mobile-build-apk.yml` | **manual only** (`workflow_dispatch`) | `npm ci` → `tsc --noEmit` → `eas build -p android --profile preview` (shareable APK) |

The two push workflows are **path-filtered** so a backend-only change doesn't
trigger the mobile job and vice-versa.

## OTA vs APK — which to use

- **Every push → OTA update** (automatic, **free**). Covers all JS/asset
  changes (components, styles, logic, the icon/splash images). It patches an
  **already-installed** app.
- **Build APK → only when needed** (manual button in the Actions tab, **costs an
  EAS build credit**). Required for: a fresh install for a new tester, native
  changes (`expo install` of a native module, SDK bump, native `app.json`
  config). First install must be an APK before OTA can update it.

So: install testers once with a manual APK build, then ship day-to-day changes
free via OTA.

---

## 1. Required GitHub secrets

Add these under **Repo → Settings → Secrets and variables → Actions → New
repository secret**.

### Supabase deploy

| Secret | Value | Where to get it |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | personal access token | https://supabase.com/dashboard/account/tokens |
| `SUPABASE_DB_PASSWORD` | the project's database password | set when the project was created (DEPLOY.md §2) |
| `SUPABASE_PROJECT_REF` | `yevgaoyxutlyzmzhhssg` | Project Settings → General |

### Mobile APK build

| Secret | Value | Where to get it |
|---|---|---|
| `EXPO_TOKEN` | Expo access token (must belong to the `owner` in `app.json` — `thanhphuong080199`) | https://expo.dev → Account settings → Access tokens |

---

## 2. One-time EAS setup — DONE

`eas init` has already wired the EAS project into `app.json`
(`extra.eas.projectId`, `owner`, `updates.url`, `runtimeVersion`). Nothing else
to do locally — the CI job builds on EAS from those values.

> **How the APK reaches testers:** the `preview` profile is `buildType: apk`
> with `distribution: internal`, so each build produces a **shareable install
> page** (download URL + QR code) — no Play Store, no signing on your side (EAS
> auto-generates and stores the Android keystore on the first build). Open the
> page on an Android phone and tap install (Android asks to allow "unknown
> source"). The build link is printed in the CI logs and emailed by EAS.
>
> **iOS note:** Apple blocks free sideloading, so there's no equivalent
> shareable iOS build without a paid Apple Developer account (TestFlight / ad-hoc
> UDIDs). This workflow is Android-only.

### Running an APK build

Actions tab → **Mobile — Build APK (manual)** → **Run workflow**. It takes
~10–25 min on EAS and consumes one build credit. The runner uses `--no-wait`, so
it queues the build and exits fast (no GitHub minutes wasted in EAS's queue);
grab the install link from the EAS dashboard or the email EAS sends.

---

## 3. Notes / gotchas

- **Functions deploy uses `--use-api`** so the GitHub runner needs no Docker —
  this also sidesteps the ECR/CloudFront image-pull EOF hit locally
  (see [[cloudfront-docker-pulls-fail]] in DEPLOY.md).
- **`supabase db push` runs on every backend merge.** Migrations must be
  forward-only and idempotent; a bad migration will fail the deploy. Test with
  `supabase db push` locally (or a branch DB) before merging.
- **Vault secrets & anonymous auth are NOT in CI** — they're one-time dashboard
  steps (DEPLOY.md §7–8). CI only pushes schema + functions.
- **`SUPABASE_DB_PASSWORD`** is read by both `supabase link` and `db push`; no
  interactive prompt in CI because it's set as an env var.
