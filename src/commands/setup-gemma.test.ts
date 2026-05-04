import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

// Shared mutable state hoisted so vi.mock factories can reference it.
const hoisted = vi.hoisted(() => {
  let capturedMutatedConfig: OpenClawConfig = {};
  return {
    get capturedMutatedConfig() {
      return capturedMutatedConfig;
    },
    set capturedMutatedConfig(v: OpenClawConfig) {
      capturedMutatedConfig = v;
    },
    containerEnv: false,
    reset() {
      capturedMutatedConfig = {};
      this.containerEnv = false;
    },
  };
});

vi.mock("../config/mutate.js", () => ({
  mutateConfigFile: vi.fn(async (params: { mutate: (draft: OpenClawConfig) => unknown }) => {
    const draft: OpenClawConfig = {};
    await params.mutate(draft);
    hoisted.capturedMutatedConfig = structuredClone(draft);
    return {
      path: "/tmp/test-openclaw.json",
      previousHash: null,
      snapshot: {},
      nextConfig: draft,
      result: undefined,
    };
  }),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => hoisted.capturedMutatedConfig),
}));

vi.mock("../gemmaclaw/provision/bootstrap-profiles.js", () => ({
  applyBootstrapProfile: vi.fn(),
}));

vi.mock("../gateway/net.js", () => ({
  isContainerEnvironment: vi.fn(() => hoisted.containerEnv),
}));

// Stub out filesystem writes so tests don't touch disk.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const mkdirSyncStub = vi.fn();
  const writeFileSyncStub = vi.fn();
  const readFileSyncStub = vi.fn().mockImplementation(() => {
    throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  });
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: mkdirSyncStub,
      writeFileSync: writeFileSyncStub,
      readFileSync: readFileSyncStub,
    },
    mkdirSync: mkdirSyncStub,
    writeFileSync: writeFileSyncStub,
    readFileSync: readFileSyncStub,
  };
});

import { listAgentEntries } from "../agents/agent-scope.js";
import { setupGemmaCommand } from "./setup-gemma.js";

const runtime = createTestRuntime();

const FAKE_GEMINI_KEY = "AIzaSyFakeTestKeyForUnitTests";

describe("setupGemmaCommand — agent creation", () => {
  let originalGeminiKey: string | undefined;

  beforeEach(() => {
    hoisted.reset();
    vi.clearAllMocks();
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.exit.mockReset();

    originalGeminiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = FAKE_GEMINI_KEY;
  });

  afterEach(() => {
    hoisted.reset();
    if (originalGeminiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    }
  });

  it("writes the named agent to agents.list when using the Gemini backend", async () => {
    await setupGemmaCommand(
      {
        nonInteractive: true,
        dryRun: true,
        agentName: "Steve",
        setupMode: "gemini",
        model: "gemini-2.0-flash",
        thinking: "off",
        noContainer: true,
      },
      runtime,
    );

    expect(runtime.exit).not.toHaveBeenCalled();

    const cfg = hoisted.capturedMutatedConfig;
    const entries = listAgentEntries(cfg);
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries.find((e) => e.id === "steve");
    expect(entry).toBeDefined();
    expect(entry?.name).toBe("Steve");
  });

  it("defaults sandbox.mode to off when setup runs inside a container", async () => {
    hoisted.containerEnv = true;

    await setupGemmaCommand(
      {
        nonInteractive: true,
        dryRun: true,
        agentName: "ContainerBot",
        setupMode: "gemini",
        model: "gemini-2.0-flash",
        thinking: "off",
      },
      runtime,
    );

    const cfg = hoisted.capturedMutatedConfig;
    expect(cfg.agents?.defaults?.sandbox?.mode).toBe("off");
    expect(runtime.log).toHaveBeenCalledWith(
      "Container environment detected; defaulting sandbox.mode=off.",
    );
  });

  it("defaults sandbox runs to all tools available", async () => {
    await setupGemmaCommand(
      {
        nonInteractive: true,
        dryRun: true,
        agentName: "ToolBot",
        setupMode: "gemini",
        model: "gemini-2.0-flash",
        thinking: "off",
      },
      runtime,
    );

    const cfg = hoisted.capturedMutatedConfig;
    expect(cfg.tools?.sandbox?.tools?.allow).toEqual([]);
    expect(cfg.tools?.sandbox?.tools?.deny).toEqual([]);
    expect(cfg.tools?.exec?.security).toBe("full");
    expect(cfg.tools?.exec?.ask).toBe("off");
  });

  it("produces an agents.list readable by listAgentEntries (same function used by gemmaclaw list)", async () => {
    await setupGemmaCommand(
      {
        nonInteractive: true,
        dryRun: true,
        agentName: "SetupAgent",
        setupMode: "gemini",
        model: "gemini-2.5-pro",
        thinking: "medium",
        noContainer: true,
      },
      runtime,
    );

    const cfg = hoisted.capturedMutatedConfig;
    const ids = listAgentEntries(cfg).map((e) => e.id);
    expect(ids).toContain("setupagent");
  });

  it("normalizes the agent id to lowercase but preserves the display name", async () => {
    await setupGemmaCommand(
      {
        nonInteractive: true,
        dryRun: true,
        agentName: "WorkBot",
        setupMode: "gemini",
        model: "gemini-2.0-flash",
        thinking: "off",
        noContainer: true,
      },
      runtime,
    );

    const cfg = hoisted.capturedMutatedConfig;
    const entries = listAgentEntries(cfg);
    const entry = entries.find((e) => e.id === "workbot");
    expect(entry).toBeDefined();
    expect(entry?.name).toBe("WorkBot");
  });

  it("records agent workspace and agentDir in the written config entry", async () => {
    await setupGemmaCommand(
      {
        nonInteractive: true,
        dryRun: true,
        agentName: "DevBot",
        setupMode: "gemini",
        model: "gemini-2.0-flash",
        thinking: "off",
        noContainer: true,
      },
      runtime,
    );

    const cfg = hoisted.capturedMutatedConfig;
    const entry = listAgentEntries(cfg).find((e) => e.id === "devbot");
    expect(entry).toBeDefined();
    expect(typeof entry?.workspace).toBe("string");
    expect(entry?.workspace?.length).toBeGreaterThan(0);
    expect(typeof entry?.agentDir).toBe("string");
    expect(entry?.agentDir?.length).toBeGreaterThan(0);
  });
});
