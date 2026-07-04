// ingest: fetch all active sources, extract content, embed, and assign new
// articles to story groups. Creates a `pending` summaries row per new group.
// Invoked hourly by pg_cron (see migrations/20260703000002_cron.sql).

import { db } from "../_shared/db.ts";
import { loadConfig, type AppConfig } from "../_shared/config.ts";
import { embedTexts } from "../_shared/gemini.ts";
import { discoverFeedUrl, fetchFeed, fetchPage, type FeedItem } from "../_shared/rss.ts";
import { extractArticle } from "../_shared/extract.ts";

interface Source {
  id: string;
  name: string;
  homepage_url: string | null;
  feed_url: string | null;
  fetch_method: string;
  lang: string;
}

interface NewArticle {
  source_id: string;
  url: string;
  url_hash: string;
  title: string;
  content: string | null;
  lang: string;
  published_at: string | null;
}

const MIN_CONTENT_CHARS = 500; // below this, try full-text extraction from the page

// Edge Functions get ~2s of CPU per request; readability parsing is the main
// CPU cost (~100-250ms/page), so extractions are capped per run via a budget
// shared across sources. Over-budget articles keep their RSS description.
interface ExtractBudget {
  left: number;
}

async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|ref$|source$)/;

function normalizeUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

async function getFeedItems(source: Source, cfg: AppConfig): Promise<FeedItem[]> {
  let feedUrl = source.feed_url;

  if (!feedUrl && source.fetch_method === "rss" && source.homepage_url) {
    feedUrl = await discoverFeedUrl(source.homepage_url);
    if (feedUrl) {
      await db.from("sources").update({ feed_url: feedUrl }).eq("id", source.id);
    }
  }

  if (feedUrl) {
    return (await fetchFeed(feedUrl)).slice(0, cfg.maxItemsPerSource);
  }

  // No feed anywhere: treat the source URL itself as a single article and
  // extract its body (ingested once thanks to url_hash dedup).
  if (!source.homepage_url) throw new Error("source has neither feed_url nor homepage_url");
  const { title, text } = extractArticle(await fetchPage(source.homepage_url));
  if (!text) throw new Error("content extraction found no article body");
  return [{
    title: title ?? source.name,
    link: source.homepage_url,
    content: text,
    publishedAt: null,
  }];
}

/** Fetch one source and return its genuinely-new articles. Throws on source-level failure. */
async function processSource(source: Source, cfg: AppConfig, budget: ExtractBudget): Promise<NewArticle[]> {
  const items = await getFeedItems(source, cfg);

  const candidates: (FeedItem & { url: string; url_hash: string })[] = [];
  for (const item of items) {
    try {
      const url = normalizeUrl(item.link);
      candidates.push({ ...item, url, url_hash: await sha256(url) });
    } catch {
      // unparseable URL — skip item
    }
  }
  if (candidates.length === 0) return [];

  const { data: existing, error } = await db
    .from("articles")
    .select("url_hash")
    .in("url_hash", candidates.map((c) => c.url_hash));
  if (error) throw new Error(`dedup query: ${error.message}`);
  const known = new Set((existing ?? []).map((r) => r.url_hash));

  const fresh: NewArticle[] = [];
  for (const c of candidates) {
    if (known.has(c.url_hash)) continue;
    known.add(c.url_hash); // guards against duplicate links within one feed

    let content = c.content || null;
    if ((content?.length ?? 0) < MIN_CONTENT_CHARS && budget.left > 0) {
      budget.left--;
      try {
        const { text } = extractArticle(await fetchPage(c.url));
        if (text && text.length > (content?.length ?? 0)) content = text;
      } catch {
        // keep the RSS description; summarizer copes with short content
      }
    }

    fresh.push({
      source_id: source.id,
      url: c.url,
      url_hash: c.url_hash,
      title: c.title,
      content,
      lang: source.lang,
      published_at: c.publishedAt,
    });
  }
  return fresh;
}

Deno.serve(async (_req) => {
  const stats = { sources_ok: 0, sources_failed: 0, new_articles: 0, new_groups: 0 };
  try {
    const cfg = await loadConfig();
    const { data: sources, error } = await db.from("sources").select("*").eq("active", true);
    if (error) throw new Error(`load sources: ${error.message}`);

    // Fetch sources in parallel; a failing source never aborts the run.
    const collected: NewArticle[] = [];
    const budget: ExtractBudget = { left: cfg.maxPageExtractionsPerRun };
    await Promise.all((sources ?? []).map(async (source: Source) => {
      const now = new Date().toISOString();
      try {
        collected.push(...await processSource(source, cfg, budget));
        stats.sources_ok++;
        await db.from("sources").update({ last_fetched_at: now, last_error: null }).eq("id", source.id);
      } catch (e) {
        stats.sources_failed++;
        console.error(`source "${source.name}" failed:`, e);
        await db.from("sources").update({ last_fetched_at: now, last_error: String(e).slice(0, 500) }).eq("id", source.id);
      }
    }));

    if (collected.length > 0) {
      // Oldest first, so articles about the same story group together within this run.
      collected.sort((a, b) => (a.published_at ?? "9999").localeCompare(b.published_at ?? "9999"));

      const embeddings = await embedTexts(
        collected.map((a) => `${a.title}\n${(a.content ?? "").slice(0, 300)}`),
      );

      // Sequential on purpose: each new group must be visible to the next match query.
      for (let i = 0; i < collected.length; i++) {
        const article = collected[i];
        const embedding = JSON.stringify(embeddings[i]);

        const { data: matchedId, error: matchErr } = await db.rpc("match_article_group", {
          query_embedding: embedding,
          similarity_threshold: cfg.dedupSimilarityThreshold,
          window_hours: cfg.dedupWindowHours,
        });
        if (matchErr) throw new Error(`match_article_group: ${matchErr.message}`);

        let groupId: string | null = matchedId;
        if (!groupId) {
          const { data: group, error: groupErr } = await db
            .from("article_groups")
            .insert({ title: article.title, embedding })
            .select("id")
            .single();
          if (groupErr) throw new Error(`insert group: ${groupErr.message}`);
          groupId = group.id;
          const { error: sumErr } = await db.from("summaries").insert({ group_id: groupId });
          if (sumErr) throw new Error(`insert summary: ${sumErr.message}`);
          stats.new_groups++;
        }

        const { error: artErr } = await db
          .from("articles")
          .upsert({ ...article, group_id: groupId }, { onConflict: "url_hash", ignoreDuplicates: true });
        if (artErr) throw new Error(`insert article: ${artErr.message}`);
        stats.new_articles++;
      }
    }

    console.log("ingest done", stats);
    return Response.json(stats);
  } catch (e) {
    console.error("ingest fatal:", e, "partial stats:", stats);
    return Response.json({ error: String(e), ...stats }, { status: 500 });
  }
});
