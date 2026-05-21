/**
 * Tests for qwenclaw-bench-upstream.ts.
 *
 * Pure-unit tests. They verify that the public-fact constants stay anchored
 * to the Qwen-team sources, the release-watcher heuristic correctly handles
 * the three input shapes (no mention, "open-sourcing soon" present, mention
 * without the phrase), and the import-guard refuses while upstream is
 * still internal.
 */

import { describe, expect, it } from "vitest";
import {
  QWENCLAW_BENCH_RELEASE_CHECKLIST,
  QWENCLAW_BENCH_UPSTREAM_FOOTNOTE,
  QWENCLAW_BENCH_UPSTREAM_RUN_SETTINGS,
  QWENCLAW_BENCH_UPSTREAM_SOURCES,
  QWENCLAW_BENCH_UPSTREAM_STATUS,
  QWENCLAW_BENCH_UPSTREAM_TABLE_SNAPSHOT,
  assessQwenClawBenchRelease,
  ensureQwenClawBenchImportAllowed,
} from "./qwenclaw-bench-upstream.js";

describe("QWENCLAW_BENCH_UPSTREAM_SOURCES", () => {
  it("only references Qwen-team-owned URLs", () => {
    for (const url of Object.values(QWENCLAW_BENCH_UPSTREAM_SOURCES)) {
      expect(url).toMatch(/^https:\/\/(github\.com\/QwenLM|huggingface\.co\/Qwen)/);
    }
  });

  it("includes both MoE and FP8 model cards", () => {
    expect(QWENCLAW_BENCH_UPSTREAM_SOURCES.hfQwen36MoE).toContain("Qwen3.6-35B-A3B");
    expect(QWENCLAW_BENCH_UPSTREAM_SOURCES.hfQwen36MoEFp8).toContain("FP8");
  });
});

describe("QWENCLAW_BENCH_UPSTREAM_FOOTNOTE", () => {
  it("preserves the verbatim Qwen-team footnote", () => {
    expect(QWENCLAW_BENCH_UPSTREAM_FOOTNOTE).toContain("internal real-user-distribution");
    expect(QWENCLAW_BENCH_UPSTREAM_FOOTNOTE).toContain("Claw agent benchmark");
    expect(QWENCLAW_BENCH_UPSTREAM_FOOTNOTE).toContain("open-sourcing soon");
    expect(QWENCLAW_BENCH_UPSTREAM_FOOTNOTE).toContain("temp=0.6");
    expect(QWENCLAW_BENCH_UPSTREAM_FOOTNOTE).toContain("256K ctx");
  });
});

describe("QWENCLAW_BENCH_UPSTREAM_RUN_SETTINGS", () => {
  it("uses the upstream-documented temperature 0.6", () => {
    expect(QWENCLAW_BENCH_UPSTREAM_RUN_SETTINGS.temperature).toBe(0.6);
  });

  it("uses the upstream-documented 256K context length", () => {
    expect(QWENCLAW_BENCH_UPSTREAM_RUN_SETTINGS.contextLengthTokens).toBe(262144);
    expect(QWENCLAW_BENCH_UPSTREAM_RUN_SETTINGS.contextLengthLabel).toBe("256K");
  });
});

describe("QWENCLAW_BENCH_UPSTREAM_TABLE_SNAPSHOT", () => {
  it("matches the published model-card numbers", () => {
    expect(QWENCLAW_BENCH_UPSTREAM_TABLE_SNAPSHOT.scores["Qwen3.6-35BA3B"]).toBe(52.6);
    expect(QWENCLAW_BENCH_UPSTREAM_TABLE_SNAPSHOT.scores["Qwen3.5-27B"]).toBe(52.2);
    expect(QWENCLAW_BENCH_UPSTREAM_TABLE_SNAPSHOT.scores["Gemma4-31B"]).toBe(41.7);
  });

  it("cites a Qwen-team source", () => {
    expect(QWENCLAW_BENCH_UPSTREAM_TABLE_SNAPSHOT.source).toContain("Qwen/Qwen3.6");
  });
});

describe("QWENCLAW_BENCH_UPSTREAM_STATUS", () => {
  it("starts in the internal-open-sourcing-soon state", () => {
    expect(QWENCLAW_BENCH_UPSTREAM_STATUS.status).toBe("internal-open-sourcing-soon");
  });

  it("has no public artifact URL while internal", () => {
    expect(QWENCLAW_BENCH_UPSTREAM_STATUS.publicArtifactUrl).toBeNull();
  });
});

describe("assessQwenClawBenchRelease", () => {
  it("returns unknown when no sources are provided", () => {
    const r = assessQwenClawBenchRelease([]);
    expect(r.status).toBe("unknown");
    expect(r.blockedOnUpstream).toBe(true);
    expect(r.releaseSignalDetected).toBe(false);
  });

  it("returns unknown when QwenClawBench is not mentioned", () => {
    const r = assessQwenClawBenchRelease([
      { url: "https://huggingface.co/Qwen/Qwen3.6-35B-A3B", text: "Qwen3.6 release notes." },
    ]);
    expect(r.status).toBe("unknown");
    expect(r.blockedOnUpstream).toBe(true);
    expect(r.releaseSignalDetected).toBe(false);
  });

  it("returns internal-open-sourcing-soon when the upstream still gates the bench", () => {
    const r = assessQwenClawBenchRelease([
      {
        url: "https://huggingface.co/Qwen/Qwen3.6-35B-A3B",
        text:
          "QwenClawBench: An internal real-user-distribution Claw agent " +
          "benchmark (open-sourcing soon); temp=0.6, 256K ctx.",
      },
    ]);
    expect(r.status).toBe("internal-open-sourcing-soon");
    expect(r.blockedOnUpstream).toBe(true);
    expect(r.releaseSignalDetected).toBe(false);
  });

  it("flags a release signal when the bench is mentioned without the 'open-sourcing soon' phrase", () => {
    const r = assessQwenClawBenchRelease([
      {
        url: "https://github.com/QwenLM/Qwen3.6",
        text: "See QwenClawBench at https://github.com/QwenLM/QwenClawBench for run instructions.",
      },
    ]);
    expect(r.status).toBe("unknown");
    expect(r.blockedOnUpstream).toBe(true);
    expect(r.releaseSignalDetected).toBe(true);
    expect(r.reason).toContain("Manual follow-up");
  });
});

describe("ensureQwenClawBenchImportAllowed", () => {
  it("throws while upstream is still internal", () => {
    expect(() => ensureQwenClawBenchImportAllowed()).toThrowError(/not released yet/);
  });
});

describe("QWENCLAW_BENCH_RELEASE_CHECKLIST", () => {
  it("includes the Qwen-team source-ownership check", () => {
    const all = QWENCLAW_BENCH_RELEASE_CHECKLIST.join(" ");
    expect(all).toMatch(/Qwen-team-owned/);
  });

  it("includes the container/credential guard reminders", () => {
    const all = QWENCLAW_BENCH_RELEASE_CHECKLIST.join(" ");
    expect(all).toMatch(/GEMMACLAW_BENCHMARK_CONTAINER/);
    expect(all).toMatch(/fake-gog/);
    expect(all).toMatch(/OPENAI_API_KEY/);
  });

  it("ends with a published-status update step", () => {
    const last = QWENCLAW_BENCH_RELEASE_CHECKLIST[QWENCLAW_BENCH_RELEASE_CHECKLIST.length - 2];
    expect(last).toMatch(/QWENCLAW_BENCH_UPSTREAM_STATUS/);
  });
});
