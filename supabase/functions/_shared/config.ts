import { db } from "./db.ts";

export interface AppConfig {
  retentionDays: number;
  dedupSimilarityThreshold: number;
  dedupWindowHours: number;
  summarizeBatchSize: number;
  summarizeMaxAttempts: number;
  maxItemsPerSource: number;
  maxPageExtractionsPerRun: number;
  modelFallbackOrder: string[];
}

const DEFAULTS: AppConfig = {
  retentionDays: 7,
  dedupSimilarityThreshold: 0.85,
  dedupWindowHours: 72,
  summarizeBatchSize: 10,
  summarizeMaxAttempts: 8,
  maxItemsPerSource: 20,
  maxPageExtractionsPerRun: 8,
  // Keep in sync with the app_config.model_fallback_order row (migration
  // 20260710000001). Free-tier quota is per-model, so the chain spans distinct
  // buckets; Gemma draws from a separate pool. All six were live-tested working.
  modelFallbackOrder: [
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
    "gemma-4-31b-it",
    "gemma-4-26b-a4b-it",
  ],
};

export async function loadConfig(): Promise<AppConfig> {
  const { data, error } = await db.from("app_config").select("key, value");
  if (error) throw new Error(`loadConfig: ${error.message}`);
  const raw = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  return {
    retentionDays: raw.retention_days ?? DEFAULTS.retentionDays,
    dedupSimilarityThreshold: raw.dedup_similarity_threshold ?? DEFAULTS.dedupSimilarityThreshold,
    dedupWindowHours: raw.dedup_window_hours ?? DEFAULTS.dedupWindowHours,
    summarizeBatchSize: raw.summarize_batch_size ?? DEFAULTS.summarizeBatchSize,
    summarizeMaxAttempts: raw.summarize_max_attempts ?? DEFAULTS.summarizeMaxAttempts,
    maxItemsPerSource: raw.max_items_per_source ?? DEFAULTS.maxItemsPerSource,
    maxPageExtractionsPerRun: raw.max_page_extractions_per_run ?? DEFAULTS.maxPageExtractionsPerRun,
    modelFallbackOrder: raw.model_fallback_order ?? DEFAULTS.modelFallbackOrder,
  };
}
