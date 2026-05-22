/**
 * Qwen 3.6 local-agent provenance: model presets and historical metadata.
 *
 * NOT THE QWEN TEAM'S QWENCLAWBENCH. This file captures a private local-agent
 * workflow that happened to target Qwen 3.6 models. The Qwen team's
 * "QwenClawBench" is a separate internal coding-agent benchmark that is not
 * yet public. See `qwenclaw-bench-upstream.ts` for upstream facts and release
 * tracking.
 *
 * This module intentionally uses generic local-agent language. Public
 * Gemmaclaw docs and source should not expose a private agent name or private
 * infrastructure as if those details are meaningful to other users.
 */

import type { AgentBenchmarkConfig } from "./agent-runner.js";

// ── Canonical Qwen 3.6 target identifiers ──────────────────────────────────

/**
 * The two Qwen 3.6 local agent benchmark targets, using the original Ollama model IDs
 * as the canonical identifiers for provenance.
 */
export const QWEN36_LOCAL_AGENT_MODEL_IDS = {
  /** Dense 27B-class model. Was pulled as "qwen3.6:35b" from Ollama. */
  DENSE: "qwen3.6:35b" as const,
  /** MoE 35B-A3B model. Was pulled as "qwen3.6:35b-a3b-q4_K_M" from Ollama. */
  MOE: "qwen3.6:35b-a3b-q4_K_M" as const,
} as const;

export type Qwen36LocalAgentModelId =
  (typeof QWEN36_LOCAL_AGENT_MODEL_IDS)[keyof typeof QWEN36_LOCAL_AGENT_MODEL_IDS];

// ── Current llama.cpp model mappings ───────────────────────────────────────

/**
 * Mapping from local agent/Ollama model IDs to current llama.cpp GGUF identifiers.
 * Updated 2026-05-21 from knowledge/infra/gemmaclaw-benchmark-backends.md.
 */
export const QWEN36_LLAMACPP_MAPPING: Record<
  Qwen36LocalAgentModelId,
  { alias: string; gguf: string; vram: string; genToks: string; status: "ready" | "blocked" }
> = {
  "qwen3.6:35b": {
    alias: "qwen3.6-27b-dense",
    // froggeric GGUF resolves unsloth empty-tensor issue; alias matches --alias arg
    gguf: "froggeric/Qwen3.6-27B-GGUF -> Qwen3.6-27B-Q4_K_M.gguf",
    vram: "~19600 MiB at ctx=65536",
    genToks: "63-65 tok/s with MTP, 76-85% acceptance",
    // BLOCKED: unsloth GGUF (original) has empty tensor names on llama.cpp b9190.
    // froggeric GGUF works but is not competitive vs MoE (133 tok/s). Use as
    // smaller smoke target only. See knowledge/infra/gemmaclaw-benchmark-backends.md
    // "Qwen 3.6 27B dense (unsloth GGUF — BLOCKED)" section.
    status: "blocked",
  },
  "qwen3.6:35b-a3b-q4_K_M": {
    alias: "qwen3.6-35b-a3b",
    gguf: "unsloth/Qwen3.6-35B-A3B-GGUF -> Qwen3.6-35B-A3B-UD-IQ4_XS.gguf",
    vram: "~19100 MiB at ctx=65536",
    genToks: "133-135 tok/s",
    status: "ready",
  },
};

/** True if dense model can be used in a real benchmark run on current hardware. */
export const QWEN36_DENSE_BLOCKED = QWEN36_LLAMACPP_MAPPING["qwen3.6:35b"].status === "blocked";

// ── Default llama.cpp server endpoint ──────────────────────────────────────

/** Local llama.cpp OpenAI-compatible endpoint. Override with --llama-cpp-url for remote hosts. */
export const QWEN36_DEFAULT_LLAMACPP_URL = "http://127.0.0.1:8080";

// ── Gemmaclaw benchmark config presets ─────────────────────────────────────

/**
 * Gemmaclaw benchmark config preset for the Qwen 3.6 MoE model.
 * Run with: pnpm benchmark agent --backend llama-cpp
 *           --llama-cpp-url http://gateway-host:8080
 *           --model qwen3.6-35b-a3b --quant IQ4_XS --thinking high
 *           --run-id qwen36-local-agent-moe-high
 */
export const QWEN36_MOE_PRESET: Partial<AgentBenchmarkConfig> = {
  backend: "llama-cpp",
  llamaCppUrl: QWEN36_DEFAULT_LLAMACPP_URL,
  // Alias served by llamacpp-qwen36-35b-a3b-server.service (or custom launch).
  model: QWEN36_LLAMACPP_MAPPING["qwen3.6:35b-a3b-q4_K_M"].alias,
  quant: "IQ4_XS",
  thinkingLevel: "high",
};

