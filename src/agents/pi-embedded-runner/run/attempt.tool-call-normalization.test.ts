import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  sanitizeReplayToolCallIdsForStream,
  wrapStreamParseGemma4ToolCalls,
} from "./attempt.tool-call-normalization.js";

describe("sanitizeReplayToolCallIdsForStream", () => {
  it("drops orphaned tool results after strict id sanitization", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_function_av7cbkigmk7x1",
        toolUseId: "call_function_av7cbkigmk7x1",
        toolName: "read",
        content: [{ type: "text", text: "stale" }],
        isError: false,
      } as never,
    ];

    expect(
      sanitizeReplayToolCallIdsForStream({
        messages,
        mode: "strict",
        repairToolUseResultPairing: true,
      }),
    ).toEqual([]);
  });

  it("keeps matched assistant and tool-result ids aligned", () => {
    const rawId = "call_function_av7cbkigmk7x1";
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: rawId, name: "read", input: { path: "." } }],
      } as never,
      {
        role: "toolResult",
        toolCallId: rawId,
        toolUseId: rawId,
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as never,
    ];

    const out = sanitizeReplayToolCallIdsForStream({
      messages,
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "callfunctionav7cbkigmk7x1", name: "read" }],
      },
      {
        role: "toolResult",
        toolCallId: "callfunctionav7cbkigmk7x1",
        toolUseId: "callfunctionav7cbkigmk7x1",
        toolName: "read",
      },
    ]);
  });

  it("keeps real tool results for aborted assistant spans", () => {
    const rawId = "call_function_av7cbkigmk7x1";
    const out = sanitizeReplayToolCallIdsForStream({
      messages: [
        {
          role: "assistant",
          stopReason: "aborted",
          content: [{ type: "toolUse", id: rawId, name: "read", input: { path: "." } }],
        } as never,
        {
          role: "toolResult",
          toolCallId: rawId,
          toolUseId: rawId,
          toolName: "read",
          content: [{ type: "text", text: "partial" }],
          isError: false,
        } as never,
        {
          role: "user",
          content: [{ type: "text", text: "retry" }],
        } as never,
      ],
      mode: "strict",
      repairToolUseResultPairing: true,
    });

    expect(out).toMatchObject([
      {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "toolUse", id: "callfunctionav7cbkigmk7x1", name: "read" }],
      },
      {
        role: "toolResult",
        toolCallId: "callfunctionav7cbkigmk7x1",
        toolUseId: "callfunctionav7cbkigmk7x1",
        toolName: "read",
      },
      {
        role: "user",
      },
    ]);
  });
});

describe("wrapStreamParseGemma4ToolCalls", () => {
  async function runStream(deltas: string[]) {
    const partial: any = { content: [{ type: "text", text: "" }] };
    
    const rawEvents = deltas.map((delta) => ({
      type: "text_delta" as const,
      delta,
      contentIndex: 0,
      partial,
    }));
    
    let eventIndex = 0;
    const mockIterator = {
      next: async () => {
        if (eventIndex < rawEvents.length) {
          const val = rawEvents[eventIndex++];
          if (partial.content[0].type === "text") {
            partial.content[0].text += val.delta;
          }
          return { done: false, value: val };
        }
        return { done: true, value: undefined };
      },
    };
    
    const mockStream: any = {
      [Symbol.asyncIterator]: () => mockIterator,
      result: async () => {
        return {
          content: partial.content,
        };
      },
    };
    
    const wrappedStream = wrapStreamParseGemma4ToolCalls(mockStream);
    const yieldedEvents: any[] = [];
    for await (const event of wrappedStream) {
      yieldedEvents.push(event);
    }
    const finalMessage = await wrappedStream.result();
    
    return { yieldedEvents, finalMessage };
  }

  it("parses standard tool call with prefix and suffix", async () => {
    const { yieldedEvents, finalMessage } = await runStream([
      "Hello, I will run a tool. ",
      "<|tool_call>",
      "call:sessions_spawn{mode:\"session\"}",
      "<tool_call|>",
      " Tool started.",
    ]);
    
    expect(yieldedEvents.map((e) => e.type)).toEqual([
      "text_delta",
      "toolcall_start",
      "toolcall_end",
      "text_delta",
    ]);
    
    expect(yieldedEvents[0].delta).toBe("Hello, I will run a tool. ");
    expect(yieldedEvents[1].type).toBe("toolcall_start");
    expect(yieldedEvents[2].toolCall.name).toBe("sessions_spawn");
    expect(yieldedEvents[2].toolCall.arguments).toEqual({ mode: "session" });
    expect(yieldedEvents[3].delta).toBe(" Tool started.");
    
    expect(finalMessage.content).toMatchObject([
      { type: "text", text: "Hello, I will run a tool.  Tool started." },
      { type: "toolCall", name: "sessions_spawn", arguments: { mode: "session" } },
    ]);
  });

  it("parses fallback tool call without prefix", async () => {
    const { yieldedEvents, finalMessage } = await runStream([
      "Hello, I will run a tool. ",
      "call:sessions_spawn{mode:\"session\"}",
      "<tool_call|>",
      " Tool started.",
    ]);
    
    expect(yieldedEvents.map((e) => e.type)).toEqual([
      "text_delta",
      "toolcall_start",
      "toolcall_end",
      "text_delta",
    ]);
    
    expect(yieldedEvents[0].delta).toBe("Hello, I will run a tool. ");
    expect(yieldedEvents[2].toolCall.name).toBe("sessions_spawn");
    expect(yieldedEvents[2].toolCall.arguments).toEqual({ mode: "session" });
    expect(yieldedEvents[3].delta).toBe(" Tool started.");
    
    expect(finalMessage.content).toMatchObject([
      { type: "text", text: "Hello, I will run a tool.  Tool started." },
      { type: "toolCall", name: "sessions_spawn", arguments: { mode: "session" } },
    ]);
  });
});
