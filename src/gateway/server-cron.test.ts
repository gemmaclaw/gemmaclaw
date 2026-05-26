import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

const {
  enqueueSystemEventMock,
  requestHeartbeatNowMock,
  runHeartbeatOnceMock,
  loadConfigMock,
  fetchWithSsrFGuardMock,
  runCronIsolatedAgentTurnMock,
  cleanupBrowserSessionsForLifecycleEndMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  requestHeartbeatNowMock: vi.fn(),
  runHeartbeatOnceMock: vi.fn<
    (...args: unknown[]) => Promise<{ status: "ran"; durationMs: number }>
  >(async () => ({ status: "ran", durationMs: 1 })),
  loadConfigMock: vi.fn(),
  fetchWithSsrFGuardMock: vi.fn(),
  runCronIsolatedAgentTurnMock: vi.fn(async () => ({ status: "ok" as const, summary: "ok" })),
  cleanupBrowserSessionsForLifecycleEndMock: vi.fn(async () => {}),
}));

function enqueueSystemEvent(...args: unknown[]) {
  return enqueueSystemEventMock(...args);
}

function requestHeartbeatNow(...args: unknown[]) {
  return requestHeartbeatNowMock(...args);
}

function runHeartbeatOnce(...args: unknown[]) {
  return runHeartbeatOnceMock(...args);
}

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
}));

vi.mock("../infra/heartbeat-wake.js", async () => {
  return await mergeMockedModule(
    await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
      "../infra/heartbeat-wake.js",
    ),
    () => ({
      requestHeartbeatNow,
    }),
  );
});

vi.mock("../infra/heartbeat-runner.js", () => ({
  runHeartbeatOnce,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: cleanupBrowserSessionsForLifecycleEndMock,
}));

import { buildGatewayCronService } from "./server-cron.js";

