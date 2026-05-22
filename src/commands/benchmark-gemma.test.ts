import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { benchmarkGemmaCommand } from "./benchmark-gemma.js";

function makeRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const runtime: RuntimeEnv = {
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    exit: (code: number) => {
      exits.push(code);
      throw new Error(`exit ${code}`);
    },
  };
  return { runtime, logs, errors, exits };
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("benchmarkGemmaCommand agent packs", () => {
  it("runs the built-in agent-fixtures pack through mock-agent and writes standard artifacts", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemmaclaw-agent-fixtures-"));
    tmpDirs.push(outputDir);
    const { runtime, logs } = makeRuntime();

    await benchmarkGemmaCommand(
      {
        pack: "agent-fixtures",
        runner: "mock-agent",
        model: "mock-agent:agent-fixtures",
        outputDir,
      },
      runtime,
    );

    const jsonPath = path.join(outputDir, "results.json");
    const markdownPath = path.join(outputDir, "RESULTS.md");
    const htmlPath = path.join(outputDir, "index.html");
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(markdownPath)).toBe(true);
    expect(fs.existsSync(htmlPath)).toBe(true);

    const artifact = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    expect(artifact.benchmarkFamily).toBe("agent");
    expect(artifact.pack.id).toBe("agent-fixtures");
    expect(artifact.runner.name).toBe("mock-agent");
    expect(artifact.tasks.length).toBeGreaterThanOrEqual(20);
    expect(artifact.summary.passedCount).toBe(artifact.pack.taskCount);
    expect(logs.join("\n")).toContain("Gemmaclaw Agent Benchmark");
  });

  it("keeps --runner agent explicit and fails clearly when no live runner is registered", async () => {
    const { runtime, errors } = makeRuntime();

    await expect(
      benchmarkGemmaCommand({ pack: "agent-fixtures", runner: "agent" }, runtime),
    ).rejects.toThrow(/exit 2/);

    expect(errors.join("\n")).toContain("no live agent runner is registered");
  });
});
