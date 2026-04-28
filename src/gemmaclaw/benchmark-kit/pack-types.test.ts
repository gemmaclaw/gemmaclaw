import { describe, expect, it } from "vitest";
import { BenchmarkPackSchema, parseBenchmarkPack } from "./pack-types.js";

const MIN_TOOL_FREE_PACK_V1 = {
  schemaVersion: "1",
  pack: "demo-tool-free",
  version: "1.0.0",
  family: "tool-free",
  tasks: [
    {
      id: "demo_task",
      name: "demo",
      prompt: "Reply OK.",
      grading: { type: "exact_match", expected: ["OK"], maxScore: 1 },
    },
  ],
};

const MIN_AGENT_PACK_V1 = {
  schemaVersion: "1",
  pack: "demo-agent",
  version: "1.0.0",
  family: "agent",
  tasks: [
    {
      id: "demo_action",
      name: "demo action",
      prompt: "Take a single action.",
      grading: {
        type: "output_check",
        criteria: ["must do the thing"],
        max_score: 1,
      },
    },
  ],
};

const LEGACY_TOOL_FREE_PACK = {
  pack: "legacy-pack",
  version: "0.1.0",
  description: "Legacy benchmark-kit shape, no schemaVersion / family.",
  tasks: [
    {
      id: "legacy_task",
      name: "legacy",
      prompt: "Reply OK.",
      grading: { type: "exact_match", expected: ["OK"], maxScore: 1 },
    },
  ],
};

describe("BenchmarkPackSchema", () => {
  it("accepts a tool-free v1 pack", () => {
    const result = BenchmarkPackSchema.safeParse(MIN_TOOL_FREE_PACK_V1);
    expect(result.success).toBe(true);
  });

  it("accepts an agent v1 pack", () => {
    const result = BenchmarkPackSchema.safeParse(MIN_AGENT_PACK_V1);
    expect(result.success).toBe(true);
  });

  it("rejects unknown family", () => {
    const result = BenchmarkPackSchema.safeParse({
      ...MIN_TOOL_FREE_PACK_V1,
      family: "rogue-family",
    });
    expect(result.success).toBe(false);
  });

  it("rejects schemaVersion other than '1'", () => {
    const result = BenchmarkPackSchema.safeParse({
      ...MIN_TOOL_FREE_PACK_V1,
      schemaVersion: "0",
    });
    expect(result.success).toBe(false);
  });

  it("rejects bad pack id (uppercase)", () => {
    const result = BenchmarkPackSchema.safeParse({
      ...MIN_TOOL_FREE_PACK_V1,
      pack: "Bad-Pack",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty task list", () => {
    const result = BenchmarkPackSchema.safeParse({ ...MIN_TOOL_FREE_PACK_V1, tasks: [] });
    expect(result.success).toBe(false);
  });

  it("requires tool-free task gradings to use known type", () => {
    const result = BenchmarkPackSchema.safeParse({
      ...MIN_TOOL_FREE_PACK_V1,
      tasks: [
        {
          id: "demo_task",
          name: "demo",
          prompt: "Reply OK.",
          grading: { type: "totally_made_up", expected: ["OK"], maxScore: 1 },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("requires agent task gradings to use known type", () => {
    const result = BenchmarkPackSchema.safeParse({
      ...MIN_AGENT_PACK_V1,
      tasks: [
        {
          id: "x",
          prompt: "do something",
          grading: { type: "totally_made_up", criteria: ["..."], max_score: 1 },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("permits pack-specific extension fields on agent gradings", () => {
    const pack = {
      ...MIN_AGENT_PACK_V1,
      tasks: [
        {
          id: "x",
          prompt: "do something",
          grading: {
            type: "file_check",
            criteria: ["..."],
            max_score: 1,
            check_path: "memory/x.md",
            fail_conditions: ["password leaked"],
            setup: "inject_gog_error",
          },
        },
      ],
    };
    const result = BenchmarkPackSchema.safeParse(pack);
    expect(result.success).toBe(true);
  });
});

describe("parseBenchmarkPack", () => {
  it("returns the typed v1 pack untouched for v1 input", () => {
    const pack = parseBenchmarkPack(MIN_AGENT_PACK_V1);
    expect(pack.family).toBe("agent");
    expect(pack.pack).toBe("demo-agent");
  });

  it("auto-promotes legacy benchmark-kit packs to family='tool-free'", () => {
    const pack = parseBenchmarkPack(LEGACY_TOOL_FREE_PACK);
    expect(pack.family).toBe("tool-free");
    expect(pack.schemaVersion).toBe("1");
    expect(pack.tasks.length).toBe(1);
  });

  it("throws on garbage input", () => {
    expect(() => parseBenchmarkPack({ tasks: "not an array" })).toThrow(/invalid benchmark pack/);
  });

  it("throws on legacy shape with bad task grading", () => {
    expect(() =>
      parseBenchmarkPack({
        pack: "legacy-bad",
        version: "0.1.0",
        tasks: [
          {
            id: "x",
            name: "bad",
            prompt: "say hi",
            grading: { type: "exact_match", maxScore: -5 },
          },
        ],
      }),
    ).toThrow(/invalid benchmark pack/);
  });
});
