import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt compaction retry timeout", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    vi.restoreAllMocks();
  });

  it("uses the configured compaction safety timeout for compaction retry waits", async () => {
    const { assemble } = createContextEngineBootstrapAndAssemble();

    await createContextEngineAttemptRunner({
      contextEngine: { assemble },
      attemptOverrides: {
        config: {
          agents: {
            defaults: {
              compaction: {
                timeoutSeconds: 123,
              },
            },
          },
        },
      },
      sessionKey: "agent:main:explicit:test-compaction-retry-timeout",
      tempPaths,
    });

    expect(hoisted.waitForCompactionRetryWithAggregateTimeoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateTimeoutMs: 123_000,
      }),
    );
  });
});
