import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerListCommand } from "./register.list.js";

const mocks = vi.hoisted(() => ({
  agentsListCommandMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/agents.js", () => ({
  agentsListCommand: mocks.agentsListCommandMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerListCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerListCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtime.exit.mockImplementation(() => {});
    mocks.agentsListCommandMock.mockResolvedValue(undefined);
  });

  it("invokes agentsListCommand with default flags", async () => {
    await runCli(["list"]);

    expect(mocks.agentsListCommandMock).toHaveBeenCalledWith(
      { json: false, bindings: false, configuredOnly: true },
      mocks.runtime,
    );
  });

  it("forwards --json and --bindings", async () => {
    await runCli(["list", "--json", "--bindings"]);

    expect(mocks.agentsListCommandMock).toHaveBeenCalledWith(
      { json: true, bindings: true, configuredOnly: true },
      mocks.runtime,
    );
  });
});
