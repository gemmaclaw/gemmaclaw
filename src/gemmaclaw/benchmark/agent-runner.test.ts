import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assembleAgentBenchmarkRun,
  clearTaskStartedMarker,
  computeConfigHash,
  extractAssistantResponseFromStdout,
  isAgentBackendType,
  loadTaskArtifacts,
  parseSessionEntry,
  readTaskStartedMarker,
  resolveAgentProviderPrefix,
  resolveCodexHome,
  resolveFakeGogBinDir,
  readOpenAICodexAuthProfilesFromStore,
  resolveOpenAICodexAuthProfileStoreCandidates,
  resolveTimeoutBudgets,
  runAgentBenchmark,
  writeTaskArtifact,
  writeBenchmarkWorkspaceFiles,
  writeTaskStartedMarker,
  type AgentBenchmarkConfig,
  type AgentTaskResult,
  type RunMetadata,
  type TaskStartedMarker,
} from "./agent-runner.js";
import type { AgentBenchmarkTask } from "./agent-tasks.js";

describe("parseSessionEntry", () => {
  it("parses Anthropic-style assistant tool_use blocks", () => {
    const entry = {
      type: "message",
      timestamp: "2026-05-02T06:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Calling tool" },
          { type: "tool_use", name: "read", input: { path: "/tmp/foo" } },
        ],
      },
    };
    const turns = parseSessionEntry(entry);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "assistant", content: "Calling tool" });
    expect(turns[1]).toMatchObject({
      role: "tool_call",
      toolName: "read",
      toolArgs: { path: "/tmp/foo" },
    });
  });

  it("parses OpenClaw-style assistant toolCall blocks", () => {
    const entry = {
      type: "message",
      timestamp: "2026-05-02T06:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I need to read..." },
          {
            type: "toolCall",
            id: "ollama_call_xyz",
            name: "exec",
            arguments: { command: "gog gmail messages search 'in:inbox'" },
          },
        ],
      },
    };
    const turns = parseSessionEntry(entry);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "thinking", content: "I need to read..." });
    expect(turns[1]).toMatchObject({
      role: "tool_call",
      toolName: "exec",
      toolArgs: { command: "gog gmail messages search 'in:inbox'" },
    });
  });

  it("parses OpenClaw top-level role=toolResult messages", () => {
    const entry = {
      type: "message",
      timestamp: "2026-05-02T06:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "ollama_call_xyz",
        toolName: "exec",
        content: [{ type: "text", text: "stdout: 5 emails" }],
      },
    };
    const turns = parseSessionEntry(entry);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: "tool_result", content: "stdout: 5 emails" });
  });

  it("parses Anthropic-style tool_result blocks inside assistant messages", () => {
    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "tool_result", content: "tool output" }],
      },
    };
    const turns = parseSessionEntry(entry);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: "tool_result", content: "tool output" });
  });

  it("parses user messages from string and array content", () => {
    const stringEntry = { message: { role: "user", content: "hello" } };
    const arrayEntry = {
      message: {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    };
    expect(parseSessionEntry(stringEntry)).toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
    ]);
    expect(parseSessionEntry(arrayEntry)).toEqual([
      expect.objectContaining({ role: "user", content: "first\nsecond" }),
    ]);
  });

  it("returns empty array for non-message entries", () => {
    expect(parseSessionEntry({ type: "model_change", modelId: "gemma4:e4b" })).toEqual([]);
    expect(parseSessionEntry({ type: "session", id: "abc" })).toEqual([]);
    expect(parseSessionEntry(null)).toEqual([]);
  });

  it("counts multi-tool assistant message correctly (regression for e4b run)", () => {
    // Mimics what e4b memory_log produced: thinking + multiple toolCall blocks.
    const entry = {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "..." },
          { type: "toolCall", name: "session_status", arguments: {} },
          { type: "toolCall", name: "web_search", arguments: { query: "today" } },
          { type: "toolCall", name: "write", arguments: { path: "memory/x.md" } },
        ],
      },
    };
    const turns = parseSessionEntry(entry);
    const calls = turns.filter((t) => t.role === "tool_call");
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.toolName)).toEqual(["session_status", "web_search", "write"]);
  });

  it("extracts a stdout-only assistant response after plugin startup logs", () => {
    const stdout = [
      "[plugins] openai installed bundled runtime deps: ws@^8.20.0",
      "[plugins] ollama installed bundled runtime deps: @mariozechner/pi-ai@0.69.0",
      '{"person":"Maya Chen","date":"2026-05-08"}',
    ].join("\n");

    expect(extractAssistantResponseFromStdout(stdout)).toBe(
      '{"person":"Maya Chen","date":"2026-05-08"}',
    );
  });
});

