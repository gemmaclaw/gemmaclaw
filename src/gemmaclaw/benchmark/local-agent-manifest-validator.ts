/**
 * Local-agent run manifest validator.
 *
 * Validates historical local-agent benchmark manifests using a simple
 * completion rule: manifest.finished is non-empty and manifest.tasks_run >= 22.
 * This is for private provenance artifacts only. It is not a validator for the
 * Qwen team's QwenClawBench, which is a separate internal benchmark.
 */

import {
  isLegacyAgentManifestComplete,
  LEGACY_AGENT_MANIFEST_MIN_TASKS,
} from "./qwen36-local-agent-models.js";

export type LegacyAgentManifest = {
  /** ISO timestamp when the run finished. Non-empty = complete. */
  finished?: string;
  /** Number of tasks executed in this run. */
  tasks_run?: number;
  /** Model that was benchmarked. */
  model?: string;
  /** Thinking level used (e.g. "high"). */
  thinking?: string;
  /** Run directory name. */
  run_dir?: string;
  /** Any additional fields from the manifest. */
  [key: string]: unknown;
};

export type ManifestValidationResult =
  | { valid: true; manifest: LegacyAgentManifest; reason?: never }
  | { valid: false; manifest?: LegacyAgentManifest; reason: string };

/**
 * Validate a local-agent run manifest object against the historical completion
 * criteria.
 *
 * Returns { valid: true } when:
 *   - manifest is a non-null object
 *   - manifest.finished is a non-empty string
 *   - manifest.tasks_run >= LEGACY_AGENT_MANIFEST_MIN_TASKS (22)
 */
export function validateLegacyAgentManifest(raw: unknown): ManifestValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { valid: false, reason: "manifest is not an object" };
  }
  const manifest = raw as LegacyAgentManifest;
  const finished = manifest.finished;
  if (finished == null || finished.trim() === "") {
    return {
      valid: false,
      manifest,
      reason: "manifest.finished is missing or empty — run not complete",
    };
  }
  const tasksRun =
    typeof manifest.tasks_run === "number" ? manifest.tasks_run : Number(manifest.tasks_run) || 0;
  if (tasksRun < LEGACY_AGENT_MANIFEST_MIN_TASKS) {
    return {
      valid: false,
      manifest,
      reason: `manifest.tasks_run is ${tasksRun}, need >= ${LEGACY_AGENT_MANIFEST_MIN_TASKS}`,
    };
  }
  return { valid: true, manifest };
}

/**
 * Validate a synthetic or loaded fixture manifest and return a human-readable
 * summary string.
 */
export function describeManifestValidation(raw: unknown): string {
  const result = validateLegacyAgentManifest(raw);
  if (result.valid) {
    const m = result.manifest;
    return (
      `COMPLETE: model=${m.model ?? "unknown"} finished=${m.finished} ` +
      `tasks_run=${m.tasks_run ?? "?"}`
    );
  }
  return `INCOMPLETE: ${result.reason}`;
}

/**
 * Validate a set of local-agent manifest objects for both Qwen 3.6 targets
 * (dense and MoE).
 *
 * Returns a summary object with per-model results.
 */
export function validateQwen36LocalAgentRuns(manifests: { dense?: unknown; moe?: unknown }): {
  dense: ManifestValidationResult;
  moe: ManifestValidationResult;
  bothComplete: boolean;
} {
  const dense = validateLegacyAgentManifest(manifests.dense);
  const moe = validateLegacyAgentManifest(manifests.moe);
  return {
    dense,
    moe,
    bothComplete: dense.valid && moe.valid,
  };
}

// Re-export for convenience
export { isLegacyAgentManifestComplete, LEGACY_AGENT_MANIFEST_MIN_TASKS };
