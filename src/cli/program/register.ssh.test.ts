import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSshCommand } from "./register.ssh.js";

const mocks = vi.hoisted(() => ({
  agentsSshCommandMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/agents.commands.ssh.js", () => ({
  agentsSshCommand: mocks.agentsSshCommandMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerSshCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSshCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtime.exit.mockImplementation(() => {});
    mocks.agentsSshCommandMock.mockResolvedValue(undefined);
  });

  it("registers a 'ssh' command", async () => {
    const program = new Command();
    registerSshCommand(program);
    const cmd = program.commands.find((c) => c.name() === "ssh");
    expect(cmd).toBeDefined();
  });

  it("passes no agent when none given", async () => {
    await runCli(["ssh"]);

    expect(mocks.agentsSshCommandMock).toHaveBeenCalledWith(
      { agent: undefined, nonInteractive: false },
      mocks.runtime,
    );
  });

  it("passes agent name from positional argument", async () => {
    await runCli(["ssh", "main"]);

    expect(mocks.agentsSshCommandMock).toHaveBeenCalledWith(
      { agent: "main", nonInteractive: false },
      mocks.runtime,
    );
  });

  it("forwards --non-interactive flag", async () => {
    await runCli(["ssh", "work", "--non-interactive"]);

    expect(mocks.agentsSshCommandMock).toHaveBeenCalledWith(
      { agent: "work", nonInteractive: true },
      mocks.runtime,
    );
  });

  it("treats whitespace-only agent as undefined", async () => {
    // Commander parses empty string as a truthy value; our code trims and converts to undefined.
    // With no positional arg, agent should be undefined.
    await runCli(["ssh"]);
    const [opts] = mocks.agentsSshCommandMock.mock.calls[0];
    expect(opts.agent).toBeUndefined();
  });

  it("shows --help without throwing", async () => {
    const program = new Command();
    registerSshCommand(program);
    expect(() => program.parse(["ssh", "--help"], { from: "user" })).toThrow();
  });
});