describe("resolveTimeoutBudgets", () => {
  const base = {
    gatewayUrl: "http://localhost:3001",
    backend: "ollama" as const,
    ollamaUrl: "http://127.0.0.1:11434",
    llamaCppUrl: "http://127.0.0.1:8080",
    model: "gemma4:31b",
    quant: "Q4_K_M",
    thinkingLevel: "high",
    taskTimeoutSeconds: 0,
    idleTimeoutSeconds: 30,
  };

  it("defaults activity timeout to 600s and hard cap to 28800s when nothing is set", () => {
    const { hardCapMs, noActivityMs } = resolveTimeoutBudgets(base);
    expect(noActivityMs).toBe(600_000);
    expect(hardCapMs).toBe(28_800_000);
  });

  it("treats legacy taskTimeoutSeconds as a floor for the hard cap", () => {
    const { hardCapMs } = resolveTimeoutBudgets({ ...base, taskTimeoutSeconds: 3600 });
    expect(hardCapMs).toBe(28_800_000);
    const { hardCapMs: bigCap } = resolveTimeoutBudgets({ ...base, taskTimeoutSeconds: 50_000 });
    expect(bigCap).toBe(50_000_000);
  });

  it("respects explicit hardCapSeconds and noActivityTimeoutSeconds", () => {
    const { hardCapMs, noActivityMs } = resolveTimeoutBudgets({
      ...base,
      hardCapSeconds: 7200,
      noActivityTimeoutSeconds: 300,
    });
    expect(hardCapMs).toBe(7_200_000);
    expect(noActivityMs).toBe(300_000);
  });

  it("falls back to defaults when explicit timeouts are <=0", () => {
    const { hardCapMs, noActivityMs } = resolveTimeoutBudgets({
      ...base,
      hardCapSeconds: 0,
      noActivityTimeoutSeconds: -1,
    });
    expect(noActivityMs).toBe(600_000);
    expect(hardCapMs).toBe(28_800_000);
  });
});

