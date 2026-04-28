import { describe, expect, it } from "vitest";
import type { BenchmarkResult } from "../benchmark/runner.js";
import { selectBestConfig } from "./select-config.js";

function makeResult(overrides: {
  model: string;
  percentage: number;
  avgTps?: number;
  contextLength?: number;
  errorRate?: number;
  thinkingLevel?: string;
}): BenchmarkResult {
  const taskCount = 10;
  const errorCount = Math.round((overrides.errorRate ?? 0) * taskCount);
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    task: {
      id: `t${i}`,
      name: `Task ${i}`,
      category: "reasoning" as const,
      difficulty: "easy" as const,
      prompt: "",
      grading: { type: "exact_match" as const, maxScore: 10 },
    },
    output: "",
    score: {
      taskId: `t${i}`,
      score: i < errorCount ? 0 : 10,
      maxScore: 10,
      percentage: i < errorCount ? 0 : 100,
      method: "deterministic" as const,
      details: "",
      passed: i >= errorCount,
    },
    elapsedMs: 1000,
    tokensPerSecond: overrides.avgTps ?? 10,
    ...(i < errorCount ? { error: "simulated error" } : {}),
  }));

  return {
    config: {
      ollamaUrl: "http://localhost:11434",
      model: overrides.model,
      mock: false,
      contextLength: overrides.contextLength ?? 8192,
    },
    hardware: {
      cpu: { arch: "x86_64", cores: 8, model: "test" },
      ram: { totalBytes: 16e9, availableBytes: 8e9 },
      gpu: { detected: false, nvidia: false, apple: false },
    },
    tasks,
    summary: {
      totalScore: overrides.percentage,
      maxScore: 100,
      percentage: overrides.percentage,
      totalTimeMs: 10000,
      avgTokensPerSecond: overrides.avgTps ?? 10,
      passedCount: taskCount - errorCount,
      failedCount: errorCount,
    },
    timestamp: new Date().toISOString(),
    ...(overrides.thinkingLevel ? {} : {}),
  } as BenchmarkResult;
}

describe("selectBestConfig", () => {
  it("returns null for empty results", () => {
    expect(selectBestConfig([])).toBeNull();
  });

  it("returns null when all results below quality gate", () => {
    const results = [makeResult({ model: "gemma3:4b", percentage: 10 })];
    expect(selectBestConfig(results, { minQuality: 30 })).toBeNull();
  });

  it("selects highest composite score", () => {
    const results = [
      makeResult({ model: "gemma3:4b", percentage: 60, avgTps: 20 }),
      makeResult({ model: "gemma3:12b", percentage: 90, avgTps: 10 }),
    ];
    const rec = selectBestConfig(results);
    expect(rec).not.toBeNull();
    expect(rec!.model).toBe("gemma3:12b"); // higher quality wins
  });

  it("eliminates configs with >25% error rate", () => {
    const results = [
      makeResult({ model: "broken", percentage: 80, errorRate: 0.3 }),
      makeResult({ model: "good", percentage: 50, avgTps: 15 }),
    ];
    const rec = selectBestConfig(results);
    expect(rec).not.toBeNull();
    expect(rec!.model).toBe("good");
  });

  it("includes reasoning string", () => {
    const results = [makeResult({ model: "gemma3:4b", percentage: 75, avgTps: 20 })];
    const rec = selectBestConfig(results);
    expect(rec).not.toBeNull();
    expect(rec!.reasoning).toBeTruthy();
    expect(rec!.reasoning).toContain("75%");
  });
});
