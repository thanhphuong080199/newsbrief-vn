import { parseHTML } from "npm:linkedom@0.18";
import { Readability } from "npm:@mozilla/readability@0.5";

export interface Extracted {
  title: string | null;
  text: string | null;
}

/** Readability-style main-content extraction from raw article HTML. */
export function extractArticle(html: string): Extracted {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document, { charThreshold: 100 }).parse();
    const text = article?.textContent?.replace(/\s+/g, " ").trim() || null;
    return { title: article?.title?.trim() || null, text };
  } catch {
    return { title: null, text: null };
  }
}
