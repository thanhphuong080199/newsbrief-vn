// summarize: process pending summaries in small batches with the Gemini
// fallback chain. Rows that fail transiently (429/503 on all models) stay
// `pending`, so the next 5-minute cron run is automatically the retry pass.

import { db } from "../_shared/db.ts";
import { loadConfig } from "../_shared/config.ts";
import { GeminiError, generateWithFallback } from "../_shared/gemini.ts";

const DELAY_BETWEEN_CALLS_MS = 4000; // free-tier RPM is the binding constraint
const MAX_ARTICLES_PER_GROUP = 5;
const MAX_CHARS_PER_ARTICLE = 6000;
const MAX_CHARS_TOTAL = 15000;

// Fixed VN taxonomy. Keep in sync with mobile/lib/types.ts CATEGORIES.
const CATEGORIES = [
  "Thời sự", "Thế giới", "Kinh tế", "Thể thao", "Công nghệ",
  "Giải trí", "Sức khỏe", "Giáo dục", "Pháp luật", "Khác",
] as const;

// Diacritic-insensitive, punctuation-stripped key so the model's answer matches
// a canonical category even if it adds accents-loss or a trailing period.
const catKey = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
const CATEGORY_BY_KEY = new Map(CATEGORIES.map((c) => [catKey(c), c]));

// Parse the labeled model output into a canonical category + a Vietnamese title
// + the summary body. Resilient: if the format isn't followed, category/title
// are null and the summary falls back to the whole response (minus the label
// lines) so we never drop a good summary. A null title_vi means the app shows
// the original headline.
function parseSummary(raw: string): { category: string | null; titleVi: string | null; summary: string } {
  const catMatch = raw.match(/PHÂN\s*LOẠI\s*[:：]\s*(.+)/i);
  const category = catMatch ? (CATEGORY_BY_KEY.get(catKey(catMatch[1])) ?? null) : null;
  const titleMatch = raw.match(/TIÊU\s*ĐỀ\s*[:：]\s*(.+)/i);
  const titleVi = titleMatch ? (titleMatch[1].trim() || null) : null;
  const sumMatch = raw.match(/TÓM\s*TẮT\s*[:：]\s*([\s\S]+)/i);
  let summary = sumMatch
    ? sumMatch[1].trim()
    : raw
        .replace(/PHÂN\s*LOẠI\s*[:：].*(\r?\n)?/i, "")
        .replace(/TIÊU\s*ĐỀ\s*[:：].*(\r?\n)?/i, "")
        .trim();
  if (!summary) summary = raw.trim();
  return { category, titleVi, summary };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface GroupArticle {
  title: string;
  content: string | null;
  lang: string | null;
  sources: { name: string } | null;
}

function buildPrompt(articles: GroupArticle[]): string {
  const parts = articles.map((a, i) =>
    `--- Bài ${i + 1} (nguồn: ${a.sources?.name ?? "không rõ"}, ngôn ngữ gốc: ${a.lang ?? "không rõ"})\n` +
    `Tiêu đề: ${a.title}\n${(a.content ?? "").slice(0, MAX_CHARS_PER_ARTICLE)}`
  );
  const body = parts.join("\n\n").slice(0, MAX_CHARS_TOTAL);
  return `Bạn là biên tập viên tin tức. Dưới đây là một hoặc nhiều bài báo cùng đưa tin về một sự kiện.

${body}

Hãy thực hiện ba việc:
1) Phân loại sự kiện vào ĐÚNG MỘT chủ đề trong danh sách sau (chép lại chính xác một chủ đề): ${CATEGORIES.join(", ")}.
2) Đặt MỘT tiêu đề ngắn gọn bằng TIẾNG VIỆT cho sự kiện. Nếu tiêu đề gốc bằng tiếng nước ngoài, hãy dịch tự nhiên sang tiếng Việt; nếu đã bằng tiếng Việt, giữ nguyên ý (chỉ tinh chỉnh cho gọn nếu cần).
3) Viết MỘT bản tóm tắt duy nhất bằng TIẾNG VIỆT (3–5 câu, văn phong khách quan, nêu đủ ý chính: ai, cái gì, khi nào, ở đâu, vì sao/tác động). Nếu bài gốc bằng tiếng nước ngoài, hãy dịch nội dung sang tiếng Việt khi tóm tắt.

Trả về CHÍNH XÁC theo định dạng sau, không thêm lời dẫn hay định dạng markdown:
PHÂN LOẠI: <một chủ đề trong danh sách>
TIÊU ĐỀ: <tiêu đề tiếng Việt>
TÓM TẮT: <nội dung tóm tắt>`;
}

Deno.serve(async (_req) => {
  const stats = {
    picked: 0,
    succeeded: 0,
    still_pending: 0,
    failed: 0,
    per_model: {} as Record<string, number>,
  };

  try {
    const cfg = await loadConfig();

    const { data: pending, error } = await db
      .from("summaries")
      .select("id, group_id, attempts")
      .eq("status", "pending")
      .lt("attempts", cfg.summarizeMaxAttempts)
      // Newest-first: the feed shows newest groups on top, so summarize those
      // first — otherwise the visible top-of-feed is always still "pending"
      // while the job works through older groups nobody is looking at.
      .order("created_at", { ascending: false })
      .limit(cfg.summarizeBatchSize);
    if (error) throw new Error(`load pending: ${error.message}`);

    stats.picked = pending?.length ?? 0;
    const skipModels = new Set<string>(); // models with exhausted daily quota, shared across the batch

    for (const [i, row] of (pending ?? []).entries()) {
      if (i > 0) await sleep(DELAY_BETWEEN_CALLS_MS);

      const { data: articles, error: artErr } = await db
        .from("articles")
        .select("title, content, lang, sources(name)")
        .eq("group_id", row.group_id)
        .order("fetched_at", { ascending: true })
        .limit(MAX_ARTICLES_PER_GROUP);
      if (artErr) throw new Error(`load articles: ${artErr.message}`);

      if (!articles || articles.length === 0) {
        await db.from("summaries")
          .update({ status: "failed", last_error: "group has no articles" })
          .eq("id", row.id);
        stats.failed++;
        continue;
      }

      try {
        const { text, model } = await generateWithFallback(
          buildPrompt(articles as unknown as GroupArticle[]),
          cfg.modelFallbackOrder,
          skipModels,
        );
        const { category, titleVi, summary } = parseSummary(text);
        await db.from("summaries").update({
          summary_vi: summary,
          title_vi: titleVi,
          category,
          model,
          status: "success",
          attempts: row.attempts + 1,
          last_error: null,
        }).eq("id", row.id);
        stats.succeeded++;
        stats.per_model[model] = (stats.per_model[model] ?? 0) + 1;
      } catch (e) {
        const permanent = e instanceof GeminiError && !e.retryable;
        const attempts = row.attempts + 1;
        const status = permanent || attempts >= cfg.summarizeMaxAttempts ? "failed" : "pending";
        await db.from("summaries").update({
          status,
          attempts,
          last_error: String(e instanceof Error ? e.message : e).slice(0, 500),
        }).eq("id", row.id);
        if (status === "failed") stats.failed++;
        else stats.still_pending++;

        // Every model's daily quota is gone — stop burning attempts this run.
        if (skipModels.size >= cfg.modelFallbackOrder.length) {
          console.warn("all models quota-exhausted; ending run early");
          break;
        }
      }
    }

    console.log("summarize done", stats);
    return Response.json(stats);
  } catch (e) {
    console.error("summarize fatal:", e, "partial stats:", stats);
    return Response.json({ error: String(e), ...stats }, { status: 500 });
  }
});
