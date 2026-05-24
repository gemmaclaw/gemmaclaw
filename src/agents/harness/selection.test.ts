import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../pi-embedded-runner/run/types.js";
import { clearAgentHarnesses, registerAgentHarness } from "./registry.js";
import { runAgentHarnessAttemptWithFallback, selectAgentHarness } from "./selection.js";
import type { AgentHarness } from "./types.js";

const piRunAttempt = vi.fn(async () => createAttemptResult("pi"));

vi.mock("./builtin-pi.js", () => ({
  createPiAgentHarness: (): AgentHarness => ({
    id: "pi",
    label: "PI embedded agent",
    supports: () => ({ supported: true, priority: 0 }),
    runAttempt: piRunAttempt,
  }),
}));

const originalRuntime = process.env.OPENCLAW_AGENT_RUNTIME;
const originalHarnessFallback = process.env.OPENCLAW_AGENT_HARNESS_FALLBACK;

afterEach(() => {
  clearAgentHarnesses();
  piRunAttempt.mockClear();
  if (originalRuntime == null) {
    delete process.env.OPENCLAW_AGENT_RUNTIME;
  } else {
    process.env.OPENCLAW_AGENT_RUNTIME = originalRuntime;
  }
  if (originalHarnessFallback == null) {
    delete process.env.OPENCLAW_AGENT_HARNESS_FALLBACK;
  } else {
    process.env.OPENCLAW_AGENT_HARNESS_FALLBACK = originalHarnessFallback;
  }
});

function createAttemptParams(config?: OpenClawConfig): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    runId: "run-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    timeoutMs: 5_000,
    provider: "codex",
    modelId: "gpt-5.4",
    model: { id: "gpt-5.4", provider: "codex" } as Model<Api>,
    authStorage: {} as never,
    modelRegistry: {} as never,
    thinkLevel: "low",
    config,
  } as EmbeddedRunAttemptParams;
}

function createAttemptResult(sessionIdUsed: string): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed,
    messagesSnapshot: [],
    assistantTexts: [`${sessionIdUsed} ok`],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  };
}

function registerFailingCodexHarness(): void {
  registerAgentHarness(
    {
      id: "codex",
      label: "Failing Codex",
      supports: (ctx) =>
        ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt: vi.fn(async () => {
        throw new Error("codex startup failed");
      }),
    },
    { ownerPluginId: "codex" },
  );
}

describe("runAgentHarnessAttemptWithFallback", () => {
  it("falls back to the PI harness when a forced plugin harness is unavailable", async () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "codex";

    const result = await runAgentHarnessAttemptWithFallback(createAttemptParams());

    expect(result.sessionIdUsed).toBe("pi");
    expect(piRunAttempt).toHaveBeenCalledTimes(1);
  });

  it("falls back to the PI harness in auto mode when no plugin harness matches", async () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "auto";

    const result = await runAgentHarnessAttemptWithFallback(createAttemptParams());

    expect(result.sessionIdUsed).toBe("pi");
    expect(piRunAttempt).toHaveBeenCalledTimes(1);
  });

  it("surfaces an auto-selected plugin harness failure instead of replaying through PI", async () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "auto";
    registerFailingCodexHarness();

    await expect(runAgentHarnessAttemptWithFallback(createAttemptParams())).rejects.toThrow(
      "codex startup failed",
    );
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("surfaces a forced plugin harness failure instead of replaying through PI", async () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "codex";
    registerFailingCodexHarness();

    await expect(runAgentHarnessAttemptWithFallback(createAttemptParams())).rejects.toThrow(
      "codex startup failed",
    );
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("honors env fallback override over config fallback", async () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "auto";
    process.env.OPENCLAW_AGENT_HARNESS_FALLBACK = "none";

    await expect(
      runAgentHarnessAttemptWithFallback(
        createAttemptParams({ agents: { defaults: { embeddedHarness: { fallback: "pi" } } } }),
      ),
    ).rejects.toThrow("PI fallback is disabled");
    expect(piRunAttempt).not.toHaveBeenCalled();
  });
});

