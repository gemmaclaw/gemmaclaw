/**
 * Upstream Qwen-team QwenClawBench facts and release-tracking scaffold.
 *
 * This module records what the Qwen team has publicly stated about
 * QwenClawBench. It is NOT a runner for the benchmark. The benchmark has
 * not been open-sourced yet (per Qwen Hugging Face model cards, as of
 * 2026-05-21), so there is no artifact for Gemmaclaw to import.
 *
 * If Qwen releases QwenClawBench, this module is where the public facts
 * land: dataset/repo URLs, schema, scoring code, and a documented adapter
 * path. Until then the constants here serve two purposes:
 *
 *   1. Guard rails: anyone implementing a Gemmaclaw "QwenClawBench" suite
 *      must reference this module so that a synthetic substitute does not
 *      get published under the QwenClawBench name.
 *
 *   2. Watcher inputs: `assessQwenClawBenchRelease()` can be called from a
 *      release-watcher script that fetches the upstream model cards and
 *      verifies whether the "open-sourcing soon" language is still present.
 *
 * Distinct from `qwen36-jake-models.ts`, which captures Frank's older
 * local Jake/Pi runner targeting Qwen 3.6 models. That port is purely
 * historical and unrelated to the Qwen team's internal benchmark.
 */

// ── Public facts (verified against official Qwen sources, 2026-05-21) ─────

/**
 * Stable URLs for the Qwen-team sources used to anchor the upstream
 * QwenClawBench facts. Only Qwen-Team-owned namespaces are listed.
 */
export const QWENCLAW_BENCH_UPSTREAM_SOURCES = {
  github: "https://github.com/QwenLM/Qwen3.6",
  hfQwen36MoE: "https://huggingface.co/Qwen/Qwen3.6-35B-A3B",
  hfQwen36MoEFp8: "https://huggingface.co/Qwen/Qwen3.6-35B-A3B-FP8",
} as const;

/**
 * Verbatim footnote text from the Qwen-team Hugging Face model cards.
 * Used by the watcher to detect when the language changes (the benchmark
 * is published, or settings are updated). Keep verbatim, do not paraphrase.
 */
export const QWENCLAW_BENCH_UPSTREAM_FOOTNOTE =
  "QwenClawBench: An internal real-user-distribution Claw agent benchmark " +
  "(open-sourcing soon); temp=0.6, 256K ctx.";

/**
 * Publicly stated run settings for QwenClawBench. Pulled from the Qwen-team
 * model card footnote. Use these as the canonical settings once the
 * benchmark itself is released.
 */
export const QWENCLAW_BENCH_UPSTREAM_RUN_SETTINGS = {
  temperature: 0.6,
  contextLengthTokens: 262144,
  contextLengthLabel: "256K",
  description: "Real-user-distribution Claw agent benchmark (internal at Qwen).",
} as const;

/**
 * Snapshot of the QwenClawBench results table from the Qwen-team model card
 * (Qwen3.6-35B-A3B). Used so the watcher and tests can verify the upstream
 * table has not silently changed. Not consumed as benchmark output.
 */
export const QWENCLAW_BENCH_UPSTREAM_TABLE_SNAPSHOT = {
  capturedAt: "2026-05-21",
  source: "huggingface.co/Qwen/Qwen3.6-35B-A3B",
  scores: {
    "Qwen3.5-27B": 52.2,
    "Gemma4-31B": 41.7,
    "Qwen3.5-35BA3B": 47.7,
    "Gemma4-26BA4B": 38.7,
    "Qwen3.6-35BA3B": 52.6,
  },
} as const;

/**
 * Possible release statuses for the upstream QwenClawBench.
 */
export type QwenClawBenchReleaseStatus = "internal-open-sourcing-soon" | "released" | "unknown";

/**
 * Current best knowledge about the upstream release status. Updated when
 * the watcher (`assessQwenClawBenchRelease`) detects a change, or by hand
 * after confirming the Qwen-team blog/repo.
 */
export const QWENCLAW_BENCH_UPSTREAM_STATUS: {
  status: QwenClawBenchReleaseStatus;
  asOf: string;
  evidence: string;
  publicArtifactUrl: string | null;
} = {
  status: "internal-open-sourcing-soon",
  asOf: "2026-05-21",
  evidence:
    "Hugging Face model cards for Qwen3.6-35B-A3B and Qwen3.6-35B-A3B-FP8 " +
    "describe QwenClawBench as an internal real-user-distribution Claw agent " +
    "benchmark with the note '(open-sourcing soon); temp=0.6, 256K ctx'. " +
    "The QwenLM/Qwen3.6 GitHub README does not mention QwenClawBench or " +
    "expose any benchmark dataset/repo.",
  publicArtifactUrl: null,
};

// ── Release-watcher logic ─────────────────────────────────────────────────

/**
 * Output of `assessQwenClawBenchRelease`. The watcher fetches the upstream
 * model card text(s) elsewhere and passes the strings in; this function is
 * pure so it can be tested without network access.
 */
