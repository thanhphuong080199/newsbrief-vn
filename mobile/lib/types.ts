export interface Source {
  id: string;
  name: string;
  homepage_url: string | null;
  lang: string;
  is_predefined: boolean;
  added_by: string | null;
  active: boolean;
}

export interface FeedArticle {
  id: string;
  title: string;
  url: string;
  source_id: string;
  published_at: string | null;
  sources: { name: string } | null;
}

interface Summary {
  summary_vi: string | null;
  title_vi: string | null;
  status: string;
  category: string | null;
}

export interface FeedGroup {
  id: string;
  title: string;
  first_seen_at: string;
  article_count: number;
  // PostgREST returns an object for one-to-one relations, but be tolerant of arrays.
  summaries: Summary | Summary[] | null;
  articles: FeedArticle[];
}

export function groupSummary(g: FeedGroup): Summary | null {
  if (!g.summaries) return null;
  return Array.isArray(g.summaries) ? (g.summaries[0] ?? null) : g.summaries;
}

// Fixed VN taxonomy. Keep in sync with supabase/functions/summarize/index.ts.
// Order here drives the order of the feed filter chips.
export const CATEGORIES = [
  "Thời sự", "Thế giới", "Kinh tế", "Thể thao", "Công nghệ",
  "Giải trí", "Sức khỏe", "Giáo dục", "Pháp luật", "Khác",
] as const;

// A group's category (null = summarized before categories existed, or pending).
export function groupCategory(g: FeedGroup): string | null {
  return groupSummary(g)?.category ?? null;
}

// The title to display: the Vietnamese title from summarize when available,
// otherwise the original headline (not yet summarized, or model omitted it).
export function groupTitle(g: FeedGroup): string {
  return groupSummary(g)?.title_vi ?? g.title;
}
