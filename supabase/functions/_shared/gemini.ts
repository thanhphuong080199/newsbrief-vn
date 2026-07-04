// Minimal Gemini REST client (no SDK): embeddings + generation with a
// free-tier-aware fallback chain.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIM = 768; // must match vector(768) in the schema
const BACKOFF_MS = [2000, 5000]; // retries per model on 429/503/network errors

export class GeminiError extends Error {
  constructor(message: string, public status: number, public retryable: boolean) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${API_BASE}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": Deno.env.get("GEMINI_API_KEY") ?? "",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

// Vectors truncated below the native 3072 dims must be re-normalized (per Google docs).
function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

// Free tier counts every text in a batchEmbedContents call against the
// per-minute request quota (~100 RPM), so chunk well below it and pace chunks.
const EMBED_CHUNK_SIZE = 40;
const EMBED_CHUNK_DELAY_MS = 30_000;
const EMBED_429_RETRIES = 2;
const EMBED_429_BACKOFF_MS = 45_000;

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_CHUNK_SIZE) {
    if (i > 0) await sleep(EMBED_CHUNK_DELAY_MS);
    const chunk = texts.slice(i, i + EMBED_CHUNK_SIZE);

    for (let attempt = 0; ; attempt++) {
      const res = await post(`models/${EMBED_MODEL}:batchEmbedContents`, {
        requests: chunk.map((text) => ({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text: text.slice(0, 8000) }] },
          outputDimensionality: EMBED_DIM,
        })),
      });
      if (res.ok) {
        const data = await res.json();
        for (const e of data.embeddings) out.push(normalize(e.values));
        break;
      }
      const body = (await res.text()).slice(0, 300);
      if (res.status === 429 && attempt < EMBED_429_RETRIES) {
        const retryAfterMs = Number(res.headers.get("retry-after") ?? 0) * 1000;
        await sleep(Math.max(EMBED_429_BACKOFF_MS, retryAfterMs));
        continue;
      }
      throw new GeminiError(
        `embed: HTTP ${res.status} ${body}`,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }
  }
  return out;
}

/**
 * Try each model in order; per model retry 429/503/network errors with backoff.
 * A 429 that looks like daily-quota exhaustion adds the model to `skipModels`
 * (shared across a batch run) so later items don't waste time on it.
 * Throws GeminiError with retryable=false only for permanent failures
 * (safety block / empty response).
 */
export async function generateWithFallback(
  prompt: string,
  models: string[],
  skipModels: Set<string>,
): Promise<{ text: string; model: string }> {
  let lastError: GeminiError | null = null;

  for (const model of models) {
    if (skipModels.has(model)) continue;

    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      let res: Response;
      try {
        res = await post(`models/${model}:generateContent`, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
        });
      } catch (e) {
        lastError = new GeminiError(`${model}: ${e}`, 0, true);
        if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
        continue;
      }

      if (res.ok) {
        const data = await res.json();
        const text = (data.candidates?.[0]?.content?.parts ?? [])
          .map((p: { text?: string }) => p.text ?? "")
          .join("")
          .trim();
        if (!text) {
          const reason = data.candidates?.[0]?.finishReason ??
            data.promptFeedback?.blockReason ?? "empty response";
          throw new GeminiError(`${model}: no text (${reason})`, 200, false);
        }
        return { text, model };
      }

      const body = (await res.text()).slice(0, 300);
      const retryable = res.status === 429 || res.status >= 500;
      lastError = new GeminiError(`${model}: HTTP ${res.status} ${body}`, res.status, retryable);

      if (!retryable) break; // e.g. 400/404 — try the next model
      if (res.status === 429 && /PerDay|daily/i.test(body)) {
        skipModels.add(model);
        break; // daily quota gone for this model — next model
      }
      if (attempt < BACKOFF_MS.length) {
        const retryAfterMs = Number(res.headers.get("retry-after") ?? 0) * 1000;
        await sleep(Math.max(BACKOFF_MS[attempt] + Math.random() * 1000, retryAfterMs));
      }
    }
  }

  throw lastError ?? new GeminiError("all models skipped (daily quota)", 429, true);
}
