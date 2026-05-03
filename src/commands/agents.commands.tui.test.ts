import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildTuiAgentLaunchResult,
  deriveAgentTuiPort,
  findProcessesOnPort,
  isContainerBackedAgent,
  launchTuiAgent,
  resolveAgentTuiPort,
  resolveTuiAgent,
  resolveTuiPortRegistryPath,
  TUI_AGENT_PORT_END,
  TUI_AGENT_PORT_START,
} from "./agents.commands.tui.js";

const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

function cfgWithAgents(
  agents: Array<{ id: string; name?: string; sandbox?: Record<string, unknown> }>,
  defaults: Record<string, unknown> = {},
): OpenClawConfig {
  return {
    agents: {
      defaults,
      list: agents,
    },
  } as OpenClawConfig;
}

function makeTempEnv(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gemmaclaw-tui-test-"));
  return { ...process.env, HOME: home, GEMMACLAW_HOME: path.join(home, ".gemmaclaw") };
}

function findHashCollision(): [string, string] {
  const seen = new Map<number, string>();
  for (let i = 0; i < 10_000; i += 1) {
    const id = `agent-${String(i)}`;
    const port = deriveAgentTuiPort(id);
    const previous = seen.get(port);
    if (previous) {
      return [previous, id];
    }
    seen.set(port, id);
  }
  throw new Error("test fixture could not find hash collision");
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deriveAgentTuiPort", () => {
  it("returns a deterministic port in [9100, 9199]", () => {
    for (const id of ["work", "play", "main", "steve", "x"]) {
      const port = deriveAgentTuiPort(id);
      expect(port).toBeGreaterThanOrEqual(TUI_AGENT_PORT_START);
      expect(port).toBeLessThanOrEqual(TUI_AGENT_PORT_END);
      expect(deriveAgentTuiPort(id)).toBe(port);
    }
  });

  it("normalises agent ids the same way as other helpers", () => {
    expect(deriveAgentTuiPort("Work")).toBe(deriveAgentTuiPort("work"));
    expect(deriveAgentTuiPort("  play  ")).toBe(deriveAgentTuiPort("play"));
  });
});

describe("resolveAgentTuiPort", () => {
  it("persists the same agent port under ~/.gemmaclaw", () => {
    const env = makeTempEnv();
    const first = resolveAgentTuiPort({ agentId: "work", env });
    const second = resolveAgentTuiPort({ agentId: "work", env });

    expect(second).toBe(first);
    const registryPath = resolveTuiPortRegistryPath(env);
    expect(registryPath).toContain(".gemmaclaw");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
      agents: Record<string, { port: number }>;
    };
    expect(registry.agents.work.port).toBe(first);
  });

  it("linearly probes when two agents hash to the same preferred port", () => {
    const env = makeTempEnv();
    const [firstId, secondId] = findHashCollision();

    const first = resolveAgentTuiPort({ agentId: firstId, env });
    const second = resolveAgentTuiPort({ agentId: secondId, env });

    expect(deriveAgentTuiPort(firstId)).toBe(deriveAgentTuiPort(secondId));
    expect(second).not.toBe(first);
    expect(second).toBeGreaterThanOrEqual(TUI_AGENT_PORT_START);
    expect(second).toBeLessThanOrEqual(TUI_AGENT_PORT_END);
  });

  it("rejects an override assigned to another agent", () => {
    const env = makeTempEnv();
    resolveAgentTuiPort({ agentId: "work", overridePort: 9123, env });

    expect(() => resolveAgentTuiPort({ agentId: "play", overridePort: 9123, env })).toThrow(
      /already assigned to agent "work"/,
    );
  });
});

describe("isContainerBackedAgent", () => {
  it("returns false for undefined config or sandbox mode off", () => {
    expect(isContainerBackedAgent(undefined, "work")).toBe(false);
    expect(isContainerBackedAgent({} as OpenClawConfig, "work")).toBe(false);
    expect(
      isContainerBackedAgent(
        cfgWithAgents([{ id: "work" }], { sandbox: { mode: "off", backend: "docker" } }),
        "work",
      ),
    ).toBe(false);
  });

  it("returns true for an effective docker sandbox", () => {
    const cfg = cfgWithAgents([{ id: "work" }], {
      sandbox: { mode: "all", backend: "docker" },
    });
    expect(isContainerBackedAgent(cfg, "work")).toBe(true);
  });

  it("honors agent-specific sandbox overrides", () => {
    const cfg = cfgWithAgents(
      [
        { id: "host", sandbox: { mode: "off", backend: "docker" } },
        { id: "box", sandbox: { mode: "all", backend: "docker" } },
      ],
      { sandbox: { mode: "off", backend: "docker" } },
    );
    expect(isContainerBackedAgent(cfg, "host")).toBe(false);
    expect(isContainerBackedAgent(cfg, "box")).toBe(true);
  });
});

