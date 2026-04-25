/**
 * Config selection algorithm.
 *
 * Given an array of benchmark results (from a sweep), selects the best
 * configuration for the user's hardware using deterministic rules.
 *
 * See docs/config-selection-algorithm.md for the full specification.
 */

import type { BenchmarkResult } from "../benchmark/runner.js";

export type SelectionOpts = {
  qualityWeight?: number; // default 0.7
  speedWeight?: number; // default 0.3
  minQuality?: number; // default 30 (percentage)
  maxErrorRate?: number; // default 0.25
};

export type RecommendedConfig = {
  model: string;
  backend: string;
  quantization?: string;
  contextWindow?: number;
  thinkingLevel?: string;
  compositeScore: number;
  qualityPct: number;
  tokPerSec?: number;
  reasoning: string;
};

/** Rank quantizations by quality (higher = less lossy). Used for tie-breaking. */
export const QUANT_RANK: Record<string, number> = {
  F16: 6,
  F32: 7,
  Q8_0: 5,
  Q8: 5,
  Q6_K: 4.5,
  Q5_K_M: 4,
  Q5_K_S: 3.8,
  Q5: 3.5,
  Q4_K_M: 3,
  Q4_K_S: 2.8,
  Q4: 2.5,
  Q3_K_M: 2,
  Q3_K_S: 1.8,
  Q2_K: 1,
  Q2: 0.5,
};

export function selectBestConfig(
  results: BenchmarkResult[],
  opts: SelectionOpts = {},
): RecommendedConfig | null {
  const qualityWeight = opts.qualityWeight ?? 0.7;
  const speedWeight = opts.speedWeight ?? 0.3;
  const minQuality = opts.minQuality ?? 30;
  const maxErrorRate = opts.maxErrorRate ?? 0.25;

  // Step 1: Eliminate broken configs.
  const viable = results.filter((r) => {
    const taskCount = r.tasks.length;
    const errorCount = r.tasks.filter((t) => t.error != null).length;
    if (taskCount > 0 && errorCount / taskCount > maxErrorRate) {
      return false;
    }
    return true;
  });

  // Step 2: Quality gate.
  const qualified = viable.filter((r) => r.summary.percentage >= minQuality);

  if (qualified.length === 0) {
    return null;
  }

  // Step 3: Score candidates.
  type Scored = {
    result: BenchmarkResult;
    composite: number;
    qualityNorm: number;
    speedNorm: number;
  };

  const scored: Scored[] = qualified.map((r) => {
    const qualityNorm = r.summary.percentage / 100;
    const speedNorm = Math.min((r.summary.avgTokensPerSecond ?? 0) / 30, 1.0);
    const contextBonus = (r.config.contextLength ?? 0) >= 32768 ? 0.05 : 0;
    const composite = qualityWeight * qualityNorm + speedWeight * speedNorm + contextBonus;
    return { result: r, composite, qualityNorm, speedNorm };
  });

  // Sort by composite descending.
  scored.sort((a, b) => b.composite - a.composite);

  // Step 4: Thinking level preference within 2% band.
  const best = scored[0];
  const band = scored.filter((s) => best.composite - s.composite <= 0.02);
  const mediumPref = band.find(
    (s) => (s.result.config as Record<string, unknown>).thinkingLevel === "medium",
  );
  const winner = mediumPref ?? best;

  // Extract model info.
  const r = winner.result;
  const modelName = r.config.model;

  // Try to extract quant from model name (e.g. "gemma3:4b-q4_k_m" or config).
  const quantMatch = modelName.match(/[qQ]\d[_a-zA-Z]*/);
  const quantization = quantMatch?.[0];

  return {
    model: modelName,
    backend: "ollama",
    quantization,
    contextWindow: r.config.contextLength,
    thinkingLevel: (r.config as Record<string, unknown>).thinkingLevel as string | undefined,
    compositeScore: Math.round(winner.composite * 1000) / 1000,
    qualityPct: r.summary.percentage,
    tokPerSec: r.summary.avgTokensPerSecond,
    reasoning: `Best composite score (${winner.composite.toFixed(3)}). Quality ${r.summary.percentage}% with ${r.summary.avgTokensPerSecond?.toFixed(1) ?? "?"} tok/s${r.config.contextLength ? ` at ${(r.config.contextLength / 1024).toFixed(0)}k context` : ""}.`,
  };
}
