import { beforeEach, describe, expect, it, vi } from "vitest";
import { messageAskCommand } from "./message-ask.js";

const mocks = vi.hoisted(() => ({
  agentCliCommandMock: vi.fn(),
  loadConfigMock: vi.fn(),
  listAgentEntriesMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("./agent-via-gateway.js", () => ({
  agentCliCommand: mocks.agentCliCommandMock,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfigMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentEntries: mocks.listAgentEntriesMock,
}));

describe("messageAskCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtime.exit.mockImplementation(() => {});
    mocks.agentCliCommandMock.mockResolvedValue(undefined);
    mocks.loadConfigMock.mockReturnValue({});
    mocks.listAgentEntriesMock.mockReturnValue([{ id: "dev" }, { id: "prod" }]);
  });

  it("sends message via positional args with --agent", async () => {
    await messageAskCommand({ agent: "dev" }, mocks.runtime, {
      positional: ["hello", "world"],
      isTty: true,
    });

    expect(mocks.agentCliCommandMock).toHaveBeenCalledTimes(1);
    const [opts] = mocks.agentCliCommandMock.mock.calls[0];
    expect(opts).toMatchObject({ message: "hello world", agent: "dev" });
  });

  it("uses --text as message body", async () => {
    await messageAskCommand({ agent: "dev", text: "via flag" }, mocks.runtime, {
      positional: [],
      isTty: true,
    });

    const [opts] = mocks.agentCliCommandMock.mock.calls[0];
    expect(opts.message).toBe("via flag");
  });

  it("reads message from stdin when not TTY", async () => {
    await messageAskCommand({ agent: "dev" }, mocks.runtime, {
      positional: [],
      isTty: false,
      readStdin: async () => "piped content\n",
    });

    const [opts] = mocks.agentCliCommandMock.mock.calls[0];
    expect(opts.message).toBe("piped content");
  });

  it("does not read stdin when positional text is provided", async () => {
    const readStdin = vi.fn(async () => "ignored");

    await messageAskCommand({ agent: "dev" }, mocks.runtime, {
      positional: ["hello"],
      isTty: false,
      readStdin,
    });

    expect(readStdin).not.toHaveBeenCalled();
    const [opts] = mocks.agentCliCommandMock.mock.calls[0];
    expect(opts.message).toBe("hello");
  });

  it("auto-selects single configured agent when --agent is omitted", async () => {
    mocks.listAgentEntriesMock.mockReturnValue([{ id: "solo" }]);
    await messageAskCommand({}, mocks.runtime, { positional: ["hi"], isTty: true });

    const [opts] = mocks.agentCliCommandMock.mock.calls[0];
    expect(opts.agent).toBe("solo");
  });

  it("errors when multiple agents configured and --agent missing", async () => {
    await messageAskCommand({}, mocks.runtime, { positional: ["hi"], isTty: true });

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Multiple agents configured"),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.agentCliCommandMock).not.toHaveBeenCalled();
  });

  it("errors when agent id is unknown", async () => {
    await messageAskCommand({ agent: "ghost" }, mocks.runtime, { positional: ["hi"], isTty: true });

    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining("Unknown agent id"));
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("errors when no message text provided", async () => {
    await messageAskCommand({ agent: "dev" }, mocks.runtime, { positional: [], isTty: true });

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Message text is required"),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("errors when no agents are configured", async () => {
    mocks.listAgentEntriesMock.mockReturnValue([]);
    await messageAskCommand({}, mocks.runtime, { positional: ["hi"], isTty: true });

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("No agents configured"),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });
});
