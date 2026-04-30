import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMessageAskCommand } from "./register.ask.js";

const mocks = vi.hoisted(() => ({
  messageAskCommandMock: vi.fn(),
  createDefaultDepsMock: vi.fn(() => ({ deps: true })),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../../commands/message-ask.js", () => ({
  messageAskCommand: mocks.messageAskCommandMock,
}));

vi.mock("../../deps.js", () => ({
  createDefaultDeps: mocks.createDefaultDepsMock,
}));

vi.mock("../../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerMessageAskCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    const message = program.command("message");
    registerMessageAskCommand(message);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtime.exit.mockImplementation(() => {});
    mocks.messageAskCommandMock.mockResolvedValue(undefined);
  });

  it("forwards positional text and --agent flag", async () => {
    await runCli(["message", "ask", "hello", "world", "--agent", "dev"]);

    expect(mocks.messageAskCommandMock).toHaveBeenCalledTimes(1);
    const [opts, , params] = mocks.messageAskCommandMock.mock.calls[0];
    expect(opts).toMatchObject({ agent: "dev" });
    expect(params?.positional).toEqual(["hello", "world"]);
  });

  it("treats --name as alias for --agent", async () => {
    await runCli(["message", "ask", "hello", "--name", "play"]);

    const [opts] = mocks.messageAskCommandMock.mock.calls[0];
    expect(opts).toMatchObject({ agent: "play" });
  });

  it("forwards --text, --session-id, --thinking, --json, --timeout, --local", async () => {
    await runCli([
      "message",
      "ask",
      "--agent",
      "dev",
      "--text",
      "hi",
      "--session-id",
      "abc",
      "--thinking",
      "high",
      "--json",
      "--timeout",
      "120",
      "--local",
    ]);

    const [opts] = mocks.messageAskCommandMock.mock.calls[0];
    expect(opts).toMatchObject({
      agent: "dev",
      text: "hi",
      sessionId: "abc",
      thinking: "high",
      json: true,
      timeout: "120",
      local: true,
    });
  });

  it("runs as the default subcommand of 'message'", async () => {
    // No 'ask' keyword: default subcommand routing should still call ask.
    await runCli(["message", "hello", "--agent", "dev"]);

    expect(mocks.messageAskCommandMock).toHaveBeenCalledTimes(1);
    const [, , params] = mocks.messageAskCommandMock.mock.calls[0];
    expect(params?.positional).toEqual(["hello"]);
  });
});
