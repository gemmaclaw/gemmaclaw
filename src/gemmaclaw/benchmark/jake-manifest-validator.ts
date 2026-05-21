/**
 * Jake run manifest validator.
 *
 * Validates historical Jake benchmark run manifests using the original
 * QwenClaw completion criteria. Used by the Gemmaclaw benchmark port to
 * verify that a Jake run is complete before consuming its artifacts.
 *
 * PROVENANCE: Historical Jake runs live at:
 *   ~/.openclaw/workspace/skills/jake-benchmark/runs/<model>__<ts>/manifest.json
 *   on the Pi (100.108.252.124).
 *
 * Historical completion rule (from cron/jake-benchmark-qwen36-run-until-done.md):
 *   manifest.finished is non-empty AND manifest.tasks_run >= 22
 */

import { isJakeManifestComplete, JAKE_MANIFEST_MIN_TASKS } from "./qwenclaw-models.js";

export type JakeManifest = {
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
  | { valid: true; manifest: JakeManifest; reason?: never }
  | { valid: false; manifest?: JakeManifest; reason: string };

/**
 * Validate a Jake run manifest object against the historical QwenClaw
 * completion criteria.
 *
 * Returns { valid: true } when:
 *   - manifest is a non-null object
 *   - manifest.finished is a non-empty string
 *   - manifest.tasks_run >= JAKE_MANIFEST_MIN_TASKS (22)
 */
export function validateJakeManifest(raw: unknown): ManifestValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { valid: false, reason: "manifest is not an object" };
  }
  const manifest = raw as JakeManifest;
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
  if (tasksRun < JAKE_MANIFEST_MIN_TASKS) {
    return {
      valid: false,
      manifest,
      reason: `manifest.tasks_run is ${tasksRun}, need >= ${JAKE_MANIFEST_MIN_TASKS}`,
    };
  }
  return { valid: true, manifest };
}

/**
 * Validate a synthetic or loaded fixture manifest and return a human-readable
 * summary string.
 */
export function describeManifestValidation(raw: unknown): string {
  const result = validateJakeManifest(raw);
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
 * Validate a set of Jake manifest objects for both QwenClaw targets.
 *
 * Returns a summary object with per-model results.
 */
export function validateQwenClawJakeRuns(manifests: { dense?: unknown; moe?: unknown }): {
  dense: ManifestValidationResult;
  moe: ManifestValidationResult;
  bothComplete: boolean;
} {
  const dense = validateJakeManifest(manifests.dense);
  const moe = validateJakeManifest(manifests.moe);
  return {
    dense,
    moe,
    bothComplete: dense.valid && moe.valid,
  };
}

// Re-export for convenience
export { isJakeManifestComplete, JAKE_MANIFEST_MIN_TASKS };
