/**
 * Benchmark Kit runner adapter contract.
 *
 * Two families of packs (tool-free, agent) need two different execution
 * models. This module defines the typed seam every runner implements and
 * the registry the CLI uses to look one up by name.
 *
 * Adapters today:
 *   - `core-model`:   delegates to the existing tool-free Ollama / llama-cpp
 *                     runner under `src/gemmaclaw/benchmark/runner.ts`.
 *                     Lives in this package because that runner is also
 *                     what `gemmaclaw benchmark` already uses.
 *   - `mock-agent`:   deterministic local smoke runner for agent packs. It
 *                     proves the agent-fixtures pack can load, execute through
 *                     Gemmaclaw's runner seam, and write standard artifacts
 *                     without needing a private local-agent runtime.
 *   - `agent`:        abstract; throws `AgentRunnerNotConfiguredError` until
 *                     a caller registers one. Agent execution requires
 *                     pack-specific tooling (mock fixtures, OpenClaw
 *                     gateway, browser automation) that lives outside this
 *                     repo. See `src/gemmaclaw/benchmark-kit/README.md`
 *                     "Agent Runner" for the integration points.
 *
 * The contract is intentionally minimal: the runner takes a parsed pack
 * (and a model spec hint) and returns a pack-shaped run summary. Pack-
 * specific reporting (failure reports, dashboards) layers on top.
 */

import type { AgentPack, BenchmarkPack, ToolFreePack } from "./pack-types.js";

export type RunnerKind = "core-model" | "agent" | "mock-agent";

export type RunnerHandle = {
  kind: RunnerKind;
  name: string;
  /** Run the supplied pack; pack-family must match what the runner accepts. */
  run(pack: BenchmarkPack, opts: RunnerRunOptions): Promise<RunnerRunResult>;
};

export type RunnerRunOptions = {
  /** Provider+model identifier (e.g. "ollama:gemma3:4b"). */
  modelSpec: string;
  /** Per-task timeout in ms. */
  taskTimeoutMs?: number;
  /** Output directory for runner-owned artifacts; runner may ignore. */
  outDir?: string;
  /** Optional progress callback for log lines. */
  onProgress?: (line: string) => void;
};

export type RunnerTaskOutcome = {
  taskId: string;
  passed: boolean;
  score: number;
  maxScore: number;
  detail?: string;
};

export type RunnerRunResult = {
  packId: string;
  packVersion: string;
  family: BenchmarkPack["family"];
  runnerName: string;
  modelSpec: string;
  outcomes: RunnerTaskOutcome[];
  startedAt: string;
  finishedAt: string;
};

/**
 * Thrown when a caller asks for the agent runner without registering one.
 *
 * The agent runner deliberately requires an explicit caller-provided
 * implementation: pack-specific orchestration (mock email/calendar
 * fixtures, OpenClaw gateway lifecycle, sanitized transcripts) lives
 * outside benchmark-kit because those concerns are not portable across
 * packs. Use `registerAgentRunner` to plug one in, or run the pack
 * through a custom binary that registers one.
 */
export class AgentRunnerNotConfiguredError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "agent runner is not configured. Call registerAgentRunner(factory) " +
          "before running an agent pack, or use a custom binary that ships " +
          "an OpenClaw-driven implementation. See benchmark-kit/README.md.",
    );
    this.name = "AgentRunnerNotConfiguredError";
  }
}

/**
 * Thrown when a runner is asked to execute a pack family it does not accept
 * (e.g. core-model runner asked to execute an agent pack).
 */
export class IncompatiblePackError extends Error {
  constructor(runner: string, family: BenchmarkPack["family"]) {
    super(`runner '${runner}' cannot execute pack family '${family}'`);
    this.name = "IncompatiblePackError";
  }
}

export type AgentRunnerFactory = () => RunnerHandle;

let agentRunnerFactory: AgentRunnerFactory | null = null;

/**
 * Register a factory that produces an agent-family runner. Call this once
 * at startup if your binary bundles an agent runner. Returns the previously
 * registered factory, if any, so callers can chain or restore.
 */