describe("benchmark backend resolution", () => {
  it("maps agent benchmark backends to OpenClaw provider prefixes", () => {
    expect(resolveAgentProviderPrefix("ollama")).toBe("ollama");
    expect(resolveAgentProviderPrefix("llama-cpp")).toBe("openai");
    expect(resolveAgentProviderPrefix("openai-codex")).toBe("openai-codex");
  });

  it("validates supported benchmark backend names", () => {
    expect(isAgentBackendType("ollama")).toBe(true);
    expect(isAgentBackendType("llama-cpp")).toBe(true);
    expect(isAgentBackendType("openai-codex")).toBe(true);
    expect(isAgentBackendType("openai")).toBe(false);
  });

  it("resolves the benchmark fake gog directory from the repository root", () => {
    expect(resolveFakeGogBinDir("/repo")).toBe(path.join("/repo", "scripts/benchmark/fake-gog"));
  });

  it("uses CODEX_HOME when present for Codex OAuth lookup", () => {
    expect(resolveCodexHome({ CODEX_HOME: "/tmp/codex-home" })).toBe("/tmp/codex-home");
    expect(resolveCodexHome({ CODEX_HOME: "  " })).toContain(".codex");
  });

  it("allows explicit openai-codex auth profile stores for isolated benchmarks", () => {
    expect(
      resolveOpenAICodexAuthProfileStoreCandidates({
        GEMMACLAW_BENCH_OPENAI_CODEX_AUTH_PROFILES: "/tmp/auth-profiles.json",
      }),
    ).toEqual(["/tmp/auth-profiles.json"]);
  });

  it("copies only openai-codex auth profiles into isolated benchmark homes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemmaclaw-codex-auth-"));
    const storePath = path.join(dir, "auth-profiles.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "access",
            refresh: "refresh",
          },
          "ollama:default": { type: "token", provider: "ollama", token: "dummy" },
        },
      }),
    );

    expect(readOpenAICodexAuthProfilesFromStore(storePath)).toEqual({
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access: "access",
        refresh: "refresh",
      },
    });
  });

  it("writes neutral benchmark workspace context files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemmaclaw-workspace-context-"));

    writeBenchmarkWorkspaceFiles(dir);

    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toContain(
      "isolated benchmark workspace",
    );
    expect(fs.readFileSync(path.join(dir, "TOOLS.md"), "utf-8")).toContain("fake gog");
    expect(fs.readFileSync(path.join(dir, "IDENTITY.md"), "utf-8")).toContain(
      "benchmark assistant",
    );
    expect(fs.existsSync(path.join(dir, "memory"))).toBe(true);
  });
});

