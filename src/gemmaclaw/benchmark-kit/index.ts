/**
 * Benchmark Kit: unified benchmark harness shared between gemmaclaw and jake-benchmark.
 */

export { selectBestConfig } from "./select-config.js";
export type { SelectionOpts, RecommendedConfig } from "./select-config.js";
export { runSweep } from "./sweep.js";
export type { SweepConfig } from "./sweep.js";
export {
  BUILTIN_PACKS,
  builtinPackPath,
  filterQuickTasks,
  loadBenchmarkPack,
  loadBuiltinPack,
  loadCoreTasks,
  loadJakeAgentTasks,
  loadTaskPack,
} from "./task-loader.js";
export type { BuiltinPackName } from "./task-loader.js";
export { anonymize, checkGhCli, uploadResult } from "./upload.js";
export type { UploadOpts } from "./upload.js";

// V1 pack contract (family-discriminated).
export { BenchmarkPackSchema, parseBenchmarkPack } from "./pack-types.js";
export type {
  AgentPack,
  AgentTask,
  BenchmarkPack,
  ToolFreePack,
  ToolFreeTask,
} from "./pack-types.js";

// Runner adapter contract.
export {
  AgentRunnerNotConfiguredError,
  IncompatiblePackError,
  buildRunner,
  defaultRunnerForPack,
  registerAgentRunner,
} from "./runner-adapter.js";
export type {
  AgentRunnerFactory,
  RunnerHandle,
  RunnerKind,
  RunnerRunOptions,
  RunnerRunResult,
  RunnerTaskOutcome,
} from "./runner-adapter.js";

// Agent-family result artifacts.
export { writeAgentBenchmarkResults } from "./agent-results.js";
export type { AgentBenchmarkArtifact, AgentBenchmarkSummary } from "./agent-results.js";

// Redaction utilities.
export { audit, auditPack, ruleNames, sanitize, sanitizeObject } from "./redaction.js";
export type { AuditOptions, LeakFinding, RedactionProfile } from "./redaction.js";
