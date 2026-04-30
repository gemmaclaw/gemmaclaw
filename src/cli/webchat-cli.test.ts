import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveChatAgent } from "./webchat-cli.js";

const mocks = vi.hoisted(() => ({
  listAgentEntriesMock: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentEntries: mocks.listAgentEntriesMock,
}));

describe("resolveChatAgent", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the single configured agent when no flag is given", async () => {
    mocks.listAgentEntriesMock.mockReturnValue([{ id: "solo" }]);

    const result = await resolveChatAgent(cfg, undefined, { isTty: false });

    expect(result).toEqual({ ok: true, agentId: "solo" });
  });

  it("validates explicit --agent against configured list", async () => {
    mocks.listAgentEntriesMock.mockReturnValue([{ id: "dev" }, { id: "prod" }]);

    const ok = await resolveChatAgent(cfg, "prod", { isTty: false });
    expect(ok).toEqual({ ok: true, agentId: "prod" });

    const bad = await resolveChatAgent(cfg, "ghost", { isTty: false });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.message).toContain('Unknown agent id "ghost"');
    }
  });

  it("fails clearly with multiple agents and no TTY", async () => {
    mocks.listAgentEntriesMock.mockReturnValue([{ id: "dev" }, { id: "prod" }]);

    const result = await resolveChatAgent(cfg, undefined, { isTty: false });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Multiple agents configured");
      expect(result.message).toContain("dev");
      expect(result.message).toContain("prod");
    }
  });

  it("invokes pickAgent in TTY when multiple agents", async () => {
    mocks.listAgentEntriesMock.mockReturnValue([{ id: "dev" }, { id: "prod" }]);
    const pickAgent = vi.fn(async () => "prod");

    const result = await resolveChatAgent(cfg, undefined, {
      isTty: true,
      pickAgent,
    });

    expect(pickAgent).toHaveBeenCalledWith(["dev", "prod"]);
    expect(result).toEqual({ ok: true, agentId: "prod" });
  });

  it("fails clearly when no agents are configured", async () => {
    mocks.listAgentEntriesMock.mockReturnValue([]);

    const result = await resolveChatAgent(cfg, undefined, { isTty: false });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("No agents configured");
      expect(result.message).toContain("gemmaclaw create");
    }
  });

  it("fails when picker returns nothing", async () => {
    mocks.listAgentEntriesMock.mockReturnValue([{ id: "dev" }, { id: "prod" }]);
    const pickAgent = vi.fn(async () => undefined);

    const result = await resolveChatAgent(cfg, undefined, {
      isTty: true,
      pickAgent,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("No agent selected");
    }
  });

  it("normalizes agent id casing", async () => {
    mocks.listAgentEntriesMock.mockReturnValue([{ id: "dev" }]);

    const result = await resolveChatAgent(cfg, "DEV", { isTty: false });
    expect(result).toEqual({ ok: true, agentId: "dev" });
  });
});
