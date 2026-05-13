import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSingleAgentBenchmarkTaskInContainer,
  defaultAgentBenchmarkRunId,
  findBenchmarkRepoRoot,
  isInsideAgentBenchmarkContainer,
  preparePerTaskContainerArgs,
  replaceOutputDirArg,
  selectAgentBenchmarkTaskIds,
} from "./agent-container-guard.js";
import type { AgentBenchmarkTask } from "./agent-tasks.js";
import { resolveAgentBenchmarkTasks } from "./cli-standalone.js";

describe("agent benchmark container guard", () => {
  it("detects the benchmark container marker only when explicitly set", () => {
    expect(isInsideAgentBenchmarkContainer({ GEMMACLAW_BENCHMARK_CONTAINER: "1" })).toBe(true);
    expect(isInsideAgentBenchmarkContainer({ GEMMACLAW_BENCHMARK_CONTAINER: "0" })).toBe(false);
    expect(isInsideAgentBenchmarkContainer({})).toBe(false);
  });

  it("rewrites output-dir to the container mount", () => {
    expect(
      replaceOutputDirArg(
        [
          "agent",
          "--model",
          "gemma4:31b",
          "--output-dir",
          "/host/results",
          "--task",
          "email_triage",
        ],
        "/results",
      ),
    ).toEqual([
      "agent",
      "--model",
      "gemma4:31b",
      "--task",
      "email_triage",
      "--output-dir",
      "/results",
    ]);
  });

  it("prepares one-container-per-task arguments with stable host run id", () => {
    expect(
      preparePerTaskContainerArgs(
        [
          "agent",
          "--model",
          "gemma4:31b",
          "--filter",
          "email",
          "--output-dir",
          "/host/results",
          "--run-id",
          "old",
        ],
        { taskId: "email_triage", runId: "q4-run", outputDir: "/results" },
      ),
    ).toEqual([
      "agent",
      "--model",
      "gemma4:31b",
      "--output-dir",
      "/results",
      "--task",
      "email_triage",
      "--run-id",
      "q4-run",
    ]);
  });

  it("selects exact tasks or filtered task sets for per-task containers", () => {
    const tasks = [
      { id: "email_triage", name: "Email Triage", category: "email", difficulty: "medium" },
      { id: "calendar_create", name: "Calendar Create", category: "calendar", difficulty: "easy" },
    ] as AgentBenchmarkTask[];

    expect(selectAgentBenchmarkTaskIds(tasks, { task: "calendar_create" })).toEqual([
      "calendar_create",
    ]);
    expect(selectAgentBenchmarkTaskIds(tasks, { filter: "email" })).toEqual(["email_triage"]);
    expect(() => selectAgentBenchmarkTaskIds(tasks, { task: "missing" })).toThrow(/Unknown/);
  });

  it("refuses multiple real tasks in one container unless explicitly overridden", () => {
    expect(() =>
      assertSingleAgentBenchmarkTaskInContainer({
        taskIds: ["email_triage", "calendar_create"],
        env: {},
      }),
    ).toThrow(/multiple real agent benchmark tasks/);

    expect(() =>
      assertSingleAgentBenchmarkTaskInContainer({
        taskIds: ["email_triage"],
        env: {},
      }),
    ).not.toThrow();

    expect(() =>
      assertSingleAgentBenchmarkTaskInContainer({
        taskIds: ["email_triage", "calendar_create"],
        env: { GEMMACLAW_BENCHMARK_ALLOW_MULTI_TASK_CONTAINER: "1" },
      }),
    ).not.toThrow();
  });

  it("keeps a provided run id and generates a usable default otherwise", () => {
    expect(defaultAgentBenchmarkRunId({ runId: "provided" })).toBe("provided");
    expect(defaultAgentBenchmarkRunId({ model: "gemma4:31b", thinking: "high" })).toMatch(
      /^gemma4-31b-high-\d{4}-\d{2}-\d{2}T/,
    );
  });

  it("finds the repository root containing Dockerfile.benchmark", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemmaclaw-bench-root-"));
    const nested = path.join(root, "src", "gemmaclaw", "benchmark");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, "Dockerfile.benchmark"), "FROM scratch\n");
    expect(findBenchmarkRepoRoot(nested)).toBe(root);
  });

  it("resolves benchmark suite variations without mixing default and expanded suites", () => {
    expect(resolveAgentBenchmarkTasks({}).length).toBe(47);
    expect(resolveAgentBenchmarkTasks({ suite: "default" }).length).toBe(47);
    expect(resolveAgentBenchmarkTasks({ suite: "expanded" }).length).toBe(147);
    expect(resolveAgentBenchmarkTasks({ suite: "variants" }).length).toBe(29400);
    expect(resolveAgentBenchmarkTasks({ suite: "all" }).length).toBe(29594);
    expect(() => resolveAgentBenchmarkTasks({ suite: "missing" })).toThrow(
      /Unsupported agent benchmark suite/,
    );
  });

  it("samples generated variations per template with a stable seed", () => {
    const tasks = resolveAgentBenchmarkTasks({ suite: "variants" });
    const first = selectAgentBenchmarkTaskIds(tasks, {
      samplePerTemplate: "10",
      sampleSeed: "ci-sample",
    });
    const second = selectAgentBenchmarkTaskIds(tasks, {
      samplePerTemplate: "10",
      sampleSeed: "ci-sample",
    });
    expect(first).toHaveLength(1470);
    expect(second).toEqual(first);
    expect(
      new Set(first.map((id) => id.replace(/^variant_/, "").replace(/_\d{2,3}$/, ""))).size,
    ).toBe(147);
  });
});