function createCronConfig(name: string): OpenClawConfig {
  const tmpDir = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  return {
    session: {
      mainKey: "main",
    },
    cron: {
      store: path.join(tmpDir, "cron.json"),
    },
  } as OpenClawConfig;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function callArg(
  mock: { mock: { calls: Array<Array<unknown>> } },
  callIndex: number,
  argIndex: number,
  label: string,
) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call: ${label}`);
  }
  if (argIndex >= call.length) {
    throw new Error(`Expected mock call argument ${argIndex}: ${label}`);
  }
  return call[argIndex];
}

function expectIsolatedRunFields(fields: Record<string, unknown>) {
  const options = requireRecord(
    callArg(runCronIsolatedAgentTurnMock, 0, 0, "isolated cron run"),
    "isolated cron run",
  );
  for (const [key, value] of Object.entries(fields)) {
    expect(options[key]).toEqual(value);
  }
  return options;
}

function expectCleanupForSessionKeys(sessionKeys: string[]) {
  expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledTimes(1);
  const options = requireRecord(
    callArg(cleanupBrowserSessionsForLifecycleEndMock, 0, 0, "cleanup options"),
    "cleanup options",
  );
  expect(options.sessionKeys).toEqual(sessionKeys);
  expect(options.onWarn).toBeTypeOf("function");
}

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    runHeartbeatOnceMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    runCronIsolatedAgentTurnMock.mockClear();
    cleanupBrowserSessionsForLifecycleEndMock.mockClear();
  });

  it("routes main-target jobs to the scoped session for enqueue + wake", async () => {
    const cfg = createCronConfig("server-cron");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "canonicalize-session-key",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "discord:channel:ops",
        payload: { kind: "systemEvent", text: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("forwards heartbeat overrides through the cron wake adapter", () => {
    const cfg = createCronConfig("server-cron-heartbeat-override");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const cronDeps = (
        state.cron as unknown as {
          state?: {
            deps?: {
              requestHeartbeatNow?: (opts?: {
                agentId?: string;
                sessionKey?: string | null;
                reason?: string;
                heartbeat?: { target?: string };
              }) => void;
            };
          };
        }
      ).state?.deps;

      cronDeps?.requestHeartbeatNow?.({
        reason: "cron:test",
        sessionKey: "discord:channel:ops",
        heartbeat: { target: "last" },
      });

      expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
        reason: "cron:test",
        agentId: "main",
        sessionKey: "agent:main:discord:channel:ops",
        heartbeat: { target: "last" },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("preserves trust downgrades when cron enqueues system events", () => {
    const cfg = createCronConfig("server-cron-untrusted");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const cronDeps = (
        state.cron as unknown as {
          state?: {
            deps?: {
              enqueueSystemEvent?: (
                optsText: string,
                opts?: {
                  agentId?: string;
                  sessionKey?: string;
                  contextKey?: string;
                  trusted?: boolean;
                },
              ) => void;
            };
          };
        }
      ).state?.deps;

      cronDeps?.enqueueSystemEvent?.("hello", {
        sessionKey: "discord:channel:ops",
        contextKey: "cron:test",
        trusted: false,
      });

      expect(enqueueSystemEventMock).toHaveBeenCalledWith("hello", {
        sessionKey: "agent:main:discord:channel:ops",
        contextKey: "cron:test",
        trusted: false,
      });
    } finally {
      state.cron.stop();
    }
  });

  it("blocks private webhook URLs via SSRF-guarded fetch", async () => {
    const cfg = createCronConfig("server-cron-ssrf");
    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "ssrf-webhook-blocked",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: {
          mode: "webhook",
          to: "http://127.0.0.1:8080/cron-finished",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8080/cron-finished",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: expect.stringContaining('"action":"finished"'),
          signal: expect.any(AbortSignal),
        },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("passes opaque custom session targets through to isolated cron runs", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-custom-session-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const sessionKey = "agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";
      const job = await state.cron.add({
        name: "custom-session",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: `session:${sessionKey}`,
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
      });

      await state.cron.run(job.id, "force");

      const options = expectIsolatedRunFields({ sessionKey });
      expect(requireRecord(options.job, "isolated job").id).toBe(job.id);
      expectCleanupForSessionKeys([sessionKey]);
    } finally {
      state.cron.stop();
    }
  });

  it("uses a dedicated cron session key for isolated jobs with model overrides", async () => {
    const cfg = createCronConfig("server-cron-isolated-key");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "isolated-model-override",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "agentTurn",
          message: "run report",
          model: "ollama/kimi-k2.5:cloud",
        },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          sessionKey: `cron:${job.id}`,
        }),
      );
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "main",
        }),
      );
      expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledWith({
        sessionKeys: [`cron:${job.id}`],
        onWarn: expect.any(Function),
      });
    } finally {
      state.cron.stop();
    }
  });

  it("preserves explicit isolated agent workspace when runtime reload config is stale", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-agent-workspace-${Date.now()}`);
    const startupCfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
      agents: {
        defaults: {
          workspace: path.join(tmpDir, "workspace"),
        },
        list: [
          { id: "main", default: true },
          { id: "yinze", workspace: path.join(tmpDir, "workspace-yinze") },
        ],
      },
    } as OpenClawConfig;
    const reloadedCfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
      agents: {
        defaults: {
          workspace: path.join(tmpDir, "workspace"),
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(reloadedCfg);

    const state = buildGatewayCronService({
      cfg: startupCfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "isolated-subagent-workspace",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        agentId: "yinze",
        payload: { kind: "agentTurn", message: "read SOW.md" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "yinze",
          cfg: expect.objectContaining({
            agents: expect.objectContaining({
              list: expect.arrayContaining([
                expect.objectContaining({
                  id: "yinze",
                  workspace: path.join(tmpDir, "workspace-yinze"),
                }),
              ]),
            }),
          }),
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("preserves agent heartbeat overrides when runtime reload config is stale", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-agent-heartbeat-${Date.now()}`);
    const startupCfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
      agents: {
        defaults: {
          workspace: path.join(tmpDir, "workspace"),
          heartbeat: {
            target: "main",
            deliveryFormat: "text",
          },
        },
        list: [
          { id: "main", default: true },
          {
            id: "yinze",
            workspace: path.join(tmpDir, "workspace-yinze"),
            heartbeat: {
              target: "last",
              deliveryFormat: "markdown",
            },
          },
        ],
      },
    } as OpenClawConfig;
    const reloadedCfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
      agents: {
        defaults: {
          workspace: path.join(tmpDir, "workspace"),
          heartbeat: {
            target: "main",
            deliveryFormat: "text",
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(reloadedCfg);

    const state = buildGatewayCronService({
      cfg: startupCfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const cronDeps = (
        state.cron as unknown as {
          state?: {
            deps?: {
              runHeartbeatOnce?: (opts?: {
                agentId?: string;
                sessionKey?: string | null;
                heartbeat?: Record<string, unknown>;
              }) => Promise<unknown>;
            };
          };
        }
      ).state?.deps;
      await cronDeps?.runHeartbeatOnce?.({
        agentId: "yinze",
        sessionKey: "agent:yinze:main",
        heartbeat: {},
      });

      expect(runHeartbeatOnceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "yinze",
          cfg: expect.objectContaining({
            agents: expect.objectContaining({
              list: expect.arrayContaining([
                expect.objectContaining({
                  id: "yinze",
                  heartbeat: expect.objectContaining({
                    target: "last",
                    deliveryFormat: "markdown",
                  }),
                }),
              ]),
            }),
          }),
          heartbeat: expect.objectContaining({
            target: "last",
            deliveryFormat: "markdown",
          }),
        }),
      );
    } finally {
      state.cron.stop();
    }
  });
});