describe("selectAgentHarness", () => {
  it("fails instead of choosing PI when no plugin harness matches and fallback is none", () => {
    expect(() =>
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        config: { agents: { defaults: { embeddedHarness: { fallback: "none" } } } },
      }),
    ).toThrow("PI fallback is disabled");
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("allows per-agent embedded harness policy overrides", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { embeddedHarness: { fallback: "pi" } },
        list: [
          { id: "main", default: true },
          { id: "strict", embeddedHarness: { fallback: "none" } },
        ],
      },
    };

    expect(() =>
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        config,
        sessionKey: "agent:strict:session-1",
      }),
    ).toThrow("PI fallback is disabled");
    expect(selectAgentHarness({ provider: "anthropic", modelId: "sonnet-4.6", config }).id).toBe(
      "pi",
    );
  });


  it("selects PI when the implicit OpenAI Codex harness is unavailable", () => {
    expect(selectAgentHarness({ provider: "openai", modelId: "gpt-5.4" }).id).toBe("pi");
  });

  it("ignores legacy agentRuntime as a runtime policy source", () => {
    const config = {
      agents: {
        defaults: {
          agentRuntime: { id: "codex" },
        },
      },
    } as OpenClawConfig;

    expect(
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        config,
      }).id,
    ).toBe("pi");
  });

  it("ignores legacy agent CLI runtime aliases for OpenAI agent model runs", async () => {
    registerSuccessfulCodexHarness();
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
        },
      },
    };

    expect(selectAgentHarness({ provider: "openai", modelId: "gpt-5.4", config }).id).toBe("codex");

    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(config),
      provider: "openai",
      modelId: "gpt-5.4",
    });
    expect(result.sessionIdUsed).toBe("codex");
    expect(piRunAttempt).not.toHaveBeenCalled();
  });

  it("ignores existing session PI pins when provider policy forces a plugin harness", () => {
    registerFailingCodexHarness();

    expect(
      selectAgentHarness({
        provider: "codex",
        modelId: "gpt-5.4",
        agentHarnessId: "pi",
        config: providerRuntimeConfig("codex", "codex"),
      }).id,
    ).toBe("codex");
  });

  it("ignores env-forced PI for OpenAI default runtime selection", () => {
    process.env.OPENCLAW_AGENT_RUNTIME = "pi";
    registerFailingCodexHarness();

    expect(
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.4",
        agentHarnessId: "codex",
      }).id,
    ).toBe("codex");
  });

  it("skips harness compaction preflight for claude-cli runtime sessions", async () => {
    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "anthropic",
        model: "claude-opus-4-7",
        config: agentModelRuntimeConfig("anthropic/claude-opus-4-7", "claude-cli"),
      }),
    ).resolves.toBeUndefined();
  });

  it("skips harness compaction preflight for claude-cli provider sessions", async () => {
    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "claude-cli",
        model: "claude-opus-4-7",
        config: providerRuntimeConfig("claude-cli", "claude-cli"),
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores stale plugin pins during compaction when the provider no longer matches", async () => {
    registerFailingCodexHarness();

    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "ollama",
        model: "llama3.3",
        agentHarnessId: "codex",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not compact a selected plugin harness through PI when the plugin has no compactor", async () => {
    registerFailingCodexHarness();

    await expect(
      maybeCompactAgentHarnessSession({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        provider: "codex",
        model: "gpt-5.5",
        agentHarnessId: "codex",
      }),
    ).resolves.toEqual({
      ok: false,
      compacted: false,
      reason: 'Agent harness "codex" does not support compaction.',
      failure: { reason: "unsupported_harness_compaction" },
    });
  });

  it.each([
    { provider: "anthropic", modelId: "sonnet-4.6", alias: "claude-cli" },
    { provider: "google", modelId: "gemini-3-pro-preview", alias: "google-gemini-cli" },
  ])(
    "returns PI for explicit CLI runtime alias $alias on $provider instead of throwing MissingAgentHarnessError",
    ({ provider, modelId, alias }) => {
      expect(
        selectAgentHarness({
          provider,
          modelId,
          agentHarnessRuntimeOverride: alias,
        }).id,
      ).toBe("pi");
    },
  );

  it("still throws MissingAgentHarnessError for an explicit configured cliBackends id", () => {
    const config = {
      agents: {
        defaults: {
          cliBackends: {
            "my-custom-cli": { command: "echo" },
          },
        },
      },
    } as OpenClawConfig;

    expect(() =>
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        agentHarnessRuntimeOverride: "my-custom-cli",
        config,
      }),
    ).toThrow('Requested agent harness "my-custom-cli" is not registered');
  });

  it("still throws MissingAgentHarnessError for an explicit non-CLI unknown runtime", () => {
    expect(() =>
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        agentHarnessRuntimeOverride: "clade-cli",
      }),
    ).toThrow('Requested agent harness "clade-cli" is not registered');
  });

  it("still throws MissingAgentHarnessError for an explicit CLI alias owned by another provider", () => {
    expect(() =>
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        agentHarnessRuntimeOverride: "google-gemini-cli",
      }),
    ).toThrow('Requested agent harness "google-gemini-cli" is not registered');
  });
});
