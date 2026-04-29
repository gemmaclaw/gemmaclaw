import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  anonymizeOnDiskResult,
  deriveRunId,
  findNewestResultsDir,
  submitBenchmarkCommand,
} from "./submit-benchmark.js";

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

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "submit-benchmark-test-"));
  tmpDirs.push(root);
  return root;
}

function writeRun(
  root: string,
  name: string,
  payload: Record<string, unknown>,
  ageMs: number,
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "results.json");
  fs.writeFileSync(file, JSON.stringify(payload));
  const t = Date.now() - ageMs;
  fs.utimesSync(dir, t / 1000, t / 1000);
  fs.utimesSync(file, t / 1000, t / 1000);
  return dir;
}

describe("findNewestResultsDir", () => {
  it("returns the most recently modified subdir containing results.json", () => {
    const root = makeRoot();
    writeRun(root, "old", { model: "gemma3:4b" }, 60_000);
    const newDir = writeRun(root, "newer", { model: "gemma3:12b" }, 1_000);
    expect(findNewestResultsDir(root)).toBe(newDir);
  });

  it("ignores subdirs without results.json", () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "empty"), { recursive: true });
    const valid = writeRun(root, "real", { model: "gemma3:4b" }, 1_000);
    expect(findNewestResultsDir(root)).toBe(valid);
  });

  it("throws a clear error when no candidates exist", () => {
    const root = makeRoot();
    expect(() => findNewestResultsDir(root)).toThrow(/No benchmark result directories/);
  });

  it("throws when the root does not exist", () => {
    const missing = path.join(makeRoot(), "does-not-exist");
    expect(() => findNewestResultsDir(missing)).toThrow(/Results root does not exist/);
  });
});

describe("anonymizeOnDiskResult", () => {
  it("strips hostname and username from string fields", () => {
    const hostname = os.hostname();
    const username = os.userInfo().username;
    const payload = {
      hardware: {
        cpu: `Some CPU on ${hostname} for ${username}`,
      },
      config: {
        ollamaUrl: "http://127.0.0.1:11434",
      },
    };
    const out = anonymizeOnDiskResult(payload);
    const cpu = (out.hardware as { cpu: string }).cpu;
    expect(cpu).not.toContain(hostname);
    expect(cpu).not.toContain(username);
    expect(cpu).toContain("<host>");
    expect(cpu).toContain("<user>");
    const config = out.config as { ollamaUrl: string };
    expect(config.ollamaUrl).toBe("<private-url>");
  });

  it("redacts private URLs (RFC1918) but leaves public URLs intact", () => {
    const payload = {
      links: {
        local: "http://192.168.1.5:8080",
        public: "https://example.com/path",
      },
    };
    const out = anonymizeOnDiskResult(payload);
    const links = out.links as { local: string; public: string };
    expect(links.local).toBe("<private-url>");
    expect(links.public).toBe("https://example.com/path");
  });

  it("leaves nested non-string values untouched", () => {
    const payload = { summary: { totalScore: 100, percentage: 95.5, passed: true } };
    const out = anonymizeOnDiskResult(payload);
    const summary = out.summary as { totalScore: number; percentage: number; passed: boolean };
    expect(summary.totalScore).toBe(100);
    expect(summary.percentage).toBe(95.5);
    expect(summary.passed).toBe(true);
  });
});

describe("deriveRunId", () => {
  it("uses model + timestamp for core-model results", () => {
    const id = deriveRunId(
      { model: "gemma3:4b", timestamp: "2026-04-28T21:02:21.758Z" },
      "fallback",
    );
    expect(id).toBe("gemma3-4b__2026-04-28T21-02-21");
  });

  it("uses pack + runner + timestamp for agent-family results", () => {
    const id = deriveRunId(
      {
        benchmarkFamily: "agent",
        pack: { id: "jake-agent" },
        runner: { name: "mock-agent" },
        timestamp: "2026-04-28T21:01:07.719Z",
      },
      "fallback",
    );
    expect(id).toBe("jake-agent__mock-agent__2026-04-28T21-01-07");
  });

  it("falls back to the directory name when shape is unknown", () => {
    const id = deriveRunId({ summary: {} } as Record<string, unknown>, "weird-run-2026");
    expect(id).toBe("weird-run-2026");
  });
});

describe("submitBenchmarkCommand", () => {
  it("dry-run prints anonymized payload and PR body without invoking gh", async () => {
    const root = makeRoot();
    const dir = writeRun(
      root,
      "gemma3-4b__ollama__test",
      {
        model: "gemma3:4b",
        backend: "ollama",
        timestamp: "2026-04-28T21:02:21.758Z",
        config: { ollamaUrl: "http://127.0.0.1:11434", mock: true },
        hardware: { cpu: `Test CPU on ${os.hostname()}`, ram: "32 GB", gpu: "None detected" },
        summary: { totalScore: 100, maxScore: 140, percentage: 71 },
      },
      0,
    );
    const { runtime, logs, errors, exits } = makeRuntime();
    const result = await submitBenchmarkCommand(
      { resultsDir: dir, dryRun: true, repo: "gemmaclaw/gemmaclaw" },
      runtime,
    );
    expect(result).toBeNull();
    expect(exits).toEqual([]);
    expect(errors).toEqual([]);
    const out = logs.join("\n");
    expect(out).toContain("ANONYMIZED PAYLOAD");
    expect(out).toContain("PR BODY");
    expect(out).not.toContain(os.hostname());
    expect(out).toContain("Dry run complete");
  });

  it("exits with a clear error when results.json is missing", async () => {
    const root = makeRoot();
    const dir = path.join(root, "no-results");
    fs.mkdirSync(dir);
    const { runtime, errors } = makeRuntime();
    await expect(
      submitBenchmarkCommand({ resultsDir: dir, dryRun: true }, runtime),
    ).rejects.toThrow(/exit 2/);
    expect(errors.join("\n")).toContain("No results.json found");
  });

  it("exits with a clear error when results.json is invalid JSON", async () => {
    const root = makeRoot();
    const dir = path.join(root, "bad-json");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "results.json"), "{not valid");
    const { runtime, errors } = makeRuntime();
    await expect(
      submitBenchmarkCommand({ resultsDir: dir, dryRun: true }, runtime),
    ).rejects.toThrow(/exit 2/);
    expect(errors.join("\n")).toContain("Failed to parse");
  });
});
