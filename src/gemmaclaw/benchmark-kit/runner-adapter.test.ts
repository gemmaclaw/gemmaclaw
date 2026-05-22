import { afterEach, describe, expect, it } from "vitest";
import {
  AgentRunnerNotConfiguredError,
  IncompatiblePackError,
  buildRunner,
  defaultRunnerForPack,
  registerAgentRunner,
  type RunnerHandle,
} from "./runner-adapter.js";
import { loadAgentFixtureTasks } from "./task-loader.js";

describe("defaultRunnerForPack", () => {
  it("returns 'core-model' for tool-free packs", () => {
    const pack = {
      schemaVersion: "1" as const,
      pack: "demo",
      version: "1.0.0",
      family: "tool-free" as const,
      tasks: [
        {
          id: "x",
          prompt: "Reply OK.",
          grading: { type: "exact_match" as const, expected: ["OK"], maxScore: 1 },
        },
      ],
    };
    expect(defaultRunnerForPack(pack)).toBe("core-model");
  });

  it("returns 'agent' for agent packs", () => {
    expect(defaultRunnerForPack(loadAgentFixtureTasks())).toBe("agent");
  });
});

describe("buildRunner", () => {
  afterEach(() => {
    registerAgentRunner(null);
  });

  it("throws AgentRunnerNotConfiguredError when no agent runner is registered", () => {
    expect(() => buildRunner("agent")).toThrow(AgentRunnerNotConfiguredError);
  });

  it("returns a registered agent runner via registerAgentRunner", () => {
    const fakeRunner: RunnerHandle = {
      kind: "agent",
      name: "fake-agent",
      async run() {
        return {
          packId: "fake",
          packVersion: "0.0.0",
          family: "agent",
          runnerName: "fake-agent",
          modelSpec: "fake:fake",
          outcomes: [],
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(0).toISOString(),
        };
      },
    };
    registerAgentRunner(() => fakeRunner);
    const r = buildRunner("agent");
    expect(r).toBe(fakeRunner);
  });

  it("returns a core-model runner handle (run path is intentionally stubbed)", () => {
    const r = buildRunner("core-model");
    expect(r.kind).toBe("core-model");
    expect(r.name).toBe("core-model");
  });

  it("returns a deterministic mock-agent runner for agent-pack smoke runs", async () => {
    const r = buildRunner("mock-agent");
    const pack = loadAgentFixtureTasks();
    const result = await r.run(pack, { modelSpec: "mock-agent:agent-fixtures" });

    expect(r.kind).toBe("mock-agent");
    expect(result.runnerName).toBe("mock-agent");
    expect(result.family).toBe("agent");
    expect(result.outcomes).toHaveLength(pack.tasks.length);
    expect(result.outcomes.every((outcome) => outcome.passed)).toBe(true);
  });
});

describe("CoreModelRunner.run", () => {
  it("rejects agent packs with IncompatiblePackError", async () => {
    const r = buildRunner("core-model");
    const agent = loadAgentFixtureTasks();
    await expect(r.run(agent, { modelSpec: "ollama:gemma3:4b" })).rejects.toBeInstanceOf(
      IncompatiblePackError,
    );
  });

  it("for tool-free packs, throws a clear 'use gemmaclaw benchmark' error (no silent execution)", async () => {
    const r = buildRunner("core-model");
    const toolFree = {
      schemaVersion: "1" as const,
      pack: "demo",
      version: "1.0.0",
      family: "tool-free" as const,
      tasks: [
        {
          id: "x",
          prompt: "Reply OK.",
          grading: { type: "exact_match" as const, expected: ["OK"], maxScore: 1 },
        },
      ],
    };
    await expect(r.run(toolFree, { modelSpec: "ollama:gemma3:4b" })).rejects.toThrow(
      /no in-process execution path/,
    );
  });
});