/**
 * Gemmaclaw benchmark config preset for the Qwen 3.6 dense model.
 * NOTE: The unsloth GGUF is blocked. Use froggeric GGUF as smoke target.
 * Not competitive vs MoE — use for provenance smoke only.
 */
export const QWEN36_DENSE_PRESET: Partial<AgentBenchmarkConfig> = {
  backend: "llama-cpp",
  llamaCppUrl: QWEN36_DEFAULT_LLAMACPP_URL,
  // Uses froggeric GGUF alias. See QWEN36_LLAMACPP_MAPPING for blocker details.
  model: QWEN36_LLAMACPP_MAPPING["qwen3.6:35b"].alias,
  quant: "Q4_K_M",
  thinkingLevel: "high",
};

// ── Historical local agent run completion criteria ────────────────────────────────

/** Minimum task count for a local agent run manifest to be considered complete. */
export const LEGACY_AGENT_MANIFEST_MIN_TASKS = 22;

/**
 * Check whether a raw local agent run manifest object meets the historical
 * local agent completion criteria:
 *   - manifest.finished is non-empty (string)
 *   - manifest.tasks_run >= LEGACY_AGENT_MANIFEST_MIN_TASKS (22)
 */
export function isLegacyAgentManifestComplete(manifest: unknown): boolean {
  if (typeof manifest !== "object" || manifest === null) {
    return false;
  }
  const m = manifest as Record<string, unknown>;
  const finished = m["finished"];
  const tasksRun = m["tasks_run"];
  if (finished == null || typeof finished !== "string" || finished.trim() === "") {
    return false;
  }
  const count = typeof tasksRun === "number" ? tasksRun : Number(tasksRun) || 0;
  return count >= LEGACY_AGENT_MANIFEST_MIN_TASKS;
}

/**
 * Human-readable description of the Qwen 3.6 local agent provenance brought
 * into Gemmaclaw. This is NOT the Qwen team's QwenClawBench (see
 * `qwenclaw-bench-upstream.ts`); it documents a private local-agent runner
 * so that historical manifests can be validated and the same Qwen 3.6
 * targets can be re-run from Gemmaclaw.
 */
export const QWEN36_LOCAL_AGENT_PROVENANCE = {
  name: "Qwen 3.6 local agent provenance",
  version: "1.1.0",
  portedFrom: "private local-agent benchmark workflow",
  portedOn: "2026-05-21",
  distinctFromUpstream:
    "This is a private local-agent runner for Qwen 3.6 models. " +
    "It is NOT the Qwen team's QwenClawBench (open-sourcing soon). " +
    "See `qwenclaw-bench-upstream.ts` for the upstream release scaffold.",
  models: [
    {
      sourceModelId: QWEN36_LOCAL_AGENT_MODEL_IDS.MOE,
      llamaCppAlias: QWEN36_LLAMACPP_MAPPING["qwen3.6:35b-a3b-q4_K_M"].alias,
      gguf: QWEN36_LLAMACPP_MAPPING["qwen3.6:35b-a3b-q4_K_M"].gguf,
      status: "ready",
      benchmarkCommand:
        "pnpm benchmark agent --backend llama-cpp --llama-cpp-url http://gateway-host:8080 " +
        "--model qwen3.6-35b-a3b --quant IQ4_XS --thinking high --run-id qwen36-local-agent-moe-high",
    },
    {
      sourceModelId: QWEN36_LOCAL_AGENT_MODEL_IDS.DENSE,
      llamaCppAlias: QWEN36_LLAMACPP_MAPPING["qwen3.6:35b"].alias,
      gguf: QWEN36_LLAMACPP_MAPPING["qwen3.6:35b"].gguf,
      status: "blocked",
      blockerNote:
        "Unsloth GGUF has empty tensor names on llama.cpp b9190. " +
        "Froggeric GGUF works but is not competitive (63-65 tok/s vs 133 for MoE). " +
        "Use as smoke target only. See knowledge/infra/gemmaclaw-benchmark-backends.md.",
      benchmarkCommand:
        "pnpm benchmark agent --backend llama-cpp --llama-cpp-url http://gateway-host:8080 " +
        "--model qwen3.6-27b-dense --quant Q4_K_M --thinking high --run-id qwen36-local-agent-dense-smoke",
    },
  ],
  legacyCompletionCriteria: {
    minTasksRun: LEGACY_AGENT_MANIFEST_MIN_TASKS,
    finishedFieldRequired: true,
    description:
      "A local agent run is complete when manifest.json exists, manifest.finished is non-empty, " +
      `and manifest.tasks_run >= ${LEGACY_AGENT_MANIFEST_MIN_TASKS}.`,
  },
};
