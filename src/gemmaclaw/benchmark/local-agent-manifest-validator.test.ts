/**
 * Tests for local-agent-manifest-validator.ts — Qwen 3.6 local agent provenance.
 *
 * These are pure-unit / fixture-backed tests. No model inference, no Docker,
 * no network. They verify that the manifest validator correctly applies the
 * historical local agent completion criteria (finished non-empty, tasks_run >= 22)
 * and that model preset metadata is accurate.
 *
 * SCOPE: validates private local-agent runner artifacts. NOT a validator for
 * the Qwen team's upstream QwenClawBench. See
 * `qwenclaw-bench-upstream.test.ts` for upstream-fact tests.
 */

import { describe, expect, it } from "vitest";
import {
  LEGACY_AGENT_MANIFEST_MIN_TASKS,
  describeManifestValidation,
  validateLegacyAgentManifest,
  validateQwen36LocalAgentRuns,
} from "./local-agent-manifest-validator.js";
import {
  QWEN36_DENSE_BLOCKED,
  QWEN36_LOCAL_AGENT_MODEL_IDS,
  QWEN36_LOCAL_AGENT_PROVENANCE,
  QWEN36_LLAMACPP_MAPPING,
  QWEN36_MOE_PRESET,
  isLegacyAgentManifestComplete,
} from "./qwen36-local-agent-models.js";

// ── Fixture manifests ───────────────────────────────────────────────────────

const COMPLETE_MANIFEST = {
  finished: "2026-04-10T14:23:00Z",
  tasks_run: 22,
  model: "qwen3.6:35b-a3b-q4_K_M",
  thinking: "high",
};

const COMPLETE_MANIFEST_LARGE = {
  finished: "2026-04-11T08:00:00Z",
  tasks_run: 24,
  model: "qwen3.6:35b",
  thinking: "high",
};

const PARTIAL_MANIFEST_LOW_TASKS = {
  finished: "2026-04-10T09:00:00Z",
  tasks_run: 10,
  model: "qwen3.6:35b",
  thinking: "high",
};

const INCOMPLETE_MANIFEST_NO_FINISHED = {
  finished: "",
  tasks_run: 22,
  model: "qwen3.6:35b",
};

const INCOMPLETE_MANIFEST_MISSING_FINISHED = {
  tasks_run: 22,
  model: "qwen3.6:35b",
};

const MALFORMED_MANIFEST = "not an object";
const NULL_MANIFEST = null;

// ── isLegacyAgentManifestComplete (qwen36-local-agent-models.ts) ──────────────────────────

describe("isLegacyAgentManifestComplete", () => {
  it("returns true for a complete manifest with exactly 22 tasks", () => {
    expect(isLegacyAgentManifestComplete(COMPLETE_MANIFEST)).toBe(true);
  });

  it("returns true for a complete manifest with more than 22 tasks", () => {
    expect(isLegacyAgentManifestComplete(COMPLETE_MANIFEST_LARGE)).toBe(true);
  });

  it("returns false when tasks_run is below 22", () => {
    expect(isLegacyAgentManifestComplete(PARTIAL_MANIFEST_LOW_TASKS)).toBe(false);
  });

  it("returns false when finished is an empty string", () => {
    expect(isLegacyAgentManifestComplete(INCOMPLETE_MANIFEST_NO_FINISHED)).toBe(false);
  });

  it("returns false when finished is missing", () => {
    expect(isLegacyAgentManifestComplete(INCOMPLETE_MANIFEST_MISSING_FINISHED)).toBe(false);
  });

  it("returns false for null input", () => {
    expect(isLegacyAgentManifestComplete(null)).toBe(false);
  });

  it("returns false for non-object input", () => {
    expect(isLegacyAgentManifestComplete("not an object")).toBe(false);
  });
});

// ── validateLegacyAgentManifest ────────────────────────────────────────────────────

describe("validateLegacyAgentManifest", () => {
  it("validates a complete manifest", () => {
    const result = validateLegacyAgentManifest(COMPLETE_MANIFEST);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.tasks_run).toBe(22);
    }
  });

  it("returns invalid for missing finished", () => {
    const result = validateLegacyAgentManifest(INCOMPLETE_MANIFEST_MISSING_FINISHED);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("finished");
    }
  });

  it("returns invalid for empty finished", () => {
    const result = validateLegacyAgentManifest(INCOMPLETE_MANIFEST_NO_FINISHED);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("finished");
    }
  });

  it("returns invalid for low task count", () => {
    const result = validateLegacyAgentManifest(PARTIAL_MANIFEST_LOW_TASKS);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("tasks_run");
      expect(result.reason).toContain(String(LEGACY_AGENT_MANIFEST_MIN_TASKS));
    }
  });

  it("returns invalid for null manifest", () => {
    const result = validateLegacyAgentManifest(NULL_MANIFEST);
    expect(result.valid).toBe(false);
  });

  it("returns invalid for malformed manifest", () => {
    const result = validateLegacyAgentManifest(MALFORMED_MANIFEST);
    expect(result.valid).toBe(false);
  });
});

