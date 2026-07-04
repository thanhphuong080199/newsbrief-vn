import { XMLParser } from "npm:fast-xml-parser@4";

export interface FeedItem {
  title: string;
  link: string;
  content: string; // plain text (HTML stripped); may be short/empty
  publishedAt: string | null; // ISO timestamp
}

const UA =
  "Mozilla/5.0 (compatible; newsbrief-vn/0.1; personal research aggregator)";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

// fast-xml-parser yields strings, numbers, or {"#text": ...} when attributes exist
// deno-lint-ignore no-explicit-any
function text(node: any): string {
  if (node == null) return "";
  if (typeof node === "object") return text(node["#text"] ?? "");
  return String(node).trim();
}

// deno-lint-ignore no-explicit-any
function arr(node: any): any[] {
  if (node == null) return [];
  return Array.isArray(node) ? node : [node];
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(s: string): string | null {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Parse an RSS 2.0 or Atom feed into items (newest-first order preserved). */
export async function fetchFeed(feedUrl: string): Promise<FeedItem[]> {
  const xml = await fetchPage(feedUrl);
  const doc = parser.parse(xml);

  const rssItems = doc?.rss?.channel?.item;
  if (rssItems) {
    return arr(rssItems).flatMap((it) => {
      const link = text(it.link) || text(it.guid);
      const title = stripHtml(text(it.title));
      if (!link || !title) return [];
      return [{
        title,
        link,
        content: stripHtml(text(it["content:encoded"]) || text(it.description)),
        publishedAt: parseDate(text(it.pubDate)),
      }];
    });
  }

  const atomEntries = doc?.feed?.entry;
  if (atomEntries) {
    return arr(atomEntries).flatMap((e) => {
      const links = arr(e.link);
      const alt = links.find((l) => l?.["@_rel"] === "alternate") ?? links[0];
      const link = alt?.["@_href"] ?? text(e.link);
      const title = stripHtml(text(e.title));
      if (!link || !title) return [];
      return [{
        title,
        link,
        content: stripHtml(text(e.content) || text(e.summary)),
        publishedAt: parseDate(text(e.published) || text(e.updated)),
      }];
    });
  }

  throw new Error(`unrecognized feed format at ${feedUrl}`);
}

/** Find <link rel="alternate" type="application/rss+xml|atom+xml"> in a page head. */
export async function discoverFeedUrl(pageUrl: string): Promise<string | null> {
  const html = (await fetchPage(pageUrl)).slice(0, 100_000);
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/type\s*=\s*["'](application\/(rss|atom)\+xml)["']/i.test(tag)) continue;
    if (!/rel\s*=\s*["']alternate["']/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) {
      try {
        return new URL(href, pageUrl).toString();
      } catch {
        continue;
      }
    }
  }
  return null;
}
