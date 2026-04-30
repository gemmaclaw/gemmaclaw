import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCreateCommand } from "./register.create.js";

const mocks = vi.hoisted(() => ({
  createCommandMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/create.js", () => ({
  createCommand: mocks.createCommandMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerCreateCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerCreateCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtime.exit.mockImplementation(() => {});
    mocks.createCommandMock.mockResolvedValue(undefined);
  });

  it("passes positional name and infers no flags", async () => {
    await runCli(["create", "work"]);

    expect(mocks.createCommandMock).toHaveBeenCalledTimes(1);
    const [opts, , params] = mocks.createCommandMock.mock.calls[0];
    expect(opts).toMatchObject({ name: "work", nonInteractive: false, json: false });
    expect(params?.hasFlags).toBe(false);
  });

  it("uses --name when positional is missing", async () => {
    await runCli(["create", "--name", "dev"]);

    const [opts] = mocks.createCommandMock.mock.calls[0];
    expect(opts.name).toBe("dev");
  });

  it("treats --json as an explicit non-interactive flag", async () => {
    await runCli(["create", "play", "--json"]);

    const [, , params] = mocks.createCommandMock.mock.calls[0];
    expect(params?.hasFlags).toBe(true);
  });

  it("forwards workspace, model, agent-dir, non-interactive, and json flags", async () => {
    await runCli([
      "create",
      "play",
      "--workspace",
      "/tmp/play",
      "--model",
      "ollama/gemma3:4b",
      "--agent-dir",
      "/tmp/play-agent",
      "--non-interactive",
      "--json",
    ]);

    const [opts, , params] = mocks.createCommandMock.mock.calls[0];
    expect(opts).toMatchObject({
      name: "play",
      workspace: "/tmp/play",
      model: "ollama/gemma3:4b",
      agentDir: "/tmp/play-agent",
      nonInteractive: true,
      json: true,
    });
    expect(params?.hasFlags).toBe(true);
  });

  it("reports errors via runtime", async () => {
    mocks.createCommandMock.mockRejectedValueOnce(new Error("create failed"));

    await runCli(["create", "fail"]);

    expect(mocks.runtime.error).toHaveBeenCalledWith("Error: create failed");
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });
});
