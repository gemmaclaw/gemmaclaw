import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentsSshCommand, resolveAgentsSshInfo } from "./agents.commands.ssh.js";

const mocks = vi.hoisted(() => ({
  requireValidConfigMock: vi.fn(),
  buildAgentSummariesMock: vi.fn(),
  readRegistryMock: vi.fn(),
  resolveSandboxConfigForAgentMock: vi.fn(),
  spawnSyncMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("./agents.command-shared.js", () => ({
  requireValidConfig: mocks.requireValidConfigMock,
}));

vi.mock("./agents.config.js", () => ({
  buildAgentSummaries: mocks.buildAgentSummariesMock,
}));

vi.mock("../agents/sandbox/registry.js", () => ({
  readRegistry: mocks.readRegistryMock,
}));

vi.mock("../agents/sandbox/config.js", () => ({
  resolveSandboxConfigForAgent: mocks.resolveSandboxConfigForAgentMock,
}));

vi.mock("node:child_process", async () => {
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...original,
    spawnSync: mocks.spawnSyncMock,
  };
});

const baseCfg = { agents: { list: [{ id: "main" }] } };

describe("agentsSshCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mocks.requireValidConfigMock.mockResolvedValue(baseCfg);
    mocks.buildAgentSummariesMock.mockReturnValue([
      { id: "main", isDefault: true, workspace: "/w", agentDir: "/a", bindings: 0 },
    ]);
    mocks.readRegistryMock.mockResolvedValue({ entries: [] });
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({
      mode: "off",
      backend: "docker",
    });
    // spawnSync for version check returns failure by default (no docker)
    mocks.spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
  });

  it("errors when config is unavailable", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(null);
    await agentsSshCommand({ agent: "main" }, mocks.runtime);
    expect(mocks.runtime.error).not.toHaveBeenCalled();
  });

  it("errors for unknown agent name", async () => {
    mocks.buildAgentSummariesMock.mockReturnValue([
      { id: "main", isDefault: true, workspace: "/w", agentDir: "/a", bindings: 0 },
    ]);
    await agentsSshCommand({ agent: "nonexistent" }, mocks.runtime);
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining('"nonexistent" is not registered'),
    );
  });

  it("resolves a display name through normalized agent id logic", async () => {
    mocks.buildAgentSummariesMock.mockReturnValue([
      {
        id: "steve",
        name: "Steve",
        isDefault: false,
        workspace: "/w",
        agentDir: "/a",
        bindings: 0,
      },
    ]);
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "off", backend: "docker" });

    await agentsSshCommand({ agent: "Steve" }, mocks.runtime);

    expect(mocks.resolveSandboxConfigForAgentMock).toHaveBeenCalledWith(baseCfg, "steve");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("not have a container-backed sandbox"),
    );
  });

  it("errors when agent sandbox mode is off", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "off", backend: "docker" });
    await agentsSshCommand({ agent: "main" }, mocks.runtime);
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("not have a container-backed sandbox"),
    );
  });

  it("errors when sandbox backend is not docker", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "all", backend: "ssh" });
    await agentsSshCommand({ agent: "main" }, mocks.runtime);
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("not have a container-backed sandbox"),
    );
  });

  it("errors when no containers found in registry", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "all", backend: "docker" });
    mocks.readRegistryMock.mockResolvedValue({ entries: [] });
    await agentsSshCommand({ agent: "main" }, mocks.runtime);
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("No containers found"),
    );
  });

  it("errors when container is not running", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "all", backend: "docker" });
    mocks.readRegistryMock.mockResolvedValue({
      entries: [
        {
          containerName: "openclaw-sbx-main-abc",
          sessionKey: "agent:main",
          backendId: "docker",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: "test",
        },
      ],
    });
    // docker is installed but container not running
    mocks.spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes("--version")) {
        return { status: 0, stdout: "docker version 24.0", stderr: "" };
      }
      if (args.includes("inspect")) {
        return { status: 0, stdout: "false\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    await agentsSshCommand({ agent: "main" }, mocks.runtime);
    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining("not running"));
  });

  it("opens a docker exec shell for a running registered container", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "all", backend: "docker" });
    mocks.readRegistryMock.mockResolvedValue({
      entries: [
        {
          containerName: "openclaw-sbx-main-abc",
          sessionKey: "agent:main",
          backendId: "docker",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: "test",
        },
      ],
    });
    mocks.spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "docker" && args.includes("--version")) {
        return { status: 0, stdout: "docker version 24.0", stderr: "" };
      }
      if (cmd === "docker" && args.includes("inspect")) {
        return { status: 0, stdout: "true\n", stderr: "" };
      }
      if (cmd === "docker" && args[0] === "exec" && args.includes("/bin/bash")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    await agentsSshCommand({ agent: "main" }, mocks.runtime);

    expect(mocks.spawnSyncMock).toHaveBeenCalledWith(
      "docker",
      ["exec", "-it", "openclaw-sbx-main-abc", "/bin/bash"],
      { stdio: "inherit" },
    );
    expect(mocks.runtime.error).not.toHaveBeenCalled();
  });

  it("preserves bash exit code without sh fallback when bash exits nonzero", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "all", backend: "docker" });
    mocks.readRegistryMock.mockResolvedValue({
      entries: [
        {
          containerName: "openclaw-sbx-main-abc",
          sessionKey: "agent:main",
          backendId: "docker",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: "test",
        },
      ],
    });
    mocks.spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "docker" && args.includes("--version")) {
        return { status: 0, stdout: "docker version 24.0", stderr: "" };
      }
      if (cmd === "docker" && args.includes("inspect")) {
        return { status: 0, stdout: "true\n", stderr: "" };
      }
      if (cmd === "docker" && args[0] === "exec" && args.includes("/bin/bash")) {
        return { status: 2, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    await agentsSshCommand({ agent: "main" }, mocks.runtime);

    // Should NOT fall back to /bin/sh for a plain nonzero exit
    const execCalls = mocks.spawnSyncMock.mock.calls.filter(
      (call) => call[0] === "docker" && call[1][0] === "exec",
    );
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0][1]).toContain("/bin/bash");
    expect(process.exitCode).toBe(2);
  });

  it("falls back to /bin/sh when bash exits with code 127 (not found in container)", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "all", backend: "docker" });
    mocks.readRegistryMock.mockResolvedValue({
      entries: [
        {
          containerName: "openclaw-sbx-main-abc",
          sessionKey: "agent:main",
          backendId: "docker",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: "test",
        },
      ],
    });
    mocks.spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "docker" && args.includes("--version")) {
        return { status: 0, stdout: "docker version 24.0", stderr: "" };
      }
      if (cmd === "docker" && args.includes("inspect")) {
        return { status: 0, stdout: "true\n", stderr: "" };
      }
      if (cmd === "docker" && args[0] === "exec" && args.includes("/bin/bash")) {
        return { status: 127, stdout: "", stderr: "bash: not found" };
      }
      if (cmd === "docker" && args[0] === "exec" && args.includes("/bin/sh")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    await agentsSshCommand({ agent: "main" }, mocks.runtime);

    const execCalls = mocks.spawnSyncMock.mock.calls.filter(
      (call) => call[0] === "docker" && call[1][0] === "exec",
    );
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0][1]).toContain("/bin/bash");
    expect(execCalls[1][1]).toContain("/bin/sh");
    expect(mocks.runtime.error).not.toHaveBeenCalled();
  });

  it("fails with usage text and eligible agents in non-interactive mode with no agent", async () => {
    mocks.buildAgentSummariesMock.mockReturnValue([
      { id: "main", isDefault: true, workspace: "/w", agentDir: "/a", bindings: 0 },
      { id: "work", isDefault: false, workspace: "/w2", agentDir: "/a2", bindings: 0 },
    ]);
    mocks.resolveSandboxConfigForAgentMock
      .mockReturnValueOnce({ mode: "all", backend: "docker" })
      .mockReturnValueOnce({ mode: "off", backend: "docker" });
    mocks.readRegistryMock.mockResolvedValue({
      entries: [
        {
          containerName: "openclaw-sbx-main-abc",
          sessionKey: "agent:main",
          backendId: "docker",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: "test",
        },
      ],
    });
    mocks.spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "docker" && args.includes("--version")) {
        return { status: 0, stdout: "docker 24", stderr: "" };
      }
      if (cmd === "docker" && args.includes("inspect")) {
        return { status: 0, stdout: "true\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    await agentsSshCommand({ nonInteractive: true }, mocks.runtime);

    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining("No agent specified"));
    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining("gemmaclaw ssh main"));
  });

  it("errors when no agents configured", async () => {
    mocks.buildAgentSummariesMock.mockReturnValue([]);
    await agentsSshCommand({ nonInteractive: true }, mocks.runtime);
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("No agents configured"),
    );
  });
});

