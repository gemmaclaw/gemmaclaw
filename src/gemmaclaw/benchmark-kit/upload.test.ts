import { describe, expect, it } from "vitest";
import type { BenchmarkResult } from "../benchmark/runner.js";
import { anonymize, checkGhCli } from "./upload.js";

function makeMockResult(): BenchmarkResult {
  return {
    config: {
      backend: "ollama",
      ollamaUrl: "http://192.168.1.100:11434",
      llamaCppUrl: "http://127.0.0.1:8080",
      model: "gemma3:4b-q4_k_m",
      mock: false,
      contextLength: 8192,
    },
    hardware: {
      cpu: { arch: "x86_64", cores: 12, model: "AMD Ryzen 9 5900X" },
      ram: { totalBytes: 33_554_432_000, availableBytes: 16_000_000_000 },
      gpu: { detected: true, nvidia: true, name: "NVIDIA RTX 3090", vramBytes: 25_769_803_776 },
    },
    tasks: [
      {
        task: {
          id: "list_reverse",
          name: "Reverse a List",
          category: "instruction_following",
          difficulty: "easy",
          prompt: "Reverse the list...",
          grading: { type: "exact_match", expected: ["e", "d", "c", "b", "a"], maxScore: 5 },
        },
        output: "e\nd\nc\nb\na",
        score: {
          taskId: "list_reverse",
          score: 5,
          maxScore: 5,
          percentage: 100,
          method: "deterministic",
          details: "all matched",
          passed: true,
        },
        elapsedMs: 1500,
        tokensPerSecond: 22.5,
        failureMode: "none",
      },
    ],
    summary: {
      totalScore: 5,
      maxScore: 5,
      percentage: 100,
      totalTimeMs: 1500,
      avgTokensPerSecond: 22.5,
      passedCount: 1,
      failedCount: 0,
      passRate: 100,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      failureModes: { none: 1 },
    },
    timestamp: "2026-04-25T15:00:00.000Z",
  };
}

describe("anonymize", () => {
  it("strips model output text from tasks", () => {
    const result = makeMockResult();
    const anon = anonymize(result);

    // Tasks should not contain the actual model output.
    for (const t of anon.tasks) {
      expect(t).not.toHaveProperty("output");
    }
  });

  it("strips ollamaUrl from config (may contain internal IPs)", () => {
    const result = makeMockResult();
    const anon = anonymize(result);
    expect(JSON.stringify(anon)).not.toContain("192.168.1.100");
  });

  it("preserves hardware info", () => {
    const result = makeMockResult();
    const anon = anonymize(result);
    expect(anon.hardware.cpu.cores).toBe(12);
    expect(anon.hardware.gpu.detected).toBe(true);
    expect(anon.hardware.ram.totalBytes).toBe(33_554_432_000);
  });

  it("preserves scores and timing", () => {
    const result = makeMockResult();
    const anon = anonymize(result);
    expect(anon.summary.percentage).toBe(100);
    expect(anon.summary.avgTokensPerSecond).toBe(22.5);
    expect(anon.tasks[0].score).toBe(5);
    expect(anon.tasks[0].elapsedMs).toBe(1500);
  });

  it("generates a runId", () => {
    const result = makeMockResult();
    const anon = anonymize(result);
    expect(anon.runId).toContain("gemma3-4b");
    expect(anon.schemaVersion).toBe("1.0.0");
  });

  it("extracts quantization from model name", () => {
    const result = makeMockResult();
    const anon = anonymize(result);
    expect(anon.model.quantization).toBe("q4_k_m");
  });
});

describe("checkGhCli", () => {
  it("returns an object with available and authenticated fields", () => {
    const status = checkGhCli();
    expect(typeof status.available).toBe("boolean");
    expect(typeof status.authenticated).toBe("boolean");
  });
});
