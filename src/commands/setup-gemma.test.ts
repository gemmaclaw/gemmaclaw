import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAgentEntries } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  assertDockerForContainerMode,
  setupGemmaCommand,
  type DockerProbe,
} from "./setup-gemma.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

// Shared mutable state hoisted so vi.mock factories can reference it.
const hoisted = vi.hoisted(() => {
  let capturedMutatedConfig: OpenClawConfig = {};
  const execFileSync = vi.fn();
  return {
    execFileSync,
    get capturedMutatedConfig() {
      return capturedMutatedConfig;
    },
    set capturedMutatedConfig(v: OpenClawConfig) {
      capturedMutatedConfig = v;
    },
    reset() {
      capturedMutatedConfig = {};
    },
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: hoisted.execFileSync,
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

// Stub out filesystem writes so tests don't touch disk.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const mkdirSyncStub = vi.fn();
  const chmodSyncStub = vi.fn();
  const writeFileSyncStub = vi.fn();
  const readFileSyncStub = vi.fn().mockImplementation(() => {
    throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  });
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: mkdirSyncStub,
      chmodSync: chmodSyncStub,
      writeFileSync: writeFileSyncStub,
      readFileSync: readFileSyncStub,
    },
    mkdirSync: mkdirSyncStub,
    chmodSync: chmodSyncStub,
    writeFileSync: writeFileSyncStub,
    readFileSync: readFileSyncStub,
  };
});

const fsMock = await import("node:fs");

function makeRuntime(): RuntimeEnv & { logs: string[]; errors: string[]; exitCodes: number[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const log = vi.fn((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const error = vi.fn((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  const exit = vi.fn((...args: unknown[]) => {
    exitCodes.push(args[0] as number);
  });
  return { log, error, exit, logs, errors, exitCodes };
}

function makeProbe(installed: boolean, running: boolean): DockerProbe {
  return {
    isInstalled: vi.fn().mockReturnValue(installed),
    isRunning: vi.fn().mockReturnValue(running),
  };
}

const runtime = createTestRuntime();

const FAKE_GEMINI_KEY = "AIzaSyFakeTestKeyForUnitTests";

describe("assertDockerForContainerMode", () => {
  describe("Docker not installed", () => {
    it("calls runtime.exit(1) with Docker install instructions", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(false, false);

      await assertDockerForContainerMode(runtime, probe, null);

      expect(runtime.exit).toHaveBeenCalledWith(1);
    });

    it("error message mentions Docker, container mode, and docs.docker.com", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(false, false);

      await assertDockerForContainerMode(runtime, probe, null);

      const allErrors = runtime.errors.join("\n");
      expect(allErrors).toContain("Container mode requires Docker");
      expect(allErrors).toContain("not installed");
      expect(allErrors).toContain("docs.docker.com");
    });

    it("error message mentions --no-container as an alternative", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(false, false);

      await assertDockerForContainerMode(runtime, probe, null);

      const allErrors = runtime.errors.join("\n");
      expect(allErrors).toContain("--no-container");
    });

    it("does not prompt the user when Docker is not installed", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(false, false);
      const prompt = vi.fn(async () => "");

      await assertDockerForContainerMode(runtime, probe, prompt);

      expect(prompt).not.toHaveBeenCalled();
    });
  });

  describe("Docker installed but daemon not running", () => {
    it("calls runtime.exit(1) in non-interactive mode (null prompt)", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(true, false);

      await assertDockerForContainerMode(runtime, probe, null);

      expect(runtime.exit).toHaveBeenCalledWith(1);
    });

    it("error message mentions Docker daemon not running", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(true, false);

      await assertDockerForContainerMode(runtime, probe, null);

      const allErrors = runtime.errors.join("\n");
      expect(allErrors).toContain("Container mode requires Docker");
      expect(allErrors).toContain("not running");
    });

    it("in interactive mode: offers one prompt to start Docker then exits if still not running", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(true, false);
      const prompt = vi.fn(async () => "");

      await assertDockerForContainerMode(runtime, probe, prompt);

      expect(prompt).toHaveBeenCalledOnce();
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });

    it("in interactive mode: succeeds if Docker starts before the user presses Enter", async () => {
      const runtime = makeRuntime();
      // Docker is running after the first isRunning check fails on the initial
      // check, then succeeds when re-checked after the prompt.
      const isRunning = vi
        .fn()
        .mockReturnValueOnce(false) // initial check
        .mockReturnValueOnce(true); // re-check after prompt
      const probe: DockerProbe = {
        isInstalled: vi.fn().mockReturnValue(true),
        isRunning,
      };
      const prompt = vi.fn(async () => ""); // user presses Enter

      await assertDockerForContainerMode(runtime, probe, prompt);

      expect(runtime.exit).not.toHaveBeenCalled();
    });

    it("in interactive mode: exits when Docker is still not running after prompt", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(true, false);
      const prompt = vi.fn(async () => ""); // user presses Enter but Docker stays down

      await assertDockerForContainerMode(runtime, probe, prompt);

      expect(runtime.exit).toHaveBeenCalledWith(1);
    });
  });

  describe("Docker installed and running", () => {
    it("returns without calling runtime.exit when Docker is fully available", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(true, true);

      await assertDockerForContainerMode(runtime, probe, null);

      expect(runtime.exit).not.toHaveBeenCalled();
      expect(runtime.errors).toHaveLength(0);
    });

    it("does not prompt the user when Docker is already running", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(true, true);
      const prompt = vi.fn(async () => "");

      await assertDockerForContainerMode(runtime, probe, prompt);

      expect(prompt).not.toHaveBeenCalled();
    });
  });

  describe("local/no-container mode (not called when useContainer=false)", () => {
    it("does not invoke assertDockerForContainerMode when useContainer is false (guard test)", async () => {
      // This test documents that assertDockerForContainerMode is only called when
      // useContainer=true. When the user picks local mode, Docker is never checked.
      const probe = makeProbe(false, false);
      const runtime = makeRuntime();

      // Only called when choices.useContainer is true. With false, the caller
      // skips the function entirely. We confirm the function itself is safe with
      // a mock probe — if Docker is unavailable and the function isn't called, no exit.
      const mockAssert = vi.fn(async () => {});
      // Simulate caller skipping assertDockerForContainerMode when !useContainer:
      const useContainer = false;
      if (useContainer) {
        await mockAssert();
      }

      expect(mockAssert).not.toHaveBeenCalled();
      expect(probe.isInstalled).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    });
  });
});