// ── describeManifestValidation ──────────────────────────────────────────────

describe("describeManifestValidation", () => {
  it("returns COMPLETE string for valid manifest", () => {
    const desc = describeManifestValidation(COMPLETE_MANIFEST);
    expect(desc).toMatch(/^COMPLETE:/);
    expect(desc).toContain("tasks_run=22");
  });

  it("returns INCOMPLETE string for invalid manifest", () => {
    const desc = describeManifestValidation(PARTIAL_MANIFEST_LOW_TASKS);
    expect(desc).toMatch(/^INCOMPLETE:/);
  });
});

// ── validateQwen36LocalAgentRuns ──────────────────────────────────────────────────

describe("validateQwen36LocalAgentRuns", () => {
  it("reports bothComplete=true when both manifests are complete", () => {
    const result = validateQwen36LocalAgentRuns({
      dense: COMPLETE_MANIFEST_LARGE,
      moe: COMPLETE_MANIFEST,
    });
    expect(result.bothComplete).toBe(true);
    expect(result.dense.valid).toBe(true);
    expect(result.moe.valid).toBe(true);
  });

  it("reports bothComplete=false when dense is missing", () => {
    const result = validateQwen36LocalAgentRuns({ moe: COMPLETE_MANIFEST });
    expect(result.bothComplete).toBe(false);
    expect(result.dense.valid).toBe(false);
  });

  it("reports bothComplete=false when moe is incomplete", () => {
    const result = validateQwen36LocalAgentRuns({
      dense: COMPLETE_MANIFEST_LARGE,
      moe: PARTIAL_MANIFEST_LOW_TASKS,
    });
    expect(result.bothComplete).toBe(false);
    expect(result.moe.valid).toBe(false);
  });

  it("reports bothComplete=false when both are undefined", () => {
    const result = validateQwen36LocalAgentRuns({});
    expect(result.bothComplete).toBe(false);
  });
});

// ── Model preset metadata (provenance checks) ───────────────────────────────

describe("QWEN36 model preset metadata", () => {
  it("has both OpenClaw local agent model IDs defined", () => {
    expect(QWEN36_LOCAL_AGENT_MODEL_IDS.DENSE).toBe("qwen3.6:35b");
    expect(QWEN36_LOCAL_AGENT_MODEL_IDS.MOE).toBe("qwen3.6:35b-a3b-q4_K_M");
  });

  it("marks dense model as blocked", () => {
    expect(QWEN36_DENSE_BLOCKED).toBe(true);
    expect(QWEN36_LLAMACPP_MAPPING["qwen3.6:35b"].status).toBe("blocked");
  });

  it("marks MoE model as ready", () => {
    expect(QWEN36_LLAMACPP_MAPPING["qwen3.6:35b-a3b-q4_K_M"].status).toBe("ready");
  });

  it("MoE preset uses llama-cpp backend", () => {
    expect(QWEN36_MOE_PRESET.backend).toBe("llama-cpp");
    expect(QWEN36_MOE_PRESET.thinkingLevel).toBe("high");
    expect(QWEN36_MOE_PRESET.quant).toBe("IQ4_XS");
  });

  it("LEGACY_AGENT_MANIFEST_MIN_TASKS is 22 (historical OpenClaw local agent criterion)", () => {
    expect(LEGACY_AGENT_MANIFEST_MIN_TASKS).toBe(22);
  });

  it("provenance includes both model entries", () => {
    expect(QWEN36_LOCAL_AGENT_PROVENANCE.models).toHaveLength(2);
    const sourceModelIds = QWEN36_LOCAL_AGENT_PROVENANCE.models.map((m) => m.sourceModelId);
    expect(sourceModelIds).toContain("qwen3.6:35b");
    expect(sourceModelIds).toContain("qwen3.6:35b-a3b-q4_K_M");
  });

  it("provenance has benchmark commands for both models", () => {
    for (const m of QWEN36_LOCAL_AGENT_PROVENANCE.models) {
      expect(m.benchmarkCommand).toContain("pnpm benchmark agent");
      expect(m.benchmarkCommand).toContain("--backend llama-cpp");
    }
  });

  it("provenance explicitly distinguishes from upstream QwenClawBench", () => {
    expect(QWEN36_LOCAL_AGENT_PROVENANCE.distinctFromUpstream).toMatch(/QwenClawBench/i);
    expect(QWEN36_LOCAL_AGENT_PROVENANCE.distinctFromUpstream).toMatch(/NOT/);
  });
});
