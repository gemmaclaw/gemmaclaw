import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCliCommand } from "./agent-via-gateway.js";
import type { agentCommand as AgentCommand } from "./agent.js";

const loadConfig = vi.hoisted(() => vi.fn());
const callGateway = vi.hoisted(() => vi.fn());
const agentCommand = vi.hoisted(() => vi.fn());

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function mockConfig(storePath: string, overrides?: Partial<OpenClawConfig>) {
  loadConfig.mockReturnValue({
    agents: {
      defaults: {
        timeoutSeconds: 600,
        ...overrides?.agents?.defaults,
      },
    },
    session: {
      store: storePath,
      mainKey: "main",
      ...overrides?.session,
    },
    gateway: overrides?.gateway,
  });
}

async function withTempStore(
  fn: (ctx: { dir: string; store: string }) => Promise<void>,
  overrides?: Partial<OpenClawConfig>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-cli-"));
  const store = path.join(dir, "sessions.json");
  mockConfig(store, overrides);
  try {
    await fn({ dir, store });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mockGatewaySuccessReply(text = "hello") {
  callGateway.mockResolvedValue({
    runId: "idem-1",
    status: "ok",
    result: {
      payloads: [{ text }],
      meta: { stub: true },
    },
  });
}

function mockLocalAgentReply(text = "local") {
  agentCommand.mockImplementationOnce(async (_opts, rt) => {
    rt?.log?.(text);
    return {
      payloads: [{ text }],
      meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    } as unknown as Awaited<ReturnType<typeof AgentCommand>>;
  });
}

vi.mock("../config/config.js", () => ({ loadConfig }));
vi.mock("../gateway/call.js", () => ({
  callGateway,
  randomIdempotencyKey: () => "idem-1",
}));
vi.mock("./agent.js", () => ({ agentCommand }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agentCliCommand", () => {
  it("uses a timer-safe max gateway timeout when --timeout is 0", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555", timeout: "0" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      const request = callGateway.mock.calls[0]?.[0] as { timeoutMs?: number };
      expect(request.timeoutMs).toBe(2_147_000_000);
    });
  });

  it("uses gateway by default", async () => {
    await withTempStore(async () => {
      mockGatewaySuccessReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith("hello");
    });
  });

  it("falls back to embedded agent when gateway fails", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(new Error("gateway not connected"));
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });

  it("skips gateway when --local is set", async () => {
    await withTempStore(async () => {
      mockLocalAgentReply();

      await agentCliCommand(
        {
          message: "hi",
          to: "+1555",
          local: true,
        },
        runtime,
      );

      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(agentCommand.mock.calls[0]?.[0]).toMatchObject({
        cleanupBundleMcpOnRunEnd: true,
      });
      expect(runtime.log).toHaveBeenCalledWith("local");
    });
  });

  it("does not force bundle MCP cleanup on gateway fallback", async () => {
    await withTempStore(async () => {
      callGateway.mockRejectedValue(new Error("gateway not connected"));
      mockLocalAgentReply();

      await agentCliCommand({ message: "hi", to: "+1555" }, runtime);

      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(agentCommand.mock.calls[0]?.[0]).not.toMatchObject({
        cleanupBundleMcpOnRunEnd: true,
      });
    });
  });

  it("reads full message from --message-file and passes it as message (E2BIG fix)", async () => {
    await withTempStore(async ({ dir }) => {
      // Simulate a large prompt that would cause E2BIG if passed via --message on the CLI.
      // Linux ARG_MAX is typically 131072 bytes; a 64k-token prompt is ~256KB of text.
      const largePrompt = "Prior agent transcript shard. ".repeat(8_000); // ~240KB
      const promptFile = path.join(dir, "prompt.txt");
      fs.writeFileSync(promptFile, largePrompt, "utf8");

      // Verify the prompt exceeds the OS argv limit (proving it would cause E2BIG as --message)
      expect(Buffer.byteLength(largePrompt, "utf8")).toBeGreaterThan(131_072);

      mockLocalAgentReply();

      await agentCliCommand({ messageFile: promptFile, to: "+1555", local: true }, runtime);

      expect(callGateway).not.toHaveBeenCalled();
      expect(agentCommand).toHaveBeenCalledTimes(1);
      const opts = agentCommand.mock.calls[0]?.[0] as { message?: string };
      // The full prompt must be passed as the message, not a truncated placeholder
      expect(opts.message).toBe(largePrompt);
    });
  });
});
