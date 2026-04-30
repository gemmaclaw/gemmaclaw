import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const replaceConfigFileMock = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: unknown }) => await writeConfigFileMock(params.nextConfig)),
);
const ensureWorkspaceAndSessionsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const wizardMocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("./onboard-helpers.js", () => ({
  ensureWorkspaceAndSessions: ensureWorkspaceAndSessionsMock,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: wizardMocks.createClackPrompter,
}));

import { createCommand } from "./create.js";

const runtime = createTestRuntime();

describe("createCommand", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    replaceConfigFileMock.mockClear();
    ensureWorkspaceAndSessionsMock.mockClear();
    wizardMocks.createClackPrompter.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
  });

  it("requires a name in non-interactive mode", async () => {
    await createCommand({ nonInteractive: true }, runtime, { hasFlags: false, isTty: false });

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Agent name is required"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("rejects the reserved default agent id", async () => {
    await createCommand({ name: "main", nonInteractive: true }, runtime, {
      hasFlags: true,
      isTty: false,
    });

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("reserved"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("rejects an agent name that already exists", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      sourceConfig: {
        agents: { list: [{ id: "work" }] },
      },
    });

    await createCommand({ name: "work", nonInteractive: true }, runtime, {
      hasFlags: true,
      isTty: false,
    });

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("already exists"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("creates a new named agent in non-interactive mode", async () => {
    await createCommand(
      {
        name: "play",
        workspace: "/tmp/play",
        model: "ollama/gemma3:4b",
        nonInteractive: true,
      },
      runtime,
      { hasFlags: true, isTty: false },
    );

    expect(replaceConfigFileMock).toHaveBeenCalledTimes(1);
    const args = replaceConfigFileMock.mock.calls[0][0] as {
      nextConfig: {
        agents?: { list?: Array<{ id: string; workspace?: string; model?: unknown }> };
      };
    };
    const list = args.nextConfig.agents?.list ?? [];
    const playEntry = list.find((entry) => entry.id === "play");
    expect(list.map((entry) => entry.id)).toEqual(["play"]);
    expect(playEntry).toBeDefined();
    expect(playEntry?.workspace).toBe("/tmp/play");
    expect(playEntry?.model).toBe("ollama/gemma3:4b");
    expect(ensureWorkspaceAndSessionsMock).toHaveBeenCalledTimes(1);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("emits JSON summary when --json is set", async () => {
    await createCommand(
      {
        name: "play",
        workspace: "/tmp/play",
        nonInteractive: true,
        json: true,
      },
      runtime,
      { hasFlags: true, isTty: false },
    );
    expect(runtime.log).toHaveBeenCalled();
    const logged = runtime.log.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain('"agentId": "play"');
    expect(logged).toContain('"workspace": "/tmp/play"');
  });
});
