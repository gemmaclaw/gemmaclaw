import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assembleAgentBenchmarkRun,
  computeConfigHash,
  extractAssistantResponseFromStdout,
  loadTaskArtifacts,
  parseSessionEntry,
  writeTaskArtifact,
  type AgentBenchmarkConfig,
  type AgentTaskResult,
  type RunMetadata,
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

  it("assembles aggregate outputs from saved per-task artifacts", () => {
    const outputDir = tempDir();
    const runDir = path.join(outputDir, "runs", "q4-smoke");
    const metadata: RunMetadata = {
      model: config.model,
      quant: config.quant,
      thinkingLevel: config.thinkingLevel,
      hardware: {
        cpu: { arch: "x64", cores: 16, model: "test cpu" },
        ram: { totalBytes: 32 * 1024 ** 3, availableBytes: 16 * 1024 ** 3 },
        gpu: {
          detected: true,
          nvidia: true,
          apple: false,
          name: "test gpu",
          vramBytes: 24 * 1024 ** 3,
        },
      },
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
});