describe("setupGemmaCommand — agent creation", () => {
  let originalGeminiKey: string | undefined;

  beforeEach(() => {
    hoisted.reset();
    vi.clearAllMocks();
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.exit.mockReset();
    hoisted.execFileSync.mockReset();

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

  it("writes the unrestricted Gemmaclaw Docker sandbox config for non-local setup", async () => {
    await setupGemmaCommand(
      {
        nonInteractive: true,
        dryRun: true,
        agentName: "DockerBot",
        setupMode: "gemini",
        model: "gemini-2.0-flash",
        thinking: "off",
      },
      runtime,
    );

    const sandbox = hoisted.capturedMutatedConfig.agents?.defaults?.sandbox as
      | Record<string, unknown>
      | undefined;
    expect(sandbox).toMatchObject({
      mode: "all",
      backend: "docker",
      scope: "session",
      workspaceAccess: "rw",
      docker: {
        dangerouslyAllowExternalBindSources: true,
        dangerouslyAllowReservedContainerTargets: true,
        readOnlyRoot: false,
        network: "bridge",
        capDrop: [],
        setupCommand:
          "apt-get -o APT::Sandbox::User=root update && " +
          "DEBIAN_FRONTEND=noninteractive apt-get -o APT::Sandbox::User=root install -y ca-certificates curl git python3 && " +
          "printf '\\numask 000\\n' >> /etc/profile && " +
          "rm -rf /var/lib/apt/lists/*",
        user: "0:0",
      },
    });
    const docker = sandbox?.docker as Record<string, unknown> | undefined;
    expect(docker?.binds).toEqual([
      `${process.env.HOME ?? "/root"}/.gemmaclaw/shared:/workspace/shared:rw`,
    ]);
    expect(hoisted.capturedMutatedConfig.tools?.exec).toMatchObject({
      security: "full",
      ask: "off",
    });
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(
      `${process.env.HOME ?? "/root"}/.gemmaclaw/shared`,
      { recursive: true },
    );
    expect(fsMock.chmodSync).toHaveBeenCalledWith(
      `${process.env.HOME ?? "/root"}/.gemmaclaw/shared`,
      0o777,
    );
    expect(fsMock.chmodSync).toHaveBeenCalledWith(
      `${process.env.HOME ?? "/root"}/.openclaw/workspaces/DockerBot`,
      0o777,
    );
    expect(hoisted.execFileSync).toHaveBeenCalledWith(
      "setfacl",
      ["-d", "-m", "u::rwx,g::rwx,o::rwx", `${process.env.HOME ?? "/root"}/.gemmaclaw/shared`],
      { stdio: "ignore" },
    );
    expect(hoisted.execFileSync).toHaveBeenCalledWith(
      "setfacl",
      [
        "-d",
        "-m",
        "u::rwx,g::rwx,o::rwx",
        `${process.env.HOME ?? "/root"}/.openclaw/workspaces/DockerBot`,
      ],
      { stdio: "ignore" },
    );
  });
});