describe("per-task benchmark artifacts", () => {
  function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "gemmaclaw-agent-artifacts-"));
  }

  const task: AgentBenchmarkTask = {
    id: "email_summarize",
    name: "Email Inbox Summary",
    description: "Summarize inbox",
    category: "email",
    difficulty: "medium",
    prompt: "Check my inbox",
    grading: {
      type: "conversation_check",
      criteria: ["reads inbox"],
      maxScore: 10,
    },
  };

  const secondTask: AgentBenchmarkTask = {
    ...task,
    id: "calendar_summary",
    name: "Calendar Summary",
    category: "calendar",
    prompt: "Summarize my calendar",
  };

  const config: AgentBenchmarkConfig = {
    gatewayUrl: "http://localhost:3001",
    backend: "ollama",
    ollamaUrl: "http://127.0.0.1:11434",
    llamaCppUrl: "http://127.0.0.1:8080",
    model: "gemma4-31b-q4",
    quant: "Q4_K_M",
    thinkingLevel: "high",
    taskTimeoutSeconds: 7200,
    idleTimeoutSeconds: 3600,
    mock: true,
    runId: "q4-smoke",
  };

  const hardware = {
    cpu: { arch: "x64", cores: 16, model: "test cpu" },
    ram: { totalBytes: 32 * 1024 ** 3, availableBytes: 16 * 1024 ** 3 },
    gpu: {
      detected: true,
      nvidia: true,
      apple: false,
      name: "test gpu",
      vramBytes: 24 * 1024 ** 3,
    },
  };

  const result: AgentTaskResult = {
    task,
    conversation: [
      { role: "user", content: "Check my inbox" },
      { role: "assistant", content: "I will check it." },
      { role: "tool_call", toolName: "gog", toolArgs: { cmd: "gmail list" }, content: "{}" },
      { role: "tool_result", content: "3 emails" },
      { role: "assistant", content: "You have 3 emails." },
    ],
    elapsedMs: 1234,
    toolCallCount: 1,
    toolsUsed: ["gog"],
    completionStatus: "completed",
  };

  it("writes, reads, and clears a task started.json marker", () => {
    const runDir = tempDir();
    const configHash = computeConfigHash(config);
    const marker: TaskStartedMarker = {
      schemaVersion: 1,
      taskId: "email_summarize",
      taskName: "Email Inbox Summary",
      runId: "q4-smoke",
      configHash,
      sessionId: "bench-email_summarize-12345",
      attempt: 1,
      startedAt: "2026-05-10T15:39:00.000Z",
      pid: 4242,
    };

    expect(readTaskStartedMarker(runDir, "email_summarize")).toBeUndefined();
    writeTaskStartedMarker(runDir, marker);

    const markerPath = path.join(runDir, "tasks/email_summarize/started.json");
    expect(fs.existsSync(markerPath)).toBe(true);
    const reloaded = readTaskStartedMarker(runDir, "email_summarize");
    expect(reloaded).toEqual(marker);

    clearTaskStartedMarker(runDir, "email_summarize");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(readTaskStartedMarker(runDir, "email_summarize")).toBeUndefined();
    // Clear is idempotent so a runner that never wrote a marker (or already
    // cleared it) doesn't crash.
    expect(() => clearTaskStartedMarker(runDir, "email_summarize")).not.toThrow();
  });

  it("clears the started marker once a final result.json is written by the run loop", async () => {
    const outputDir = tempDir();
    const runDir = path.join(outputDir, "runs", "q4-smoke");
    const parentConfig = { ...config, outputDir, runId: "q4-smoke", mock: true };

    await runAgentBenchmark([task], parentConfig, hardware);

    expect(fs.existsSync(path.join(runDir, "tasks/email_summarize/result.json"))).toBe(true);
    // After a clean mock run the started marker must be cleared so a future
    // audit can distinguish "ran to completion" from "killed mid-flight".
    expect(fs.existsSync(path.join(runDir, "tasks/email_summarize/started.json"))).toBe(false);
    const taskArtifact = JSON.parse(
      fs.readFileSync(path.join(runDir, "tasks/email_summarize/result.json"), "utf-8"),
    ) as { result: AgentTaskResult };
    const taskResult = taskArtifact.result;
    expect(taskResult.qualityInspection?.schemaVersion).toBe(1);
    expect(taskResult.qualityInspection?.issues.map((issue) => issue.kind)).toContain(
      "llm_judge_missing",
    );
  });

  it("preserves a leftover started.json when writeTaskArtifact never runs (silent kill semantics)", () => {
    // Simulate the failure mode that motivated the marker: dispatch is killed
    // mid-flight before result.json lands. The marker we wrote at task start
    // must remain on disk as positive evidence that the attempt happened.
    const runDir = tempDir();
    const configHash = computeConfigHash(config);
    const marker: TaskStartedMarker = {
      schemaVersion: 1,
      taskId: "context_memory_chain",
      taskName: "Context and Memory Chain",
      runId: "q4-smoke",
      configHash,
      sessionId: "bench-context_memory_chain-99999",
      attempt: 1,
      startedAt: "2026-05-10T15:39:27.000Z",
      pid: 3914806,
    };

    writeTaskStartedMarker(runDir, marker);
    // No writeTaskArtifact, no clear: the runner died after writing started
    // and before producing a result.
    const startedPath = path.join(runDir, "tasks/context_memory_chain/started.json");
    expect(fs.existsSync(startedPath)).toBe(true);
    expect(fs.existsSync(path.join(runDir, "tasks/context_memory_chain/result.json"))).toBe(false);
    const reloaded = readTaskStartedMarker(runDir, "context_memory_chain");
    expect(reloaded?.sessionId).toBe("bench-context_memory_chain-99999");
    expect(reloaded?.pid).toBe(3914806);
  });

  it("saves and reloads an individual task result with transcript", () => {
    const runDir = tempDir();
    const configHash = computeConfigHash(config);

    writeTaskArtifact(runDir, "q4-smoke", configHash, result);

    expect(fs.existsSync(path.join(runDir, "tasks/email_summarize/result.json"))).toBe(true);
    expect(
      fs.readFileSync(path.join(runDir, "tasks/email_summarize/transcript.txt"), "utf-8"),
    ).toContain("[tool_call] gog {}");
    expect(loadTaskArtifacts(runDir, configHash)).toMatchObject([
      { task: { id: "email_summarize" }, completionStatus: "completed" },
    ]);
    expect(loadTaskArtifacts(runDir, "wrong-hash")).toEqual([]);
  });

  it("includes activity-timeout fields in the config hash so different gates produce different hashes", () => {
    const baseHash = computeConfigHash(config);
    const withActivity = computeConfigHash({ ...config, noActivityTimeoutSeconds: 600 });
    const withHardCap = computeConfigHash({ ...config, hardCapSeconds: 28_800 });
    const withValidationOff = computeConfigHash({ ...config, validatePerTask: false });
    const withQualityInspectionOff = computeConfigHash({
      ...config,
      qualityInspectPerTask: false,
    });
    expect(baseHash).not.toBe(withActivity);
    expect(baseHash).not.toBe(withHardCap);
    expect(baseHash).not.toBe(withValidationOff);
    expect(baseHash).not.toBe(withQualityInspectionOff);
  });

  it("assembles aggregate outputs from saved per-task artifacts", () => {
    const outputDir = tempDir();
    const runDir = path.join(outputDir, "runs", "q4-smoke");
    const metadata: RunMetadata = {
      model: config.model,
      quant: config.quant,
      thinkingLevel: config.thinkingLevel,
      hardware,
      gatewayUrl: config.gatewayUrl,
      ollamaUrl: config.ollamaUrl,
      startedAt: "2026-05-07T10:00:00.000Z",
    };
    const configHash = computeConfigHash({ ...config, outputDir });
    writeTaskArtifact(runDir, "q4-smoke", configHash, result);
    fs.writeFileSync(
      path.join(runDir, "manifest.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          runId: "q4-smoke",
          configHash,
          config: { ...config, outputDir },
          metadata,
          taskIds: [task.id],
          createdAt: metadata.startedAt,
          updatedAt: metadata.startedAt,
        },
        null,
        2,
      ),
    );

    const assembled = assembleAgentBenchmarkRun([task], { ...config, outputDir }, outputDir);

    expect(assembled.summary.completedCount).toBe(1);
    expect(fs.existsSync(path.join(runDir, "results.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "RESULTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "evaluations/q4-smoke/email_summarize.json"))).toBe(
      true,
    );
  });

  it("lets per-task container slices share the parent artifact hash and manifest", async () => {
    const outputDir = tempDir();
    const runDir = path.join(outputDir, "runs", "q4-smoke");
    const sharedHash = "legacy-clean-hash";
    const parentConfig = { ...config, outputDir, runId: "q4-smoke", mock: true };
    writeTaskArtifact(runDir, "q4-smoke", sharedHash, result);

    await runAgentBenchmark(
      [secondTask],
      {
        ...parentConfig,
        filter: secondTask.id,
        artifactConfigHash: sharedHash,
        manifestConfig: parentConfig,
        manifestTaskIds: [task.id, secondTask.id],
      },
      hardware,
    );

    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf-8")) as {
      configHash: string;
      taskIds: string[];
      config: AgentBenchmarkConfig;
    };
    expect(manifest.configHash).toBe(sharedHash);
    expect(manifest.taskIds).toEqual([task.id, secondTask.id]);
    expect(manifest.config.filter).toBeUndefined();
    expect(
      loadTaskArtifacts(runDir, sharedHash)
        .map((entry) => entry.task.id)
        .toSorted(),
    ).toEqual([task.id, secondTask.id].toSorted());

    const assembled = assembleAgentBenchmarkRun(
      [task, secondTask],
      { ...parentConfig, runId: "q4-smoke" },
      outputDir,
    );
    expect(assembled.tasks.map((entry) => entry.task.id)).toEqual([task.id, secondTask.id]);
  });
});
