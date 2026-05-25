import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMemorySystemPromptAddition } from "../../../plugin-sdk/core.js";
import {
  clearMemoryPluginState,
  registerMemoryPromptSection,
} from "../../../plugins/memory-state.js";
import {
  type AttemptContextEngine,
  buildLoopPromptCacheInfo,
  assembleAttemptContextEngine,
  buildContextEnginePromptCacheInfo,
  findCurrentAttemptAssistantMessage,
  finalizeAttemptContextEngineTurn,
  resolvePromptCacheTouchTimestamp,
  runAttemptContextEngineBootstrap,
} from "./attempt.context-engine-helpers.js";
import {
  cleanupTempPaths,
  createContextEngineBootstrapAndAssemble,
  expectCalledWithSessionKey,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";
import {
  buildEmbeddedSubscriptionParams,
  cleanupEmbeddedAttemptResources,
} from "./attempt.subscription-cleanup.js";

const hoisted = getHoisted();
const embeddedSessionId = "embedded-session";
const sessionFile = "/tmp/session.jsonl";
const seedMessage = { role: "user", content: "seed", timestamp: 1 } as AgentMessage;
const doneMessage = { role: "assistant", content: "done", timestamp: 2 } as unknown as AgentMessage;
type AfterTurnPromptCacheCall = { runtimeContext?: { promptCache?: Record<string, unknown> } };

function createTestContextEngine(params: Partial<AttemptContextEngine>): AttemptContextEngine {
  return {
    info: {
      id: "test-context-engine",
      name: "Test Context Engine",
      version: "0.0.1",
    },
    ingest: async () => ({ ingested: true }),
    compact: async () => ({
      ok: false,
      compacted: false,
      reason: "not used in this test",
    }),
    ...params,
  } as AttemptContextEngine;
}

async function runBootstrap(
  sessionKey: string,
  contextEngine: AttemptContextEngine,
  overrides: Partial<Parameters<typeof runAttemptContextEngineBootstrap>[0]> = {},
) {
  await runAttemptContextEngineBootstrap({
    hadSessionFile: true,
    contextEngine,
    sessionId: embeddedSessionId,
    sessionKey,
    sessionFile,
    sessionManager: hoisted.sessionManager,
    runtimeContext: {},
    runMaintenance: hoisted.runContextEngineMaintenanceMock,
    warn: () => {},
    ...overrides,
  });
}

async function runAssemble(
  sessionKey: string,
  contextEngine: AttemptContextEngine,
  overrides: Partial<Parameters<typeof assembleAttemptContextEngine>[0]> = {},
) {
  return await assembleAttemptContextEngine({
    contextEngine,
    sessionId: embeddedSessionId,
    sessionKey,
    messages: [seedMessage],
    tokenBudget: 2048,
    modelId: "gpt-test",
    ...overrides,
  });
}

async function finalizeTurn(
  sessionKey: string,
  contextEngine: AttemptContextEngine,
  overrides: Partial<Parameters<typeof finalizeAttemptContextEngineTurn>[0]> = {},
) {
  await finalizeAttemptContextEngineTurn({
    contextEngine,
    promptError: false,
    aborted: false,
    yieldAborted: false,
    sessionIdUsed: embeddedSessionId,
    sessionKey,
    sessionFile,
    messagesSnapshot: [doneMessage],
    prePromptMessageCount: 0,
    tokenBudget: 2048,
    runtimeContext: {},
    runMaintenance: hoisted.runContextEngineMaintenanceMock,
    sessionManager: hoisted.sessionManager,
    warn: () => {},
    ...overrides,
  });
}

describe("runEmbeddedAttempt context engine sessionKey forwarding", () => {
  const sessionKey = "agent:main:guildchat:channel:test-ctx-engine";
  const tempPaths: string[] = [];
  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
    hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });

  it("flushes block replies again after compaction retry wait resolves", async () => {
    const order: string[] = [];
    let flushCount = 0;
    const onBlockReplyFlush = vi.fn(async () => {
      flushCount += 1;
      order.push(`flush-${flushCount}`);
    });
    hoisted.waitForCompactionRetryWithAggregateTimeoutMock.mockImplementation(async () => {
      order.push("retry-wait");
      return { timedOut: false };
    });

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        onBlockReplyFlush,
      },
    });

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(2);
    expect(hoisted.waitForCompactionRetryWithAggregateTimeoutMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["flush-1", "retry-wait", "flush-2"]);
  });

  it("enables Tool Search controls for embedded PI runs when configured", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
      },
      sessionKey,
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        config: {
          tools: {
            toolSearch: true,
          },
        } as OpenClawConfig,
      },
    });

    expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledTimes(1);
    const options = mockParams(
      hoisted.createOpenClawCodingToolsMock,
      0,
      "createOpenClawCodingTools options",
    );
    expect(options.includeToolSearchControls).toBe(true);
    expect(options.toolSearchCatalogRef).toEqual({});
  });

  it("enforces code-mode payload surface from active-agent config during an embedded attempt", async () => {
    const observedOptions: Array<Record<string, unknown>> = [];
    const payloads: Array<Record<string, unknown>> = [];

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:ops:guildchat:channel:test-code-mode",
      tempPaths,
      attemptOverrides: {
        agentId: "ops",
        disableTools: false,
        config: {
          tools: {
            codeMode: { enabled: false },
          },
          agents: {
            list: [{ id: "ops", tools: { codeMode: true } }],
          },
        } as OpenClawConfig,
        model: {
          api: "openai-codex-responses",
          provider: "gateway",
          id: "gpt-5.5",
          contextWindow: 8192,
          input: ["text"],
        } as never,
      },
      createSession: () => {
        const session = createDefaultEmbeddedSession();
        session.agent.streamFn = async (_model, _context, options) => {
          observedOptions.push(options as Record<string, unknown>);
          const payload: Record<string, unknown> = {
            tools: [
              { type: "function", name: "exec" },
              { type: "function", name: "wait" },
              { type: "function", name: "read" },
            ],
          };
          (
            options as { onPayload?: (payload: Record<string, unknown>) => void } | undefined
          )?.onPayload?.(payload);
          payloads.push(structuredClone(payload));
          return {
            async result() {
              return { role: "assistant", content: "done" };
            },
            [Symbol.asyncIterator]() {
              return (async function* () {})();
            },
          };
        };
        session.prompt = async () => {
          await session.agent.streamFn?.(
            {} as never,
            {
              messages: [],
              tools: [
                { name: "exec", description: "", parameters: {} },
                { name: "wait", description: "", parameters: {} },
              ],
            } as never,
            {},
          );
          session.messages = [
            ...session.messages,
            { role: "assistant", content: "done", timestamp: 2 },
          ];
        };
        return session;
      },
    });

    expect(observedOptions.at(-1)?.openclawCodeModeToolSurface).toBe(true);
    expect(payloads.at(-1)?.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
    ]);
  });

  it("sends transcriptPrompt visibly and queues runtime context as hidden custom context", async () => {
    const seen: { prompt?: string; messages?: unknown[]; systemPrompt?: string } = {};

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: {
        prompt: [
          "visible ask",
          "",
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "secret runtime context",
          "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ].join("\n"),
        transcriptPrompt: "visible ask",
      },
      sessionPrompt: async (session, prompt) => {
        seen.prompt = prompt;
        seen.messages = [...session.messages];
        seen.systemPrompt = session.agent.state.systemPrompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seen.prompt).toBe("visible ask");
    expect(result.finalPromptText).toBe("visible ask");
    expectFields(
      findRecord(
        requireRecords(seen.messages, "seen messages"),
        (message) => message.customType === "openclaw.runtime-context",
        "runtime context message",
      ),
      {
        role: "custom",
        customType: "openclaw.runtime-context",
        display: false,
        content:
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      },
    );
    expect(JSON.stringify(seen.messages)).not.toContain(
      "OpenClaw runtime context for the immediately preceding user message.",
    );
    expect(JSON.stringify(seen.messages)).not.toContain("not user-authored");
    expect(seen.systemPrompt).not.toContain("secret runtime context");
    expect(seen.systemPrompt).not.toContain("OPENCLAW_INTERNAL_CONTEXT");
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    const promptSubmitted = trajectoryEvents.find((event) => event.type === "prompt.submitted");
    const contextCompiled = trajectoryEvents.find((event) => event.type === "context.compiled");
    const modelCompleted = trajectoryEvents.find((event) => event.type === "model.completed");
    const traceArtifacts = trajectoryEvents.find((event) => event.type === "trace.artifacts");

    expect(promptSubmitted?.data?.prompt).toBe("visible ask");
    expect(contextCompiled?.data?.prompt).toBe("visible ask");
    expect(modelCompleted?.data?.finalPromptText).toBe("visible ask");
    expect(traceArtifacts?.data?.finalPromptText).toBe("visible ask");
    for (const value of [
      promptSubmitted?.data?.prompt,
      contextCompiled?.data?.prompt,
      modelCompleted?.data?.finalPromptText,
      traceArtifacts?.data?.finalPromptText,
    ]) {
      expect(String(value)).not.toContain("OPENCLAW_INTERNAL_CONTEXT");
      expect(String(value)).not.toContain("secret runtime context");
    }
  });

  it("filters heartbeat response-tool transcript artifacts before normal prompt snapshots", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();
    const sessionMessages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT, timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bash",
            name: "bash",
            arguments: { command: "cat HEARTBEAT.md" },
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "HEARTBEAT.md says stay quiet" }],
        timestamp: 3,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "no_change",
              notify: false,
              summary: "No visible update.",
            },
          },
        ],
        timestamp: 4,
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: '{"notify":false}' }],
        timestamp: 5,
      },
      { role: "assistant", content: "No visible update. notify=false", timestamp: 6 },
    ] as AgentMessage[];

    const result = await createContextEngineAttemptRunner({
      contextEngine,
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        prompt: "what model are you",
        transcriptPrompt: "what model are you",
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "gpt-test", timestamp: 7 },
        ];
      },
    });

    const assembleInput = contextEngine.assemble.mock.calls.at(0)?.[0];
    const assembledMessagesJson = JSON.stringify(assembleInput?.messages ?? []);
    const snapshotJson = JSON.stringify(result.messagesSnapshot);
    for (const artifact of [
      "HEARTBEAT.md",
      "heartbeat_respond",
      "notify=false",
      '"notify":false',
      HEARTBEAT_TRANSCRIPT_PROMPT,
    ]) {
      expect(assembledMessagesJson).not.toContain(artifact);
      expect(snapshotJson).not.toContain(artifact);
    }
    expect(result.finalPromptText).toBe("what model are you");
  });

  it("filters interrupted prompt-only heartbeat artifacts before normal prompt snapshots", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();
    const sessionMessages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT, timestamp: 1 },
    ] as AgentMessage[];

    const result = await createContextEngineAttemptRunner({
      contextEngine,
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        prompt: "what model are you",
        transcriptPrompt: "what model are you",
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "gpt-test", timestamp: 2 },
        ];
      },
    });

    const assembleInput = contextEngine.assemble.mock.calls.at(0)?.[0];
    const assembledMessagesJson = JSON.stringify(assembleInput?.messages ?? []);
    const snapshotJson = JSON.stringify(result.messagesSnapshot);
    expect(assembledMessagesJson).not.toContain(HEARTBEAT_TRANSCRIPT_PROMPT);
    expect(snapshotJson).not.toContain(HEARTBEAT_TRANSCRIPT_PROMPT);
    expect(result.finalPromptText).toBe("what model are you");
  });

  it("filters pending notify=true heartbeat response-tool calls before normal prompt snapshots", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();
    const sessionMessages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT, timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
        timestamp: 2,
      },
    ] as AgentMessage[];

    const result = await createContextEngineAttemptRunner({
      contextEngine,
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        prompt: "what model are you",
        transcriptPrompt: "what model are you",
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "gpt-test", timestamp: 3 },
        ];
      },
    });

    const assembleInput = contextEngine.assemble.mock.calls.at(0)?.[0];
    const assembledMessagesJson = JSON.stringify(assembleInput?.messages ?? []);
    const snapshotJson = JSON.stringify(result.messagesSnapshot);
    for (const artifact of [
      HEARTBEAT_TRANSCRIPT_PROMPT,
      "heartbeat_respond",
      '"notify":true',
      "Build is blocked on missing credentials.",
    ]) {
      expect(assembledMessagesJson).not.toContain(artifact);
      expect(snapshotJson).not.toContain(artifact);
    }
    expect(result.finalPromptText).toBe("what model are you");
  });

  it("preserves visible heartbeat alerts in normal prompt snapshots", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();
    const sessionMessages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT, timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bash",
            name: "bash",
            arguments: { command: "cat HEARTBEAT.md" },
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_bash",
        content: [{ type: "text", text: "HEARTBEAT.md says check deployment" }],
        timestamp: 3,
      },
      {
        role: "assistant",
        content: "Build is blocked on a failing release check.",
        timestamp: 4,
      },
    ] as AgentMessage[];

    const result = await createContextEngineAttemptRunner({
      contextEngine,
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        prompt: "what changed while I was away?",
        transcriptPrompt: "what changed while I was away?",
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "gpt-test", timestamp: 5 },
        ];
      },
    });

    const assembleInput = contextEngine.assemble.mock.calls.at(0)?.[0];
    const assembledMessagesJson = JSON.stringify(assembleInput?.messages ?? []);
    const snapshotJson = JSON.stringify(result.messagesSnapshot);
    for (const visibleContext of [
      HEARTBEAT_TRANSCRIPT_PROMPT,
      "HEARTBEAT.md says check deployment",
      "Build is blocked on a failing release check.",
    ]) {
      expect(assembledMessagesJson).toContain(visibleContext);
      expect(snapshotJson).toContain(visibleContext);
    }
    expect(result.finalPromptText).toBe("what changed while I was away?");
  });

  it("preserves visible heartbeat response-tool notifications in normal prompt snapshots", async () => {
    const contextEngine = createContextEngineBootstrapAndAssemble();
    const sessionMessages = [
      { role: "user", content: HEARTBEAT_TRANSCRIPT_PROMPT, timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_heartbeat",
            name: "heartbeat_respond",
            arguments: {
              outcome: "needs_attention",
              notify: true,
              summary: "Build is blocked.",
              notificationText: "Build is blocked on missing credentials.",
            },
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_heartbeat",
        content: [{ type: "text", text: '{"notify":true}' }],
        timestamp: 3,
      },
      { role: "assistant", content: "HEARTBEAT_OK", timestamp: 4 },
    ] as AgentMessage[];

    const result = await createContextEngineAttemptRunner({
      contextEngine,
      sessionKey,
      tempPaths,
      sessionMessages,
      attemptOverrides: {
        prompt: "what changed while I was away?",
        transcriptPrompt: "what changed while I was away?",
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "gpt-test", timestamp: 5 },
        ];
      },
    });

    const assembleInput = contextEngine.assemble.mock.calls.at(0)?.[0];
    const assembledMessagesJson = JSON.stringify(assembleInput?.messages ?? []);
    const snapshotJson = JSON.stringify(result.messagesSnapshot);
    for (const visibleContext of [
      "heartbeat_respond",
      '"notify":true',
      "Build is blocked on missing credentials.",
      "HEARTBEAT_OK",
    ]) {
      expect(assembledMessagesJson).toContain(visibleContext);
      expect(snapshotJson).toContain(visibleContext);
    }
    expect(result.finalPromptText).toBe("what changed while I was away?");
  });

  it("rebuilds skill prompt inputs from the sandbox workspace for non-rw sandbox runs", async () => {
    const sandboxWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-skills-"));
    tempPaths.push(sandboxWorkspace);
    hoisted.resolveSandboxContextMock.mockResolvedValue({
      enabled: true,
      workspaceAccess: "ro",
      workspaceDir: sandboxWorkspace,
    });

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        skillsSnapshot: {
          prompt:
            "<available_skills><skill><location>~/.openclaw/skills/smaug/SKILL.md</location></skill></available_skills>",
          skills: [{ name: "smaug" }],
          resolvedSkills: [
            {
              name: "smaug",
              description: "Host copy",
              disableModelInvocation: false,
              filePath: "/Users/alice/.openclaw/skills/smaug/SKILL.md",
              baseDir: "/Users/alice/.openclaw/skills/smaug",
              source: "openclaw-workspace",
              sourceInfo: {
                path: "/Users/alice/.openclaw/skills/smaug/SKILL.md",
                source: "openclaw-workspace",
                scope: "project",
                origin: "top-level",
                baseDir: "/Users/alice/.openclaw/skills/smaug",
              },
            },
          ],
        },
      },
    });

    expectFields(
      mockParams(hoisted.resolveEmbeddedRunSkillEntriesMock, 0, "skill entries params"),
      {
        workspaceDir: sandboxWorkspace,
        skillsSnapshot: undefined,
      },
    );
    expectFields(mockParams(hoisted.resolveSkillsPromptForRunMock, 0, "skills prompt params"), {
      workspaceDir: sandboxWorkspace,
      skillsSnapshot: undefined,
    });
  });

  it("keeps before_prompt_build prependContext out of system prompt on transcriptPrompt runs", async () => {
    const runBeforePromptBuild = vi.fn(async () => ({ prependContext: "dynamic hook context" }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((name: string) => name === "before_prompt_build"),
      runBeforePromptBuild,
      runBeforeAgentStart: vi.fn(),
    });
    const seen: { prompt?: string; messages?: unknown[]; systemPrompt?: string } = {};

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: "visible ask",
        transcriptPrompt: "visible ask",
      },
      sessionPrompt: async (session, prompt) => {
        seen.prompt = prompt;
        seen.messages = [...session.messages];
        seen.systemPrompt = session.agent.state.systemPrompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seen.prompt).toBe("visible ask");
    expect(result.finalPromptText).toBe("visible ask");
    expect(seen.systemPrompt).not.toContain("dynamic hook context");
    expectFields(
      findRecord(
        requireRecords(seen.messages, "seen messages"),
        (message) => message.customType === "openclaw.runtime-context",
        "hook runtime context message",
      ),
      {
        role: "custom",
        customType: "openclaw.runtime-context",
        display: false,
        content: "dynamic hook context",
      },
    );
  });

  it("keeps bootstrap truncation warnings out of WebChat runtime context", async () => {
    const seen: { prompt?: string; messages?: unknown[] } = {};
    hoisted.resolveBootstrapContextForRunMock.mockResolvedValueOnce({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/openclaw-warning-workspace/AGENTS.md",
          content: "A".repeat(200),
          missing: false,
        },
      ],
      contextFiles: [
        { path: "/tmp/openclaw-warning-workspace/AGENTS.md", content: "A".repeat(20) },
      ],
    });

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        config: {
          agents: {
            defaults: {
              bootstrapMaxChars: 50,
              bootstrapTotalMaxChars: 50,
            },
          },
        } as OpenClawConfig,
        prompt: "visible ask",
        transcriptPrompt: "visible ask",
      },
      sessionPrompt: async (session, prompt) => {
        seen.prompt = prompt;
        seen.messages = [...session.messages];
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seen.prompt).toBe("visible ask");
    expect(JSON.stringify(seen.messages)).not.toContain("[Bootstrap truncation warning]");
    expect(JSON.stringify(seen.messages)).not.toContain("bootstrapMaxChars");
  });

  it("preserves bootstrap system context when system prompt override is configured", async () => {
    const seen: { prompt?: string; messages?: unknown[] } = {};
    hoisted.isWorkspaceBootstrapPendingMock.mockResolvedValueOnce(true);
    hoisted.createOpenClawCodingToolsMock.mockImplementationOnce(() => [
      { name: "read", execute: async () => "" },
    ]);
    hoisted.resolveBootstrapContextForRunMock.mockResolvedValueOnce({
      bootstrapFiles: [
        {
          name: "BOOTSTRAP.md",
          path: "/tmp/openclaw-override-workspace/BOOTSTRAP.md",
          content: "Ask who I am.",
          missing: false,
        },
      ],
      contextFiles: [
        {
          path: "/tmp/openclaw-override-workspace/BOOTSTRAP.md",
          content: "Ask who I am.",
        },
      ],
    });

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        config: {
          agents: {
            defaults: {
              systemPromptOverride: "Custom override prompt.",
            },
          },
        } as OpenClawConfig,
        disableTools: false,
        prompt: "visible ask",
        transcriptPrompt: "visible ask",
        trigger: "user",
      },
      sessionPrompt: async (session, prompt) => {
        seen.prompt = prompt;
        seen.messages = [...session.messages];
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seen.prompt).toBe("visible ask");
    expect(JSON.stringify(seen.messages)).not.toContain("Ask who I am.");
    const systemPrompt =
      hoisted.systemPromptOverrideTexts.find((text) => text.includes("Custom override prompt.")) ??
      "";

    expect(systemPrompt).toContain("Custom override prompt.");
    expect(systemPrompt).toContain("## Bootstrap Pending");
    expect(systemPrompt).toContain("BOOTSTRAP.md is included below in Project Context");
    expect(systemPrompt).toContain("## /tmp/openclaw-override-workspace/BOOTSTRAP.md");
    expect(systemPrompt).toContain("Ask who I am.");
  });

  it("includes hook-adjusted bootstrap files preloaded before routing", async () => {
    const workspaceDir = "/tmp/openclaw-hook-workspace";
    hoisted.resolveBootstrapFilesForRunMock.mockResolvedValueOnce([
      {
        name: "BOOTSTRAP.md",
        path: `${workspaceDir}/BOOTSTRAP.md`,
        content: "Ask who I am before continuing.",
        missing: false,
      },
    ]);

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        config: {
          agents: {
            defaults: {
              systemPromptOverride: "Custom override prompt.",
            },
          },
        } as OpenClawConfig,
        prompt: "visible ask",
        transcriptPrompt: "visible ask",
        trigger: "user",
        workspaceDir,
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(hoisted.resolveBootstrapFilesForRunMock).toHaveBeenCalledOnce();
    expect(hoisted.resolveBootstrapContextForRunMock).not.toHaveBeenCalled();
    const systemPrompt =
      hoisted.systemPromptOverrideTexts.find((text) => text.includes("Custom override prompt.")) ??
      "";

    expect(systemPrompt).toContain("## Bootstrap Pending");
    expect(systemPrompt).toContain("BOOTSTRAP.md is included below in Project Context");
    expect(systemPrompt).toContain(`## ${workspaceDir}/BOOTSTRAP.md`);
    expect(systemPrompt).toContain("Ask who I am before continuing.");
  });

  it("skips bootstrap preload on completed continuation-skip turns", async () => {
    hoisted.resolveContextInjectionModeMock.mockReturnValue("continuation-skip");
    hoisted.hasCompletedBootstrapTurnMock.mockResolvedValue(true);
    hoisted.isWorkspaceBootstrapPendingMock.mockResolvedValue(false);

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: "visible ask",
        transcriptPrompt: "visible ask",
        trigger: "user",
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(hoisted.hasCompletedBootstrapTurnMock).toHaveBeenCalledOnce();
    expect(hoisted.isWorkspaceBootstrapPendingMock).toHaveBeenCalledOnce();
    expect(hoisted.resolveBootstrapFilesForRunMock).not.toHaveBeenCalled();
    expect(hoisted.resolveBootstrapContextForRunMock).not.toHaveBeenCalled();
  });

  it("adds current-turn context to the current model input without exposing internal runtime context", async () => {
    let seenPrompt: string | undefined;

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: {
        prompt: [
          "what does this mean?",
          "",
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "secret runtime context",
          "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ].join("\n"),
        transcriptPrompt: "what does this mean?",
        currentInboundContext: {
          text: [
            "Reply target of current user message (untrusted, for context):",
            "```json",
            JSON.stringify(
              {
                sender_label: "Mike",
                body: "WT daily plan - Sat May 2\nSee ./quoted-secret.png and [media attached: media://inbound/quoted.png]",
              },
              null,
              2,
            ),
            "```",
          ].join("\n"),
        },
      },
      sessionPrompt: async (session, prompt) => {
        seenPrompt = prompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seenPrompt).toContain("what does this mean?");
    expect(seenPrompt).toContain("Reply target of current user message (untrusted, for context):");
    expect(seenPrompt).toContain('"sender_label": "Mike"');
    expect(seenPrompt).toContain("WT daily plan - Sat May 2");
    expect(seenPrompt).toContain("./quoted-secret.png");
    expect(seenPrompt).toContain("media://inbound/quoted.png");
    expect(seenPrompt).not.toContain("OPENCLAW_INTERNAL_CONTEXT");
    expect(seenPrompt).not.toContain("secret runtime context");
    expect(seenPrompt?.trim().startsWith("Reply target of current user message")).toBe(true);
    expect(result.finalPromptText).toBe(seenPrompt);
    expect(hoisted.detectAndLoadPromptImagesMock).toHaveBeenCalledTimes(1);
    expect(mockParams(hoisted.detectAndLoadPromptImagesMock, 0, "prompt image params").prompt).toBe(
      "what does this mean?",
    );
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    const promptSubmitted = trajectoryEvents.find((event) => event.type === "prompt.submitted");
    expect(promptSubmitted?.data?.prompt).toBe(seenPrompt);
    expect(promptSubmitted?.data?.prompt).toContain("WT daily plan - Sat May 2");
    expect(promptSubmitted?.data?.prompt).not.toContain("secret runtime context");
  });

  it("keeps inter-session provenance hidden while submitting the visible prompt", async () => {
    const seen: { prompt?: string; messages?: unknown[] } = {};

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        prompt: [
          "visible ask",
          "",
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "secret runtime context",
          "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ].join("\n"),
        transcriptPrompt: "visible ask",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
      },
      sessionPrompt: async (session, prompt) => {
        seen.prompt = prompt;
        seen.messages = [...session.messages];
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seen.prompt).toBe("visible ask");
    expect(result.finalPromptText).toBe("visible ask");
    const runtimeContext = findRecord(
      requireRecords(seen.messages, "seen messages"),
      (message) => message.customType === "openclaw.runtime-context",
      "runtime context message",
    );
    expect(runtimeContext.content).toContain("[Inter-session message]");
    expect(runtimeContext.content).toContain("isUser=false");
    expect(runtimeContext.content).not.toContain("visible ask");
    expect(runtimeContext.content).toContain("secret runtime context");
  });

  it("submits runtime-only context through system prompt without visible prompt", async () => {
    let seenPrompt: string | undefined;

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: {
        prompt: "internal heartbeat event",
        transcriptPrompt: "",
      },
      sessionPrompt: async (session, prompt) => {
        seenPrompt = prompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seenPrompt).toBe("Continue the OpenClaw runtime event.");
    expect(result.finalPromptText).toBe("Continue the OpenClaw runtime event.");
    expect(
      requireRecords(result.messagesSnapshot, "messages snapshot").some(
        (message) =>
          message.role === "user" && String(message.content).includes("internal heartbeat event"),
      ),
    ).toBe(false);
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    const contextCompiled = trajectoryEvents.find((event) => event.type === "context.compiled");
    expect(contextCompiled?.data?.prompt).toBe("Continue the OpenClaw runtime event.");
    expect(contextCompiled?.data?.systemPrompt).toContain("internal heartbeat event");
  });

  it("keeps current inbound context visible on runtime-only turns", async () => {
    let seenPrompt: string | undefined;

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: {
        prompt: "runtime bare mention event",
        transcriptPrompt: "",
        currentInboundContext: {
          text: [
            "Reply target of current user message (untrusted, for context):",
            "```json",
            JSON.stringify(
              { sender_label: "Alice", body: "Hello from the replied message" },
              null,
              2,
            ),
            "```",
          ].join("\n"),
        },
      },
      sessionPrompt: async (session, prompt) => {
        seenPrompt = prompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seenPrompt).toContain("Reply target of current user message (untrusted, for context):");
    expect(seenPrompt).toContain("Hello from the replied message");
    expect(seenPrompt).toContain("Continue the OpenClaw runtime event.");
    expect(result.finalPromptText).toBe(seenPrompt);
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    const contextCompiled = trajectoryEvents.find((event) => event.type === "context.compiled");
    expect(contextCompiled?.data?.prompt).toContain("Hello from the replied message");
    expect(contextCompiled?.data?.systemPrompt).toContain("runtime bare mention event");
  });

  it("submits suppressed room event context as the model prompt", async () => {
    let seenPrompt: string | undefined;

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: {
        prompt: "[OpenClaw room event]",
        transcriptPrompt: "",
        currentInboundEventKind: "room_event",
        currentInboundContext: {
          text: [
            "[OpenClaw room event]",
            "inbound_event_kind: room_event",
            "visible_reply_contract: message_tool_only",
            "Room context:\n#2001 Alice: lunch at 2?\n#2002 Bob: works",
            "Current event:\n#2003 Bob: hey claw summarize the plan",
            "Treat this as observed room activity. Decide whether to act.",
          ].join("\n\n"),
        },
        suppressNextUserMessagePersistence: true,
      },
      sessionPrompt: async (session, prompt) => {
        seenPrompt = prompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(seenPrompt).toContain("[OpenClaw room event]");
    expect(seenPrompt).toContain("inbound_event_kind: room_event");
    expect(seenPrompt).toContain("visible_reply_contract: message_tool_only");
    expect(seenPrompt).toContain("Current event:\n#2003 Bob: hey claw summarize the plan");
    expect(seenPrompt?.trim().endsWith("[OpenClaw room event]")).toBe(true);
    expect(seenPrompt).not.toBe("Continue the OpenClaw runtime event.");
    expect(result.finalPromptText).toBe(seenPrompt);
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    const contextCompiled = trajectoryEvents.find((event) => event.type === "context.compiled");
    expect(contextCompiled?.data?.prompt).toContain("visible_reply_contract: message_tool_only");
    expect(contextCompiled?.data?.prompt).toContain("[OpenClaw room event]");
  });

  it("skips blank visible prompts with replay history before provider submission", async () => {
    const lockEvents = trackSessionWriteLocks();
    const sessionPrompt = vi.fn(async () => {
      throw new Error("blank prompt should not be submitted");
    });

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: {
        prompt: "  \n\t  ",
      },
      sessionPrompt,
    });

    expect(sessionPrompt).not.toHaveBeenCalled();
    expect(result.finalPromptText).toBeUndefined();
    expect(result.promptError).toBeNull();
    expect(result.messagesSnapshot).toHaveLength(1);
    expectFields(requireRecord(result.messagesSnapshot[0], "messages snapshot seed"), {
      role: "user",
      content: "seed",
    });
    const trajectoryEvents = (
      await fs.readFile(path.join(tempPaths[0] ?? "", "session.trajectory.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    expect(trajectoryEvents.some((event) => event.type === "prompt.submitted")).toBe(false);
    const skipped = findRecord(
      trajectoryEvents as Array<Record<string, unknown>>,
      (event) => event.type === "prompt.skipped",
      "prompt skipped event",
    );
    expect(requireRecord(skipped.data, "prompt skipped data").reason).toBe("blank_user_prompt");
    expectInitialLockReleasedBeforePostTurnWrite(lockEvents);
  });

  it("releases the initial session lock before before_agent_run block finalizers", async () => {
    const lockEvents = trackSessionWriteLocks();
    const sessionPrompt = vi.fn(async () => {
      throw new Error("blocked prompt should not be submitted");
    });
    const runBeforeAgentRun = vi.fn(async () => ({
      pluginId: "test-policy",
      decision: { outcome: "block", reason: "Blocked by test policy." },
    }));
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((name: string) => name === "before_agent_run"),
      runBeforeAgentRun,
    });

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      sessionPrompt,
    });

    expect(runBeforeAgentRun).toHaveBeenCalledTimes(1);
    expect(sessionPrompt).not.toHaveBeenCalled();
    expect(result.finalPromptText).toBeUndefined();
    expect(result.promptErrorSource).toBe("hook:before_agent_run");
    expectInitialLockReleasedBeforePostTurnWrite(lockEvents);
  });

  it("uses assembled context as the default precheck authority", async () => {
    let sawPrompt = false;
    const hugeHistory = "large raw history ".repeat(2_000);

    const result = await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({
        assemble: async () => ({
          messages: [
            { role: "user", content: "small assembled context", timestamp: 1 },
          ] as AgentMessage[],
          estimatedTokens: 8,
        }),
      }),
      sessionKey,
      tempPaths,
      sessionMessages: [{ role: "user", content: hugeHistory, timestamp: 1 }] as AgentMessage[],
      attemptOverrides: {
        contextTokenBudget: 500,
      },
      sessionPrompt: async (session) => {
        sawPrompt = true;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(sawPrompt).toBe(true);
    expect(result.promptError).toBeNull();
    expect(result.promptErrorSource).toBeNull();
    expect(hoisted.preemptiveCompactionCalls.at(-1)).not.toHaveProperty("unwindowedMessages");
  });

  it("honors context engines that opt into preassembly overflow authority", async () => {
    const lockEvents = trackSessionWriteLocks();
    let sawPrompt = false;
    const hugeHistory = "large raw history ".repeat(2_000);

    const result = await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({
        assemble: async () => ({
          messages: [
            { role: "user", content: "small assembled context", timestamp: 1 },
          ] as AgentMessage[],
          estimatedTokens: 8,
          promptAuthority: "preassembly_may_overflow",
        }),
      }),
      sessionKey,
      tempPaths,
      sessionMessages: [{ role: "user", content: hugeHistory, timestamp: 1 }] as AgentMessage[],
      attemptOverrides: {
        contextTokenBudget: 500,
      },
      sessionPrompt: async (session) => {
        sawPrompt = true;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    expect(sawPrompt).toBe(false);
    expect(result.promptErrorSource).toBe("precheck");
    expect(result.preflightRecovery?.route).toBe("compact_only");
    expect(hoisted.preemptiveCompactionCalls.at(-1)).toHaveProperty("unwindowedMessages");
    expectInitialLockReleasedBeforePostTurnWrite(lockEvents);
  });

  it("snapshots pre-assembly messages before assemble even when the engine windows in place", async () => {
    const hugeHistory = "large raw history ".repeat(2_000);
    const preassemblyMarker = { role: "user", content: hugeHistory, timestamp: 1 } as AgentMessage;

    await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({
        assemble: async ({ messages }: { messages: AgentMessage[] }) => {
          // Simulate an engine that windows the input array IN PLACE.
          // The assemble contract does not require immutability, so the
          // runner must have already snapshotted before calling us.
          messages.length = 0;
          messages.push({ role: "user", content: "windowed", timestamp: 2 } as AgentMessage);
          return {
            messages: [
              { role: "user", content: "small assembled context", timestamp: 1 },
            ] as AgentMessage[],
            estimatedTokens: 8,
            promptAuthority: "preassembly_may_overflow",
          };
        },
      }),
      sessionKey,
      tempPaths,
      sessionMessages: [preassemblyMarker],
      attemptOverrides: {
        contextTokenBudget: 500,
      },
      sessionPrompt: async (session) => {
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 3 },
        ];
      },
    });

    const lastCall = hoisted.preemptiveCompactionCalls.at(-1);
    expect(lastCall).toHaveProperty("unwindowedMessages");
    const unwindowed = (lastCall as { unwindowedMessages?: AgentMessage[] }).unwindowedMessages;
    // The snapshot must reflect the true pre-assembly state, not the in-place
    // windowed array that assemble mutated.
    expect(unwindowed).toEqual([preassemblyMarker]);
  });

  it("keeps gateway model runs independent from agent context and session history", async () => {
    const bootstrap = vi.fn(async () => ({ bootstrapped: true }));
    const assemble = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({
      messages: [
        ...messages,
        { role: "custom", customType: "test-context", content: "should not be sent" },
      ] as AgentMessage[],
      estimatedTokens: 1,
    }));
    const afterTurn = vi.fn(async () => {});
    const runBeforePromptBuild = vi.fn(async () => ({ prependContext: "hook context" }));
    const runLlmInput = vi.fn(async () => {});
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn(
        (name: string) =>
          name === "before_prompt_build" || name === "before_agent_start" || name === "llm_input",
      ),
      runBeforePromptBuild,
      runBeforeAgentStart: vi.fn(async () => ({ prependContext: "legacy hook context" })),
      runLlmInput,
    });
    const seen: { prompt?: string; messages?: unknown[]; systemPrompt?: string } = {};

    const result = await createContextEngineAttemptRunner({
      contextEngine: createTestContextEngine({
        bootstrap,
        assemble,
        afterTurn,
      }),
      sessionKey,
      tempPaths,
      sessionMessages: [
        { role: "user", content: "old session question", timestamp: 1 },
        { role: "assistant", content: "old session answer", timestamp: 2 },
      ] as AgentMessage[],
      attemptOverrides: {
        promptMode: "none",
        disableTools: true,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
      },
      sessionPrompt: async (session, prompt) => {
        seen.prompt = prompt;
        seen.messages = [...session.messages];
        seen.systemPrompt = session.agent.state.systemPrompt;
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "pong", timestamp: 3 },
        ];
      },
    });

    expect(seen.prompt).toBe("hello");
    expect(seen.prompt).not.toContain("[Inter-session message]");
    expect(seen.messages).toStrictEqual([]);
    expect(seen.systemPrompt ?? "").toBe("");
    expect(result.finalPromptText).toBe("hello");
    expect(result.systemPromptReport?.systemPrompt ?? "").toBe("");
    expect(result.messagesSnapshot).toHaveLength(1);
    expectFields(requireRecord(result.messagesSnapshot[0], "gateway model snapshot"), {
      role: "assistant",
      content: "pong",
    });
    expect(hoisted.resolveBootstrapContextForRunMock).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
    expect(afterTurn).not.toHaveBeenCalled();
    expect(runBeforePromptBuild).not.toHaveBeenCalled();
    expect(runLlmInput).not.toHaveBeenCalled();
  });

  it("forwards sessionKey to bootstrap, assemble, and afterTurn", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const afterTurn = vi.fn(async (_params: { sessionKey?: string }) => {});
    const contextEngine = createTestContextEngine({
      bootstrap,
      assemble,
      afterTurn,
    });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine);
    await finalizeTurn(sessionKey, contextEngine);

    expectCalledWithSessionKey(bootstrap, sessionKey);
    expectCalledWithSessionKey(assemble, sessionKey);
    expectCalledWithSessionKey(afterTurn, sessionKey);
  });

  it("forwards modelId to assemble", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const contextEngine = createTestContextEngine({ bootstrap, assemble });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine);

    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-test",
      }),
    );
  });

  it("forwards availableTools and citationsMode to assemble", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const contextEngine = createTestContextEngine({ bootstrap, assemble });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine, {
      availableTools: new Set(["memory_search", "wiki_search"]),
      citationsMode: "on",
    });

    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        availableTools: new Set(["memory_search", "wiki_search"]),
        citationsMode: "on",
      }),
    );
  });

  it("lets non-legacy engines opt into the active memory prompt helper", async () => {
    registerMemoryPromptSection(({ availableTools, citationsMode }) => {
      if (!availableTools.has("memory_search")) {
        return [];
      }
      return [
        "## Memory Recall",
        `tools=${[...availableTools].toSorted().join(",")}`,
        `citations=${citationsMode ?? "auto"}`,
        "",
      ];
    });

    const contextEngine = createTestContextEngine({
      assemble: async ({ messages, availableTools, citationsMode }) => ({
        messages,
        estimatedTokens: messages.length,
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
        }),
      }),
    });

    const result = await runAssemble(sessionKey, contextEngine, {
      availableTools: new Set(["wiki_search", "memory_search"]),
      citationsMode: "on",
    });

    expect(result).toMatchObject({
      estimatedTokens: 1,
      systemPromptAddition: "## Memory Recall\ntools=memory_search,wiki_search\ncitations=on",
    });
  });

  it("forwards sessionKey to ingestBatch when afterTurn is absent", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingestBatch = vi.fn(
      async (_params: { sessionKey?: string; messages: AgentMessage[] }) => ({ ingestedCount: 1 }),
    );

    await finalizeTurn(sessionKey, createTestContextEngine({ bootstrap, assemble, ingestBatch }), {
      messagesSnapshot: [seedMessage, doneMessage],
      prePromptMessageCount: 1,
    });

    expectCalledWithSessionKey(ingestBatch, sessionKey);
  });

  it("forwards sessionKey to per-message ingest when ingestBatch is absent", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingest = vi.fn(async (_params: { sessionKey?: string; message: AgentMessage }) => ({
      ingested: true,
    }));

    await finalizeTurn(sessionKey, createTestContextEngine({ bootstrap, assemble, ingest }), {
      messagesSnapshot: [seedMessage, doneMessage],
      prePromptMessageCount: 1,
    });

    expect(ingest).toHaveBeenCalled();
    expect(
      ingest.mock.calls.every((call) => {
        const params = call[0];
        return params.sessionKey === sessionKey;
      }),
    ).toBe(true);
  });

  it("forwards silentExpected to the embedded subscription", async () => {
    const params = buildEmbeddedSubscriptionParams({
      session: {} as never,
      runId: "run-context-engine-forwarding",
      hookRunner: undefined,
      verboseLevel: undefined,
      reasoningMode: "off",
      toolResultFormat: undefined,
      shouldEmitToolResult: undefined,
      shouldEmitToolOutput: undefined,
      onToolResult: undefined,
      onReasoningStream: undefined,
      onReasoningEnd: undefined,
      onBlockReply: undefined,
      onBlockReplyFlush: undefined,
      blockReplyBreak: undefined,
      blockReplyChunking: undefined,
      onPartialReply: undefined,
      onAssistantMessageStart: undefined,
      onAgentEvent: undefined,
      enforceFinalTag: undefined,
      silentExpected: true,
      config: undefined,
      sessionKey,
      sessionId: embeddedSessionId,
      agentId: "main",
    });

    expect(params.silentExpected).toBe(true);
    expect(params.sessionKey).toBe(sessionKey);
  });

  it("skips maintenance when afterTurn fails", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const afterTurn = vi.fn(async () => {
      throw new Error("afterTurn failed");
    });

    await finalizeTurn(sessionKey, createTestContextEngine({ bootstrap, assemble, afterTurn }));

    expect(afterTurn).toHaveBeenCalled();
    expect(hoisted.runContextEngineMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn" }),
    );
  });

  it("runs startup maintenance for existing sessions even without bootstrap()", async () => {
    const { assemble } = createContextEngineBootstrapAndAssemble();

    await runBootstrap(
      sessionKey,
      createTestContextEngine({
        assemble,
        maintain: async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
          reason: "test maintenance",
        }),
      }),
    );

    expect(hoisted.runContextEngineMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "bootstrap" }),
    );
  });

  it("builds prompt-cache retention, last-call usage, and cache-touch metadata", () => {
    expect(
      buildContextEnginePromptCacheInfo({
        retention: "short",
        lastCallUsage: {
          input: 10,
          output: 5,
          cacheRead: 40,
          cacheWrite: 2,
          total: 57,
        },
        lastCacheTouchAt: 123,
      }),
    ).toEqual(
      expect.objectContaining({
        retention: "short",
        lastCallUsage: {
          input: 10,
          output: 5,
          cacheRead: 40,
          cacheWrite: 2,
          total: 57,
        },
        lastCacheTouchAt: 123,
      }),
    );
  });

  it("omits prompt-cache metadata when no cache data is available", () => {
    expect(buildContextEnginePromptCacheInfo({})).toBeUndefined();
  });

  it("does not reuse a prior turn's usage when the current attempt has no assistant", () => {
    const priorAssistant = {
      role: "assistant",
      content: "prior turn",
      timestamp: 2,
      usage: {
        input: 99,
        output: 7,
        cacheRead: 1234,
        total: 1340,
      },
    } as unknown as AgentMessage;
    const currentAttemptAssistant = findCurrentAttemptAssistantMessage({
      messagesSnapshot: [seedMessage, priorAssistant],
      prePromptMessageCount: 2,
    });
    const promptCache = buildContextEnginePromptCacheInfo({
      retention: "short",
      lastCallUsage: (currentAttemptAssistant as { usage?: undefined } | undefined)?.usage,
    });

    expect(currentAttemptAssistant).toBeUndefined();
    expect(promptCache).toEqual({ retention: "short" });
  });

  it("derives live loop prompt-cache info from the current attempt assistant", () => {
    const toolUseAssistant = {
      role: "assistant",
      content: "tool use",
      timestamp: "2026-04-16T16:49:59.536Z",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 39036,
        cacheWrite: 59934,
        total: 98973,
      },
    } as unknown as AgentMessage;

    expect(
      buildLoopPromptCacheInfo({
        messagesSnapshot: [seedMessage, toolUseAssistant],
        prePromptMessageCount: 1,
        retention: "short",
        fallbackLastCacheTouchAt: 123,
      }),
    ).toEqual(
      expect.objectContaining({
        retention: "short",
        lastCallUsage: expect.objectContaining({
          cacheRead: 39036,
          cacheWrite: 59934,
          total: 98973,
        }),
        lastCacheTouchAt: Date.parse("2026-04-16T16:49:59.536Z"),
      }),
    );
  });

  it("falls back to the persisted cache touch when loop usage has no cache metrics", () => {
    const toolUseAssistant = {
      role: "assistant",
      content: "tool use",
      timestamp: "2026-04-16T16:49:59.536Z",
      usage: {
        input: 1,
        output: 2,
        total: 3,
      },
    } as unknown as AgentMessage;

    expect(
      buildLoopPromptCacheInfo({
        messagesSnapshot: [seedMessage, toolUseAssistant],
        prePromptMessageCount: 1,
        retention: "short",
        fallbackLastCacheTouchAt: 123,
      }),
    ).toEqual(
      expect.objectContaining({
        retention: "short",
        lastCallUsage: expect.objectContaining({
          total: 3,
        }),
        lastCacheTouchAt: 123,
      }),
    );
  });

  it("derives a live cache touch timestamp for final afterTurn usage snapshots", () => {
    const lastCallUsage = {
      input: 1,
      output: 2,
      cacheRead: 39036,
      cacheWrite: 0,
      total: 39039,
    };

    expect(
      resolvePromptCacheTouchTimestamp({
        lastCallUsage,
        assistantTimestamp: "2026-04-16T17:04:46.974Z",
        fallbackLastCacheTouchAt: 123,
      }),
    ).toBe(Date.parse("2026-04-16T17:04:46.974Z"));
  });

  it("threads prompt-cache break observations into afterTurn", async () => {
    const afterTurn = vi.fn(async (_params: AfterTurnPromptCacheCall) => {});

    await finalizeTurn(sessionKey, createTestContextEngine({ afterTurn }), {
      runtimeContext: {
        promptCache: {
          observation: {
            broke: true,
            previousCacheRead: 5000,
            cacheRead: 2000,
            changes: [{ code: "systemPrompt", detail: "system prompt digest changed" }],
          },
        },
      },
    });

    const afterTurnCall = afterTurn.mock.calls.at(0)?.[0];
    const runtimeContext = afterTurnCall?.runtimeContext;
    const observation = runtimeContext?.promptCache?.observation as
      | { broke?: boolean; previousCacheRead?: number; cacheRead?: number; changes?: unknown[] }
      | undefined;

    expect(observation).toEqual(
      expect.objectContaining({
        broke: true,
        previousCacheRead: 5000,
        cacheRead: 2000,
        changes: expect.arrayContaining([expect.objectContaining({ code: "systemPrompt" })]),
      }),
    );
  });

  it("skips maintenance when ingestBatch fails", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingestBatch = vi.fn(async () => {
      throw new Error("ingestBatch failed");
    });

    await finalizeTurn(sessionKey, createTestContextEngine({ bootstrap, assemble, ingestBatch }), {
      messagesSnapshot: [seedMessage, doneMessage],
      prePromptMessageCount: 1,
    });

    expect(ingestBatch).toHaveBeenCalled();
    expect(hoisted.runContextEngineMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn" }),
    );
  });

  it("releases the session lock even when teardown cleanup throws", async () => {
    const releaseMock = vi.fn(async () => {});
    const disposeMock = vi.fn();
    const flushMock = vi.fn(async () => {
      throw new Error("flush failed");
    });

    await cleanupEmbeddedAttemptResources({
      removeToolResultContextGuard: () => {},
      flushPendingToolResultsAfterIdle: flushMock,
      session: { agent: {}, dispose: disposeMock },
      sessionManager: hoisted.sessionManager,
      releaseWsSession: hoisted.releaseWsSessionMock,
      sessionId: embeddedSessionId,
      bundleLspRuntime: undefined,
      sessionLock: { release: releaseMock },
    });

    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(hoisted.releaseWsSessionMock).toHaveBeenCalledWith("embedded-session");
  });
});