describe("resolveAgentsSshInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readRegistryMock.mockResolvedValue({ entries: [] });
  });

  it("returns not container-backed for mode=off", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "off", backend: "docker" });
    const result = await resolveAgentsSshInfo(["main"], baseCfg);
    const info = result.get("main");
    expect(info?.containerBacked).toBe(false);
    expect(info?.unavailableReason).toContain("off");
  });

  it("returns not container-backed for non-docker backend", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "all", backend: "ssh" });
    const result = await resolveAgentsSshInfo(["main"], baseCfg);
    const info = result.get("main");
    expect(info?.containerBacked).toBe(false);
    expect(info?.unavailableReason).toContain('"ssh"');
  });

  it("returns containerBacked=true with empty containers for docker-mode with no registry entries", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "all", backend: "docker" });
    mocks.readRegistryMock.mockResolvedValue({ entries: [] });
    mocks.spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
    const result = await resolveAgentsSshInfo(["main"], baseCfg);
    const info = result.get("main");
    expect(info?.containerBacked).toBe(true);
    expect(info?.containers).toHaveLength(0);
  });

  it("finds containers for agent:main session key", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "all", backend: "docker" });
    mocks.readRegistryMock.mockResolvedValue({
      entries: [
        {
          containerName: "openclaw-sbx-main-abc",
          sessionKey: "agent:main",
          backendId: "docker",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: "test",
        },
        {
          containerName: "openclaw-sbx-work-def",
          sessionKey: "agent:work",
          backendId: "docker",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: "test",
        },
      ],
    });
    mocks.spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
    const result = await resolveAgentsSshInfo(["main"], baseCfg);
    const info = result.get("main");
    expect(info?.containers).toHaveLength(1);
    expect(info?.containers[0].containerName).toBe("openclaw-sbx-main-abc");
  });

  it("handles multiple agents in one call", async () => {
    mocks.resolveSandboxConfigForAgentMock
      .mockReturnValueOnce({ mode: "all", backend: "docker" })
      .mockReturnValueOnce({ mode: "off", backend: "docker" });
    mocks.readRegistryMock.mockResolvedValue({ entries: [] });
    mocks.spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
    const result = await resolveAgentsSshInfo(["main", "work"], baseCfg);
    expect(result.get("main")?.containerBacked).toBe(true);
    expect(result.get("work")?.containerBacked).toBe(false);
  });

  it("marks container running=true when docker inspect returns true", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "all", backend: "docker" });
    mocks.readRegistryMock.mockResolvedValue({
      entries: [
        {
          containerName: "openclaw-sbx-main-abc",
          sessionKey: "agent:main",
          backendId: "docker",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: "test",
        },
      ],
    });
    mocks.spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes("--version")) {
        return { status: 0, stdout: "docker 24", stderr: "" };
      }
      if (args.includes("inspect")) {
        return { status: 0, stdout: "true\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    const result = await resolveAgentsSshInfo(["main"], baseCfg);
    const info = result.get("main");
    expect(info?.containerBacked).toBe(true);
    expect(info?.containers[0].running).toBe(true);
  });

  it("marks container running=false when docker inspect returns false", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "all", backend: "docker" });
    mocks.readRegistryMock.mockResolvedValue({
      entries: [
        {
          containerName: "openclaw-sbx-main-abc",
          sessionKey: "agent:main",
          backendId: "docker",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: "test",
        },
      ],
    });
    mocks.spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes("--version")) {
        return { status: 0, stdout: "docker 24", stderr: "" };
      }
      if (args.includes("inspect")) {
        return { status: 0, stdout: "false\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    const result = await resolveAgentsSshInfo(["main"], baseCfg);
    const info = result.get("main");
    expect(info?.containerBacked).toBe(true);
    expect(info?.containers[0].running).toBe(false);
  });

  it("marks registry entries as missing when docker inspect fails", async () => {
    mocks.resolveSandboxConfigForAgentMock.mockReturnValue({ mode: "all", backend: "docker" });
    mocks.readRegistryMock.mockResolvedValue({
      entries: [
        {
          containerName: "openclaw-sbx-main-abc",
          sessionKey: "agent:main",
          backendId: "docker",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: "test",
        },
      ],
    });
    mocks.spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "docker" && args.includes("--version")) {
        return { status: 0, stdout: "docker 24", stderr: "" };
      }
      if (cmd === "docker" && args.includes("inspect")) {
        return { status: 1, stdout: "", stderr: "No such container" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const result = await resolveAgentsSshInfo(["main"], baseCfg);
    const info = result.get("main");

    expect(info?.containers[0]).toMatchObject({ exists: false, running: false });
    expect(info?.shellAvailable).toBe(false);
    expect(info?.shellUnavailableReason).toContain("missing");
  });
});
