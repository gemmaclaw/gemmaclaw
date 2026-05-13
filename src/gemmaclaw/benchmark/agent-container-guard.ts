import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentBenchmarkTask } from "./agent-tasks.js";

export const AGENT_BENCHMARK_DOCKER_IMAGE =
  process.env.GEMMACLAW_BENCHMARK_DOCKER_IMAGE?.trim() || "gemmaclaw-benchmark";
export const AGENT_BENCHMARK_CONTAINER_ENV = "GEMMACLAW_BENCHMARK_CONTAINER";
export const AGENT_BENCHMARK_MULTI_TASK_CONTAINER_ENV =
  "GEMMACLAW_BENCHMARK_ALLOW_MULTI_TASK_CONTAINER";

export function isInsideAgentBenchmarkContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_BENCHMARK_CONTAINER_ENV] === "1";
}

export function findBenchmarkRepoRoot(startDir = process.cwd()): string {
  let dir = path.resolve(startDir);
  while (dir !== "/") {
    if (fs.existsSync(path.join(dir, "Dockerfile.benchmark"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(startDir);
}

export function replaceOutputDirArg(args: string[], outputDir: string): string[] {
  const rewritten: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output-dir") {
      i++;
      continue;
    }
    rewritten.push(args[i]);
  }
  rewritten.push("--output-dir", outputDir);
  return rewritten;
}

function stripOptionWithValue(args: string[], option: string): string[] {
  const rewritten: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === option) {
      i++;
      continue;
    }
    rewritten.push(args[i]);
  }
  return rewritten;
}

function stripFlag(args: string[], flag: string): string[] {
  return args.filter((arg) => arg !== flag);
}

export function selectAgentBenchmarkTaskIds(
  tasks: AgentBenchmarkTask[],
  opts: Record<string, string | boolean>,
): string[] {
  if (opts.task) {
    const taskId = String(opts.task);
    if (!tasks.some((task) => task.id === taskId)) {
      throw new Error(`Unknown agent benchmark task: ${taskId}`);
    }
    return [taskId];
  }

  let selectedTasks = tasks;

  if (opts.filter) {
    const filter = String(opts.filter).toLowerCase();
    selectedTasks = tasks.filter(
      (task) =>
        task.id.toLowerCase().includes(filter) ||
        task.name.toLowerCase().includes(filter) ||
        task.category.toLowerCase().includes(filter) ||
        task.difficulty.toLowerCase().includes(filter),
    );
    if (selectedTasks.length === 0) {
      throw new Error(`No agent benchmark tasks match filter: ${opts.filter}`);
    }
  }

  if (opts.samplePerTemplate) {
    const sampleSize = Number.parseInt(String(opts.samplePerTemplate), 10);
    if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
      throw new Error(
        `--sample-per-template must be a positive integer, got: ${opts.samplePerTemplate}`,
      );
    }
    const seed = String(opts.sampleSeed ?? "gemmaclaw-benchmark-sample");
    const grouped = new Map<string, AgentBenchmarkTask[]>();
    for (const task of selectedTasks) {
      const templateId = variationTemplateId(task.id);
      grouped.set(templateId, [...(grouped.get(templateId) ?? []), task]);
    }
    selectedTasks = [...grouped.values()].flatMap((group) =>
      seededSample(group, Math.min(sampleSize, group.length), seed),
    );
  }

  return selectedTasks.map((task) => task.id);
}

function variationTemplateId(taskId: string): string {
  return taskId.replace(/^variant_/, "").replace(/_\d{2,3}$/, "");
}

function seededSample<T extends { id: string }>(items: T[], count: number, seed: string): T[] {
  return items
    .map((item) => ({
      item,
      score: crypto.createHash("sha256").update(`${seed}:${item.id}`).digest("hex"),
    }))
    .toSorted((a, b) => a.score.localeCompare(b.score))
    .slice(0, count)
    .map(({ item }) => item)
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

export function assertSingleAgentBenchmarkTaskInContainer(params: {
  taskIds: string[];
  env?: NodeJS.ProcessEnv;
}): void {
  const env = params.env ?? process.env;
  if (env[AGENT_BENCHMARK_MULTI_TASK_CONTAINER_ENV] === "1") {
    return;
  }
  if (params.taskIds.length > 1) {
    throw new Error(
      "Refusing to run multiple real agent benchmark tasks in one container. " +
        "Run `pnpm benchmark agent ...` from the host so the CLI starts one fresh Docker container per task, " +
        `or set ${AGENT_BENCHMARK_MULTI_TASK_CONTAINER_ENV}=1 only for an intentional debugging override.`,
    );
  }
}

export function defaultAgentBenchmarkRunId(opts: Record<string, string | boolean>): string {
  if (opts.runId) {
    return String(opts.runId);
  }
  const model = String(opts.model ?? "auto").replace(/[^a-zA-Z0-9_.-]+/g, "-");
  const thinking = String(opts.thinking ?? "default").replace(/[^a-zA-Z0-9_.-]+/g, "-");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${model}-${thinking}-${stamp}-${suffix}`;
}

export function preparePerTaskContainerArgs(
  args: string[],
  params: {
    taskId: string;
    runId: string;
    outputDir: string;
  },
): string[] {
  let rewritten = replaceOutputDirArg(args, params.outputDir);
  rewritten = stripOptionWithValue(rewritten, "--task");
  rewritten = stripOptionWithValue(rewritten, "--filter");
  rewritten = stripOptionWithValue(rewritten, "--run-id");
  rewritten = stripFlag(rewritten, "--assemble");
  rewritten = stripFlag(rewritten, "--evaluate");
  rewritten.push("--task", params.taskId, "--run-id", params.runId);
  return rewritten;
}