export function registerAgentRunner(factory: AgentRunnerFactory | null): AgentRunnerFactory | null {
  const prev = agentRunnerFactory;
  agentRunnerFactory = factory;
  return prev;
}

/**
 * Build the runner identified by `kind`. Throws `AgentRunnerNotConfiguredError`
 * if `kind === "agent"` and no factory has been registered.
 */
export function buildRunner(kind: RunnerKind): RunnerHandle {
  if (kind === "core-model") {
    return new CoreModelRunner();
  }
  if (kind === "mock-agent") {
    return new MockAgentRunner();
  }
  if (kind === "agent") {
    if (!agentRunnerFactory) {
      throw new AgentRunnerNotConfiguredError();
    }
    return agentRunnerFactory();
  }
  throw new Error(`unknown runner kind: ${kind as string}`);
}

/**
 * Resolve the right runner kind for a parsed pack. Tool-free packs use the
 * core-model runner; agent packs use the agent runner.
 */
export function defaultRunnerForPack(pack: BenchmarkPack): RunnerKind {
  return pack.family === "tool-free" ? "core-model" : "agent";
}

/**
 * Core-model runner stub. The actual benchmark execution lives in
 * `src/gemmaclaw/benchmark/runner.ts` and is wired by the `benchmark`
 * command directly. This stub exposes the runner-handle contract for
 * callers that want to pick a runner via `buildRunner`. Calling `.run`
 * here raises a clear "use the existing benchmark command" error so we
 * don't quietly diverge into a parallel core path.
 */
class CoreModelRunner implements RunnerHandle {
  readonly kind: RunnerKind = "core-model";
  readonly name = "core-model";

  async run(pack: BenchmarkPack, _opts: RunnerRunOptions): Promise<RunnerRunResult> {
    if (pack.family !== "tool-free") {
      throw new IncompatiblePackError(this.name, pack.family);
    }
    // Force a single async hop so the function shape matches the contract.
    await Promise.resolve();
    throw new Error(
      "core-model runner has no in-process execution path yet. Run tool-free " +
        "packs via `gemmaclaw benchmark` (which uses src/gemmaclaw/benchmark/runner.ts). " +
        "This adapter exists so future callers can pick a runner via buildRunner().",
    );
  }
}

/**
 * Deterministic smoke runner for agent packs.
 *
 * This is not a substitute for a live local-agent evaluation. Its job is to
 * make the public Gemmaclaw path actually runnable in CI and by new users:
 * load the first-class agent fixture pack, execute it through the runner adapter,
 * and produce the standard artifact bundle. Live runner integrations can plug
 * into `registerAgentRunner` without changing the pack contract.
 */
class MockAgentRunner implements RunnerHandle {
  readonly kind: RunnerKind = "mock-agent";
  readonly name = "mock-agent";

  async run(pack: BenchmarkPack, opts: RunnerRunOptions): Promise<RunnerRunResult> {
    if (pack.family !== "agent") {
      throw new IncompatiblePackError(this.name, pack.family);
    }

    const startedAt = new Date().toISOString();
    const outcomes: RunnerTaskOutcome[] = [];
    for (const task of pack.tasks) {
      const maxScore = task.grading.max_score;
      opts.onProgress?.(
        `[mock-agent] ${task.id}: PASS ${maxScore}/${maxScore} (${task.grading.type})`,
      );
      outcomes.push({
        taskId: task.id,
        passed: true,
        score: maxScore,
        maxScore,
        detail: `deterministic mock satisfied ${task.grading.type}`,
      });
    }
    const finishedAt = new Date().toISOString();
    await Promise.resolve();
    return {
      packId: pack.pack,
      packVersion: pack.version,
      family: pack.family,
      runnerName: this.name,
      modelSpec: opts.modelSpec,
      outcomes,
      startedAt,
      finishedAt,
    };
  }
}

export type { ToolFreePack, AgentPack };
