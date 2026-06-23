import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

const base = Date.parse("2025-12-13T00:00:00.000Z");

// A recurring every-job whose slot at base - 5_000 is due (now === base) but
// has not yet fired (lastRunAtMs precedes it). The explicit anchor makes the
// fork's next-run computation deterministic.
function dueEveryJob(): CronJob {
  return {
    id: "due-every",
    name: "due every 10s",
    enabled: true,
    createdAtMs: base - 3_600_000,
    updatedAtMs: base - 10_000,
    schedule: { kind: "every", everyMs: 10_000, anchorMs: base - 5_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "tick" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: base - 5_000, lastRunAtMs: base - 15_000 },
  } as unknown as CronJob;
}

function jobToRemove(): CronJob {
  return {
    id: "to-remove",
    name: "obsolete job",
    enabled: true,
    createdAtMs: base - 3_600_000,
    updatedAtMs: base - 10_000,
    schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "noop" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: base + 3_600_000 },
  } as unknown as CronJob;
}

// Companion to the add() regression: remove() must load with skipRecompute and
// use the maintenance recompute (which never advances a present past-due slot)
// rather than letting the cold-store load run the full recomputeNextRuns. The
// pre-fix remove() ran ensureLoaded() without skipRecompute, so the post-load
// recomputeNextRuns advanced the due slot a full interval and silently dropped
// the pending run (#94323). remove() must be the first op so it triggers the
// cold load itself (a prior read would warm the store and mask the bug).
describe("remove() must not drop a due every-job's pending run", () => {
  it("preserves a due sibling's pending slot on cold-store remove", async () => {
    const store = await makeStorePath();
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [dueEveryJob(), jobToRemove()],
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    const result = await cron.remove("to-remove");
    expect(result).toEqual({ ok: true, removed: true });

    // Pre-fix the cold load advanced this to base + 5_000 (the next aligned
    // slot), dropping the due-but-unfired occurrence. The fix preserves it.
    const dueEvery = cron.getJob("due-every");
    expect(dueEvery?.state.nextRunAtMs).toBe(base - 5_000);
    expect(dueEvery?.state.lastRunAtMs).toBe(base - 15_000);

    cron.stop();
  });
});
