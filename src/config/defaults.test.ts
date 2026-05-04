import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBundledProviderPolicySurfaceCache } from "../plugins/provider-public-artifacts.js";
import { resetBundledPluginPublicArtifactLoaderForTest } from "../plugins/public-surface-loader.js";
import { DEFAULT_AGENT_MAX_CONCURRENT, DEFAULT_SUBAGENT_MAX_CONCURRENT } from "./agent-limits.js";
import {
  applyAgentDefaults,
  applyContextPruningDefaults,
  applyMessageDefaults,
} from "./defaults.js";

describe("config defaults", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", "");
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "");
    clearBundledProviderPolicySurfaceCache();
    resetBundledPluginPublicArtifactLoaderForTest();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearBundledProviderPolicySurfaceCache();
    resetBundledPluginPublicArtifactLoaderForTest();
  });

  it("skips provider defaults when agent defaults are absent", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
          },
        },
      },
    };

    expect(applyContextPruningDefaults(cfg as never)).toBe(cfg);
  });

  it("skips provider defaults when agent defaults have no Anthropic auth signal", () => {
    const cfg = {
      agents: {
        defaults: {},
      },
    };

    expect(applyContextPruningDefaults(cfg as never)).toBe(cfg);
  });

  it("uses anthropic provider defaults when agent defaults and auth signal exist", () => {
    const cfg = {
      auth: {
        profiles: {
          anthropic: { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: {
        defaults: {},
      },
    };

    const nextCfg = applyContextPruningDefaults(cfg as never);

    expect(nextCfg).not.toBe(cfg);
    expect(nextCfg.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
  });

  it("defaults ackReactionScope without deriving other message fields", () => {
    const next = applyMessageDefaults({
      agents: {
        list: [
          {
            id: "main",
            identity: {
              name: "Samantha",
              theme: "helpful sloth",
              emoji: "🦥",
            },
          },
        ],
      },
      messages: {},
    } as never);

    expect(next.messages?.ackReactionScope).toBe("group-mentions");
    expect(next.messages?.responsePrefix).toBeUndefined();
    expect(next.messages?.groupChat?.mentionPatterns).toBeUndefined();
  });

  it("fills missing agent concurrency defaults", () => {
    const next = applyAgentDefaults({ messages: {} } as never);

    expect(next.agents?.defaults?.maxConcurrent).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(next.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });
});