describe("resolveTuiAgent", () => {
  it("resolves a configured agent named Steve", async () => {
    const cfg = cfgWithAgents([{ id: "steve", name: "Steve" }]);

    await expect(resolveTuiAgent(cfg, "Steve", { isTty: false })).resolves.toBe("steve");
  });

  it("fails without an agent in non-TTY mode", async () => {
    const cfg = cfgWithAgents([{ id: "work" }]);

    await expect(resolveTuiAgent(cfg, undefined, { isTty: false })).rejects.toThrow(
      /gemmaclaw tui <agent>/,
    );
  });

  it("lists registered agents through the interactive picker", async () => {
    const cfg = cfgWithAgents([{ id: "work" }, { id: "play" }]);
    const pickAgent = vi.fn().mockResolvedValue("play");

    await expect(resolveTuiAgent(cfg, undefined, { isTty: true, pickAgent })).resolves.toBe("play");
    expect(pickAgent).toHaveBeenCalledWith(["work", "play"]);
  });

  it("prints setup/create guidance when zero agents are configured", async () => {
    await expect(resolveTuiAgent({} as OpenClawConfig, "work", { isTty: false })).rejects.toThrow(
      /gemmaclaw setup/,
    );
  });
});

describe("buildTuiAgentLaunchResult", () => {
  it("returns terminal mode for non-container agent", () => {
    const result = buildTuiAgentLaunchResult(cfgWithAgents([{ id: "work" }]), "work");
    expect(result.mode).toBe("terminal");
    if (result.mode === "terminal") {
      expect(result.opts.local).toBe(true);
      expect(result.opts.session).toContain("work");
    }
  });

  it("returns browser mode for container-backed agent", () => {
    const cfg = cfgWithAgents([{ id: "work" }], {
      sandbox: { mode: "all", backend: "docker" },
    });
    const result = buildTuiAgentLaunchResult(cfg, "work", 9150);
    expect(result.mode).toBe("browser");
    if (result.mode === "browser") {
      expect(result.url).toBe("http://127.0.0.1:9150/?agent=work");
      expect(result.port).toBe(9150);
    }
  });
});

describe("launchTuiAgent", () => {
  it("launches host-local terminal TUI with the selected agent session", async () => {
    const cfg = cfgWithAgents([{ id: "steve", name: "Steve" }]);
    const runTui = vi.fn().mockResolvedValue(undefined);

    await launchTuiAgent({
      agentArg: "Steve",
      deps: { readConfig: async () => cfg, isTty: false, runTui },
    });

    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({ local: true, session: expect.stringContaining("steve") }),
    );
  });

  it("starts a loopback gateway for a container-backed agent on its persisted port", async () => {
    const env = makeTempEnv();
    const cfg = cfgWithAgents([{ id: "work" }], {
      sandbox: { mode: "all", backend: "docker" },
    });
    const spawnGateway = vi.fn(() => 1234);

    await launchTuiAgent({
      agentArg: "work",
      openBrowser: false,
      deps: {
        readConfig: async () => cfg,
        isTty: false,
        env,
        probeGatewayHealth: vi.fn().mockResolvedValue(false),
        findPortOccupants: vi.fn().mockReturnValue([]),
        isPortOccupied: vi.fn().mockResolvedValue(false),
        spawnGateway,
        waitForGatewayReady: vi.fn().mockResolvedValue(true),
      },
    });

    const port = resolveAgentTuiPort({ agentId: "work", env });
    expect(spawnGateway).toHaveBeenCalledWith(port, "work");
    expect(mocks.runtime.log).toHaveBeenCalledWith(expect.stringContaining("127.0.0.1"));
  });

  it("reuses a healthy gateway on the selected agent port", async () => {
    const env = makeTempEnv();
    const cfg = cfgWithAgents([{ id: "work" }], {
      sandbox: { mode: "all", backend: "docker" },
    });
    const spawnGateway = vi.fn(() => 1234);

    await launchTuiAgent({
      agentArg: "work",
      openBrowser: false,
      deps: {
        readConfig: async () => cfg,
        isTty: false,
        env,
        probeGatewayHealth: vi.fn().mockResolvedValue(true),
        spawnGateway,
      },
    });

    expect(spawnGateway).not.toHaveBeenCalled();
    expect(mocks.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Reusing existing Gemmaclaw gateway"),
    );
  });

  it("fails clearly when the selected port is occupied by another process", async () => {
    const env = makeTempEnv();
    const cfg = cfgWithAgents([{ id: "work" }], {
      sandbox: { mode: "all", backend: "docker" },
    });
    const spawnGateway = vi.fn(() => 1234);

    await expect(
      launchTuiAgent({
        agentArg: "work",
        openBrowser: false,
        deps: {
          readConfig: async () => cfg,
          isTty: false,
          env,
          probeGatewayHealth: vi.fn().mockResolvedValue(false),
          findPortOccupants: vi.fn().mockReturnValue(["4321"]),
          isPortOccupied: vi.fn().mockResolvedValue(true),
          spawnGateway,
        },
      }),
    ).rejects.toThrow(/occupied/);

    expect(spawnGateway).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining("--port <free-port>"));
  });
});

describe("findProcessesOnPort", () => {
  it("returns an array", () => {
    expect(Array.isArray(findProcessesOnPort(1))).toBe(true);
  });
});
