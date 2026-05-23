import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSingleAgentBenchmarkTaskInContainer,
  computeBenchmarkDockerImageTag,
  defaultAgentBenchmarkRunId,
  findBenchmarkRepoRoot,
  isInsideAgentBenchmarkContainer,
  preparePerTaskContainerArgs,
  replaceOutputDirArg,
  selectAgentBenchmarkTaskIds,
} from "./agent-container-guard.js";
import type { AgentBenchmarkTask } from "./agent-tasks.js";
import {
  resolveAgentBenchmarkDockerBuildTimeoutMs,
  resolveAgentBenchmarkTasks,
} from "./cli-standalone.js";

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

  it("computes a unique Docker image tag per repo root to prevent cross-worktree tag collisions", () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "gemmaclaw-root-a-"));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "gemmaclaw-root-b-"));

    const tagA = computeBenchmarkDockerImageTag({ repoRoot: rootA });
    const tagB = computeBenchmarkDockerImageTag({ repoRoot: rootB });

    expect(tagA).toMatch(/^gemmaclaw-benchmark-[0-9a-f]{8}$/);
    expect(tagB).toMatch(/^gemmaclaw-benchmark-[0-9a-f]{8}$/);
    expect(tagA).not.toBe(tagB);

    // Same root always produces the same tag (stable, not random)
    expect(computeBenchmarkDockerImageTag({ repoRoot: rootA })).toBe(tagA);
  });

  it("respects GEMMACLAW_BENCHMARK_DOCKER_IMAGE env override for the image tag", () => {
    const tag = computeBenchmarkDockerImageTag({
      env: { GEMMACLAW_BENCHMARK_DOCKER_IMAGE: "my-custom-image:v1" },
      repoRoot: "/some/root",
    });
    expect(tag).toBe("my-custom-image:v1");
  });

  it("resolves benchmark suite variations without mixing default and expanded suites", () => {
    expect(resolveAgentBenchmarkTasks({}).length).toBe(50);
    expect(resolveAgentBenchmarkTasks({ suite: "default" }).length).toBe(50);
    expect(resolveAgentBenchmarkTasks({ suite: "expanded" }).length).toBe(147);
    expect(resolveAgentBenchmarkTasks({ suite: "variants" }).length).toBe(29400);
    expect(resolveAgentBenchmarkTasks({ suite: "all" }).length).toBe(29597);
    expect(() => resolveAgentBenchmarkTasks({ suite: "missing" })).toThrow(
      /Unsupported agent benchmark suite/,
    );
  });

  it("uses a long docker build timeout with an explicit env override", () => {
    expect(resolveAgentBenchmarkDockerBuildTimeoutMs({})).toBe(45 * 60 * 1000);
    expect(
      resolveAgentBenchmarkDockerBuildTimeoutMs({
        GEMMACLAW_BENCHMARK_DOCKER_BUILD_TIMEOUT_MS: "123456",
      }),
    ).toBe(123456);
    expect(
      resolveAgentBenchmarkDockerBuildTimeoutMs({
        GEMMACLAW_BENCHMARK_DOCKER_BUILD_TIMEOUT_MS: "not-a-number",
      }),
    ).toBe(45 * 60 * 1000);
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

  it("selects expanded variant tasks that exist in the variants suite (regression: unknown-task-in-container)", () => {
    // Regression test for: container built from stale code would fail with
    // "Unknown agent benchmark task: variant_expanded_blog_06" because the
    // expanded variant tasks were not present in old commits. This ensures
    // selectAgentBenchmarkTaskIds accepts the specific tasks that caused the
    // 254-container-failure run on 2026-05-13.
    const variantTasks = resolveAgentBenchmarkTasks({ suite: "variants" });
    const knownExpandedTaskIds = [
      "variant_expanded_blog_06",
      "variant_expanded_blog_12",
      "variant_expanded_email_177",
      "variant_expanded_email_reply_drafting_06",
      "variant_expanded_email_reply_drafting_128",
      "variant_expanded_commit_message_writer_172",
      "variant_expanded_readme_generation_34",
      "variant_expanded_readme_generation_92",
      "variant_expanded_weather_09",
      "variant_expanded_weather_125",
    ];
    for (const taskId of knownExpandedTaskIds) {
      expect(
        () => selectAgentBenchmarkTaskIds(variantTasks, { task: taskId }),
        `task ${taskId} should be selectable without throwing`,
      ).not.toThrow();
    }
  });

  it("selects the same 294 tasks from gemini-flash-pressurefix-smoke-20260513 seed as the failed run", () => {
    // Verifies that the sample selection for the reference run is deterministic
    // and that all 294 selected tasks can be resolved by selectAgentBenchmarkTaskIds
    // (regression: prior run selected 294 tasks on host but container couldn't resolve them).
    const variantTasks = resolveAgentBenchmarkTasks({ suite: "variants" });
    const selected = selectAgentBenchmarkTaskIds(variantTasks, {
      samplePerTemplate: "2",
      sampleSeed: "gemini-flash-pressurefix-smoke-20260513",
    });
    expect(selected).toHaveLength(294);
    // All selected IDs must be present in the full variants suite
    const variantTaskIds = new Set(variantTasks.map((t) => t.id));
    for (const taskId of selected) {
      expect(
        variantTaskIds.has(taskId),
        `selected task ${taskId} must exist in variants suite`,
      ).toBe(true);
    }
  });
});
