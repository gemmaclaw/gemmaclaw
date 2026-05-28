import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing as replyRunRegistryTesting,
  createReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetCronActiveJobsForTests } from "../cron/active-jobs.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT } from "./heartbeat-wake.js";
import { resetSystemEventsForTest, enqueueSystemEvent } from "./system-events.js";

vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

const noopOutbound = {
  deliveryMode: "direct" as const,
  sendText: async () => ({ channel: "telegram" as const, messageId: "1", chatId: "1" }),
  sendMedia: async () => ({ channel: "telegram" as const, messageId: "1", chatId: "1" }),
};

beforeAll(() => {
  previousRegistry = getActivePluginRegistry();
  const telegramPlugin = createOutboundTestPlugin({ id: "telegram", outbound: noopOutbound });
  const registry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
  ]);
  setActivePluginRegistry(registry);
});

afterAll(() => {
  if (previousRegistry) {
    setActivePluginRegistry(previousRegistry);
  }
});

beforeEach(() => {
  resetSystemEventsForTest();
  resetCronActiveJobsForTests();
  replyRunRegistryTesting.resetReplyRunRegistry();
});

function createHeartbeatTelegramConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        heartbeat: { every: "30m" },
        model: { primary: "test/model" },
      },
    },
    channels: {
      telegram: {
        enabled: true,
        token: "fake",
        allowFrom: ["123"],
      },
    },
  } as unknown as OpenClawConfig;
}

async function seedHeartbeatTelegramSession(storePath: string, cfg: OpenClawConfig) {
  return seedMainSessionStore(storePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "123",
  });
}

describe("heartbeat runner skips when target session lane is busy", () => {
  it("returns requests-in-flight when session lane has queued work", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      const sessionKey = await seedHeartbeatTelegramSession(storePath, cfg);

      enqueueSystemEvent("Exec completed (test-id, code 0) :: test output", {
        sessionKey,
      });

      // main lane idle (0), session lane busy (1)
      const getQueueSize = vi.fn((lane?: string) => {
        if (!lane || lane === "main") {
          return 0;
        }
        if (lane.startsWith("session:")) {
          return 1;
        }
        return 0;
      });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize,
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } as HeartbeatDeps,
      });

      expect(result.status).toBe("skipped");
      if (result.status === "skipped") {
        expect(result.reason).toBe("requests-in-flight");
      }
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("returns requests-in-flight when the target session has an active reply run", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      const sessionKey = await seedHeartbeatTelegramSession(storePath, cfg);
      const isReplyRunActive = vi.fn((key: string) => key === sessionKey);

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: vi.fn((_lane?: string) => 0),
          isReplyRunActive,
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } as HeartbeatDeps,
      });

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
      expect(isReplyRunActive).toHaveBeenCalledWith(sessionKey);
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("does not defer immediate heartbeat wakes for another active session", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      await seedHeartbeatTelegramSession(storePath, cfg);
      const listActiveReplyRunSessionKeys = vi.fn(() => [
        "agent:main:telegram:group:-1003966283270:topic:547",
      ]);
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: vi.fn((_lane?: string) => 0),
          listActiveReplyRunSessionKeys,
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } as HeartbeatDeps,
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
    });
  });

  it("returns requests-in-flight when a reply run is still active after queues drain", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      const sessionKey = await seedHeartbeatTelegramSession(storePath, cfg);
      const operation = createReplyOperation({
        sessionKey,
        sessionId: "active-reply-session",
        resetTriggered: false,
      });
      operation.setPhase("running");

      try {
        const result = await runHeartbeatOnce({
          cfg,
          deps: {
            getQueueSize: vi.fn((_lane?: string) => 0),
            nowMs: () => Date.now(),
            getReplyFromConfig: replySpy,
          } as HeartbeatDeps,
        });

        expect(result.status).toBe("skipped");
        if (result.status === "skipped") {
          expect(result.reason).toBe(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT);
        }
        expect(replySpy).not.toHaveBeenCalled();
      } finally {
        operation.complete();
      }
    });
  });

  it("returns requests-in-flight when an isolated heartbeat reply run is still active", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      cfg.agents!.defaults!.heartbeat = { every: "30m", isolatedSession: true };
      const baseSessionKey = await seedHeartbeatTelegramSession(storePath, cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const operation = createReplyOperation({
        sessionKey: isolatedSessionKey,
        sessionId: "active-isolated-reply-session",
        resetTriggered: false,
      });
      operation.setPhase("running");

      try {
        const result = await runHeartbeatOnce({
          cfg,
          deps: {
            getQueueSize: vi.fn((_lane?: string) => 0),
            nowMs: () => Date.now(),
            getReplyFromConfig: replySpy,
          } as HeartbeatDeps,
        });

        expect(result.status).toBe("skipped");
        if (result.status === "skipped") {
          expect(result.reason).toBe(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT);
        }
        expect(replySpy).not.toHaveBeenCalled();
      } finally {
        operation.complete();
      }
    });
  });

  it("proceeds normally when session lane is idle", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      await seedHeartbeatTelegramSession(storePath, cfg);

      // Both lanes idle
      const getQueueSize = vi.fn((_lane?: string) => 0);

      replySpy.mockResolvedValue({
        text: "HEARTBEAT_OK",
      });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize,
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } as HeartbeatDeps,
      });

      expect(replySpy).toHaveBeenCalled();
      expect(result.status).toBe("ran");
    });
  });

  it("returns requests-in-flight when the target session has an active reply run", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      const sessionKey = await seedHeartbeatTelegramSession(storePath, cfg);
      const isReplyRunActive = vi.fn((key: string) => key === sessionKey);

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: vi.fn((_lane?: string) => 0),
          isReplyRunActive,
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } as HeartbeatDeps,
      });

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
      expect(isReplyRunActive).toHaveBeenCalledWith(sessionKey);
      expect(replySpy).not.toHaveBeenCalled();
    });
  });
});
