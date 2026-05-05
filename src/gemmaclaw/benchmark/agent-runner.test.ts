import { describe, expect, it } from "vitest";
import { extractTrajectoryError, parseSessionEntry } from "./agent-runner.js";

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
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
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
});

describe("extractTrajectoryError", () => {
  it("extracts promptError from failed session.ended entries", () => {
    expect(
      extractTrajectoryError({
        type: "session.ended",
        data: {
          status: "error",
          promptError: "LLM idle timeout (120s): no response from model",
        },
      }),
    ).toBe("LLM idle timeout (120s): no response from model");
  });

  it("detects terminal trajectory timeout flags", () => {
    expect(
      extractTrajectoryError({
        type: "trace.artifacts",
        data: { finalStatus: "completed", timedOut: true },
      }),
    ).toBe("OpenClaw session timed out");
  });

  it("ignores successful trajectory entries", () => {
    expect(
      extractTrajectoryError({ type: "session.ended", data: { status: "completed" } }),
    ).toBeUndefined();
    expect(extractTrajectoryError({ type: "model.started", data: {} })).toBeUndefined();
  });

  it("ignores passive-retry context overflow (empty assistantTexts and toolMetas)", () => {
    // When the gemmaclaw CLI retries after a full-context session, the retry attempt
    // fails immediately at precheck with no model output.  These should not propagate
    // as task errors — the primary session already completed.
    expect(
      extractTrajectoryError({
        type: "trace.artifacts",
        data: {
          finalStatus: "error",
          promptError: "Context overflow: prompt too large for the model (precheck).",
          promptErrorSource: "precheck",
          assistantTexts: [],
          toolMetas: [],
        },
      }),
    ).toBeUndefined();
  });

  it("reports context overflow when the session did produce output (not a passive retry)", () => {
    expect(
      extractTrajectoryError({
        type: "trace.artifacts",
        data: {
          finalStatus: "error",
          promptError: "Context overflow: prompt too large for the model (precheck).",
          promptErrorSource: "precheck",
          assistantTexts: ["some output"],
          toolMetas: [{ tool: "exec" }],
        },
      }),
    ).toBe("Context overflow: prompt too large for the model (precheck).");
  });
});
