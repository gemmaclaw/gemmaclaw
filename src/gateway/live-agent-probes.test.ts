import { describe, expect, it, vi } from "vitest";
import {
  assertCronJobMatches,
  assertLiveImageProbeReply,
  buildLiveCronProbeMessage,
  createLiveCronProbeSpec,
  normalizeLiveAgentFamily,
} from "./live-agent-probes.js";

describe("live-agent-probes", () => {
  it("normalizes cli backend ids into live agent families", () => {
    expect(normalizeLiveAgentFamily("claude-cli")).toBe("claude");
    expect(normalizeLiveAgentFamily("codex")).toBe("codex");
    expect(normalizeLiveAgentFamily("google-gemini-cli")).toBe("gemini");
  });

  it("accepts only cat for the shared image probe reply", () => {
    expect(() => assertLiveImageProbeReply("cat")).not.toThrow();
    expect(() => assertLiveImageProbeReply("horse")).toThrow("image probe expected 'cat'");
  });

  it("builds a retryable cron prompt with provider-specific fallback wording", () => {
    const spec = createLiveCronProbeSpec({
      agentId: "codex",
      sessionKey: "agent:codex:acp:test",
    });
    expect(
      buildLiveCronProbeMessage({
        agent: "claude-cli",
        argsJson: spec.argsJson,
        attempt: 1,
        exactReply: spec.name,
      }),
    ).toContain("openclaw-tools/cron");
    expect(
      buildLiveCronProbeMessage({
        agent: "codex",
        argsJson: spec.argsJson,
        attempt: 1,
        exactReply: spec.name,
      }),
    ).toContain("ask me to retry");
    expect(
      buildLiveCronProbeMessage({
        agent: "codex",
        argsJson: spec.argsJson,
        attempt: 1,
        exactReply: spec.name,
      }),
    ).toContain("previous OpenClaw cron MCP tool call was cancelled");
    expect(JSON.parse(spec.argsJson)).toEqual(
      expect.objectContaining({
        job: expect.objectContaining({
          sessionTarget: "session:agent:codex:acp:test",
          agentId: "codex",
          sessionKey: "agent:codex:acp:test",
        }),
      }),
    );
  });

  it("builds a cron probe spec when the process clock is outside the Date range", () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

    try {
      const spec = createLiveCronProbeSpec();
      const args = JSON.parse(spec.argsJson) as {
        job?: { schedule?: { at?: string } };
      };

      expect(spec.at).toBe("1970-01-01T00:00:00.000Z");
      expect(args.job?.schedule?.at).toBe("1970-01-01T00:00:00.000Z");
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("validates cron cli job shape for the shared live probe", () => {
    expect(() =>
      assertCronJobMatches({
        job: {
          name: "live-mcp-abc",
          sessionTarget: "session:agent:dev:test",
          agentId: "dev",
          sessionKey: "agent:dev:test",
          payload: { kind: "agentTurn", message: "probe-abc" },
        },
        expectedName: "live-mcp-abc",
        expectedMessage: "probe-abc",
        expectedSessionKey: "agent:dev:test",
      }),
    ).not.toThrow();
  });
});
