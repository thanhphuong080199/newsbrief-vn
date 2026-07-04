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

export interface FeedGroup {
  id: string;
  title: string;
  first_seen_at: string;
  article_count: number;
  // PostgREST returns an object for one-to-one relations, but be tolerant of arrays.
  summaries: { summary_vi: string | null; status: string } | { summary_vi: string | null; status: string }[] | null;
  articles: FeedArticle[];
}

export function groupSummary(g: FeedGroup): { summary_vi: string | null; status: string } | null {
  if (!g.summaries) return null;
  return Array.isArray(g.summaries) ? (g.summaries[0] ?? null) : g.summaries;
}