export type QwenClawBenchReleaseAssessment = {
  status: QwenClawBenchReleaseStatus;
  /** Human-readable explanation suitable for a watcher log line. */
  reason: string;
  /** True when the watcher should NOT yet treat QwenClawBench as importable. */
  blockedOnUpstream: boolean;
  /** True when the watcher detected a release signal that needs follow-up. */
  releaseSignalDetected: boolean;
};

/**
 * Heuristic check on upstream model-card text. If any input contains the
 * phrase "open-sourcing soon" near "QwenClawBench", the benchmark is still
 * internal. If a card mentions QwenClawBench but no longer carries the
 * "open-sourcing soon" language, treat that as a release signal that needs
 * manual follow-up.
 *
 * Pure function: takes strings, returns a verdict. Network/IO lives in the
 * watcher script that calls this helper.
 */
export function assessQwenClawBenchRelease(
  sources: { url: string; text: string }[],
): QwenClawBenchReleaseAssessment {
  if (sources.length === 0) {
    return {
      status: "unknown",
      reason: "no upstream sources provided to watcher",
      blockedOnUpstream: true,
      releaseSignalDetected: false,
    };
  }

  let sawBenchMention = false;
  let sawOpenSourcingSoon = false;
  const mentionsWithoutSoon: string[] = [];

  for (const source of sources) {
    const lower = source.text.toLowerCase();
    const hasName = lower.includes("qwenclawbench");
    const hasSoon = lower.includes("open-sourcing soon");
    if (hasName) {
      sawBenchMention = true;
      if (hasSoon) {
        sawOpenSourcingSoon = true;
      } else {
        mentionsWithoutSoon.push(source.url);
      }
    }
  }

  if (!sawBenchMention) {
    return {
      status: "unknown",
      reason: "no QwenClawBench mention found in upstream sources",
      blockedOnUpstream: true,
      releaseSignalDetected: false,
    };
  }

  if (sawOpenSourcingSoon) {
    return {
      status: "internal-open-sourcing-soon",
      reason:
        "upstream sources still describe QwenClawBench as 'open-sourcing soon' " +
        "(internal Qwen-team benchmark); do not import or substitute",
      blockedOnUpstream: true,
      releaseSignalDetected: false,
    };
  }

  return {
    status: "unknown",
    reason:
      "QwenClawBench is mentioned in upstream sources WITHOUT the 'open-sourcing soon' " +
      `language: ${mentionsWithoutSoon.join(", ")}. Manual follow-up required to ` +
      "confirm whether the benchmark has been published.",
    blockedOnUpstream: true,
    releaseSignalDetected: true,
  };
}

/**
 * Hard rule: until QwenClawBench is publicly released by the Qwen team,
 * Gemmaclaw must not publish or label any internal/synthetic suite as
 * "QwenClawBench". Use this guard in any code path that wants to expose a
 * QwenClawBench-named artifact.
 */
export function ensureQwenClawBenchImportAllowed(): void {
  if (QWENCLAW_BENCH_UPSTREAM_STATUS.status !== "released") {
    throw new Error(
      "QwenClawBench upstream is not released yet " +
        `(status=${QWENCLAW_BENCH_UPSTREAM_STATUS.status}, asOf=${QWENCLAW_BENCH_UPSTREAM_STATUS.asOf}). ` +
        "Do not publish a Gemmaclaw artifact under the QwenClawBench name. " +
        "Update QWENCLAW_BENCH_UPSTREAM_STATUS after confirming the Qwen-team release.",
    );
  }
}

// ── Watcher checklist (consumed by docs + release script) ─────────────────

/**
 * Steps the release watcher / human follow-up should perform when the
 * upstream model cards stop saying "open-sourcing soon". Kept here so
 * docs and any future automation use the same checklist.
 */
export const QWENCLAW_BENCH_RELEASE_CHECKLIST: readonly string[] = [
  "Confirm the new public artifact URL is in a Qwen-team-owned namespace " +
    "(github.com/QwenLM, huggingface.co/Qwen, or an officially linked Qwen blog).",
  "Read the released README/scoring docs end to end before touching Gemmaclaw " +
    "code. Capture: dataset shape, scoring rule, required tools, expected runtime.",
  "Verify the upstream run settings still match QWENCLAW_BENCH_UPSTREAM_RUN_SETTINGS " +
    "(temperature=0.6, context length 256K). Any difference is a doc bug to flag.",
  "Implement the Gemmaclaw adapter behind a feature flag with " +
    "GEMMACLAW_BENCHMARK_CONTAINER=1 + fake-gog enforced. No host-mode run.",
  "Do not use OPENAI_API_KEY anywhere in the adapter. If frontier judging is " +
    "required, route through CC ACP / OAuth-backed CLI per Frank's directive.",
  "Update QWENCLAW_BENCH_UPSTREAM_STATUS.status to 'released', set " +
    "publicArtifactUrl, refresh asOf and evidence, and bump the table snapshot.",
  "Add an end-to-end smoke that exercises the adapter against a small subset " +
    "before any publishable run.",
];
