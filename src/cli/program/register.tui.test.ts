import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerTuiCommand } from "./register.tui.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  launchTuiAgent: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/agents.commands.tui.js", () => ({
  launchTuiAgent: mocks.launchTuiAgent,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: vi.fn(() => ({
    select: vi.fn().mockResolvedValue("work"),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function runCli(args: string[]) {
  const program = new Command();
  program.exitOverride(); // Prevent process.exit during tests
  registerTuiCommand(program);
  await program.parseAsync(args, { from: "user" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("registerTuiCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtime.exit.mockImplementation(() => {
      throw new Error("exit called");
    });
    mocks.launchTuiAgent.mockResolvedValue(undefined);
  });

  it("calls launchTuiAgent with positional agent", async () => {
    await runCli(["tui", "work"]);
    expect(mocks.launchTuiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentArg: "work" }),
    );
  });

  it("calls launchTuiAgent with --agent flag", async () => {
    await runCli(["tui", "--agent", "play"]);
    expect(mocks.launchTuiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentArg: "play" }),
    );
  });

  it("prefers positional arg over --agent flag", async () => {
    await runCli(["tui", "work", "--agent", "play"]);
    expect(mocks.launchTuiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentArg: "work" }),
    );
  });

  it("calls launchTuiAgent without agent when omitted (picker will run)", async () => {
    await runCli(["tui"]);
    expect(mocks.launchTuiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentArg: undefined }),
    );
  });

  it("exits with friendly error when no agents configured", async () => {
    mocks.launchTuiAgent.mockRejectedValue(
      new Error("No agents configured. Run 'gemmaclaw create <name>' to create an instance first."),
    );
    await expect(runCli(["tui"])).rejects.toThrow("exit called");
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("No agents configured"),
    );
    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining("gemmaclaw setup"));
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("exits with hint when agent is omitted in non-TTY mode", async () => {
    mocks.launchTuiAgent.mockRejectedValue(
      new Error(
        "No agent specified. Usage: gemmaclaw tui <agent>. Run 'gemmaclaw list' to see configured agents.",
      ),
    );
    await expect(runCli(["tui"])).rejects.toThrow("exit called");
    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining("No agent specified"));
    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining("gemmaclaw list"));
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("forwards --port as numeric override", async () => {
    await runCli(["tui", "work", "--port", "9120"]);
    expect(mocks.launchTuiAgent).toHaveBeenCalledWith(expect.objectContaining({ port: 9120 }));
  });

  it("passes openBrowser=false when --no-open is given", async () => {
    await runCli(["tui", "work", "--no-open"]);
    expect(mocks.launchTuiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ openBrowser: false }),
    );
  });

  it("exits with error on invalid --port", async () => {
    await expect(runCli(["tui", "work", "--port", "notanumber"])).rejects.toThrow("exit called");
    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining("Invalid --port"));
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });
});
