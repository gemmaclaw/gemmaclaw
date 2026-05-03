import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentsListCommand } from "./agents.commands.list.js";

const mocks = vi.hoisted(() => ({
  requireValidConfigMock: vi.fn(),
  buildAgentSummariesMock: vi.fn(),
  resolveAgentsSshInfoMock: vi.fn(),
  buildProviderStatusIndexMock: vi.fn(),
  listRouteBindingsMock: vi.fn(),
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

vi.mock("./agents.commands.ssh.js", () => ({
  resolveAgentsSshInfo: mocks.resolveAgentsSshInfoMock,
}));

vi.mock("./agents.providers.js", () => ({
  buildProviderStatusIndex: mocks.buildProviderStatusIndexMock,
  listProvidersForAgent: vi.fn().mockReturnValue([]),
  summarizeBindings: vi.fn().mockReturnValue([]),
}));

vi.mock("../config/bindings.js", () => ({
  listRouteBindings: mocks.listRouteBindingsMock,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {},
  writeRuntimeJson: vi.fn(),
}));

const baseCfg = { agents: { list: [{ id: "main" }] } };
const baseSummary = {
  id: "main",
  isDefault: true,
  workspace: "/w",
  agentDir: "/a",
  bindings: 0,
};

function sshInfo(overrides = {}) {
  return {
    agentId: "main",
    sandboxMode: "all",
    sandboxBackend: "docker",
    containerBacked: true,
    shellAvailable: false,
    shellUnavailableReason: "no container registered — start a session first",
    containers: [],
    ...overrides,
  };
}

describe("agentsListCommand shell availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireValidConfigMock.mockResolvedValue(baseCfg);
    mocks.buildAgentSummariesMock.mockReturnValue([{ ...baseSummary }]);
    mocks.buildProviderStatusIndexMock.mockResolvedValue({});
    mocks.listRouteBindingsMock.mockReturnValue([]);
  });

  it("sets shellAvailable=true when container is running", async () => {
    mocks.resolveAgentsSshInfoMock.mockResolvedValue(
      new Map([
        [
          "main",
          sshInfo({
            shellAvailable: true,
            shellUnavailableReason: undefined,
            containers: [{ containerName: "c1", backendId: "docker", exists: true, running: true }],
          }),
        ],
      ]),
    );
    const capturedSummaries: unknown[] = [];
    const { writeRuntimeJson } = await import("../runtime.js");
    vi.mocked(writeRuntimeJson).mockImplementation((_rt, data) => {
      capturedSummaries.push(...(data as unknown[]));
    });
    await agentsListCommand({ json: true }, mocks.runtime as never);
    expect(capturedSummaries[0]).toMatchObject({
      shellAvailable: true,
      containerShell: {
        eligible: true,
        available: true,
        backend: "docker",
        containers: [{ name: "c1", backend: "docker", exists: true, running: true }],
      },
    });
    expect(
      (capturedSummaries[0] as { shellUnavailableReason?: string }).shellUnavailableReason,
    ).toBeUndefined();
  });

  it("sets shellAvailable=false with 'no container registered' reason when no registry entries", async () => {
    mocks.resolveAgentsSshInfoMock.mockResolvedValue(
      new Map([
        [
          "main",
          sshInfo({
            containers: [],
          }),
        ],
      ]),
    );
    const capturedSummaries: unknown[] = [];
    const { writeRuntimeJson } = await import("../runtime.js");
    vi.mocked(writeRuntimeJson).mockImplementation((_rt, data) => {
      capturedSummaries.push(...(data as unknown[]));
    });
    await agentsListCommand({ json: true }, mocks.runtime as never);
    expect(capturedSummaries[0]).toMatchObject({
      shellAvailable: false,
      shellUnavailableReason: expect.stringContaining("no container registered"),
      containerShell: {
        eligible: true,
        available: false,
        reason: expect.stringContaining("no container registered"),
      },
    });
  });

  it("sets shellAvailable=false with 'container stopped' reason when container exists but not running", async () => {
    mocks.resolveAgentsSshInfoMock.mockResolvedValue(
      new Map([
        [
          "main",
          sshInfo({
            shellUnavailableReason: "container stopped — start a session first",
            containers: [
              { containerName: "c1", backendId: "docker", exists: true, running: false },
            ],
          }),
        ],
      ]),
    );
    const capturedSummaries: unknown[] = [];
    const { writeRuntimeJson } = await import("../runtime.js");
    vi.mocked(writeRuntimeJson).mockImplementation((_rt, data) => {
      capturedSummaries.push(...(data as unknown[]));
    });
    await agentsListCommand({ json: true }, mocks.runtime as never);
    expect(capturedSummaries[0]).toMatchObject({
      shellAvailable: false,
      shellUnavailableReason: expect.stringContaining("container stopped"),
      containerShell: {
        eligible: true,
        available: false,
        reason: expect.stringContaining("container stopped"),
      },
    });
  });

  it("sets shellAvailable=false with config reason when agent is not container-backed", async () => {
    mocks.resolveAgentsSshInfoMock.mockResolvedValue(
      new Map([
        [
          "main",
          sshInfo({
            sandboxMode: "off",
            containerBacked: false,
            unavailableReason: "sandbox mode is off (not container-backed)",
            shellUnavailableReason: "sandbox mode is off (not container-backed)",
            containers: [],
          }),
        ],
      ]),
    );
    const capturedSummaries: unknown[] = [];
    const { writeRuntimeJson } = await import("../runtime.js");
    vi.mocked(writeRuntimeJson).mockImplementation((_rt, data) => {
      capturedSummaries.push(...(data as unknown[]));
    });
    await agentsListCommand({ json: true }, mocks.runtime as never);
    expect(capturedSummaries[0]).toMatchObject({
      shellAvailable: false,
      shellUnavailableReason: expect.stringContaining("sandbox mode is off"),
      containerShell: {
        eligible: false,
        available: false,
        mode: "off",
        reason: expect.stringContaining("sandbox mode is off"),
      },
    });
  });
});
