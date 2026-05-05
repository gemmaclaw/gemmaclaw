import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadCronStore } from "../cron/store.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  DEFAULT_KNOWLEDGE_AGENT_CRON_ID,
  DEFAULT_KNOWLEDGE_AGENT_PROMPT,
  ensureDefaultKnowledgeAgentCron,
} from "./onboard-knowledge-agent.js";

function runtime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("onboard-knowledge-agent", () => {
  it("adds the default 3 AM isolated knowledge maintenance cron job", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-knowledge-agent-"));
    const storePath = path.join(dir, "cron", "jobs.json");
    const prompter = { note: vi.fn(async () => undefined) };

    await ensureDefaultKnowledgeAgentCron({
      cfg: { cron: { store: storePath } },
      runtime: runtime(),
      prompter: prompter as never,
      nowMs: 123,
    });

    const store = await loadCronStore(storePath);
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]).toMatchObject({
      id: DEFAULT_KNOWLEDGE_AGENT_CRON_ID,
      enabled: true,
      schedule: { kind: "cron", expr: "0 3 * * *", staggerMs: 0 },
      sessionTarget: "isolated",
      wakeMode: "now",
      delivery: { mode: "none" },
      failureAlert: false,
      createdAtMs: 123,
      updatedAtMs: 123,
    });
    expect(store.jobs[0]?.payload).toMatchObject({
      kind: "agentTurn",
      message: DEFAULT_KNOWLEDGE_AGENT_PROMPT,
      thinking: "medium",
      timeoutSeconds: 3600,
    });
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Scheduled daily knowledge maintenance at 3:00 AM"),
      "Knowledge maintenance",
    );
  });

  it("does not duplicate an existing default job", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-knowledge-agent-"));
    const storePath = path.join(dir, "cron", "jobs.json");

    await ensureDefaultKnowledgeAgentCron({
      cfg: { cron: { store: storePath } },
      runtime: runtime(),
      nowMs: 123,
    });
    await ensureDefaultKnowledgeAgentCron({
      cfg: { cron: { store: storePath } },
      runtime: runtime(),
      nowMs: 456,
    });

    const store = await loadCronStore(storePath);
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]?.createdAtMs).toBe(123);
  });

  it("respects explicit cron disabled config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-knowledge-agent-"));
    const storePath = path.join(dir, "cron", "jobs.json");

    await ensureDefaultKnowledgeAgentCron({
      cfg: { cron: { enabled: false, store: storePath } },
      runtime: runtime(),
      nowMs: 123,
    });

    await expect(loadCronStore(storePath)).resolves.toEqual({ version: 1, jobs: [] });
  });
});
