/**
 * Task pack loader: reads JSON task packs and converts to BenchmarkTask
 * objects (legacy tool-free shape) or typed `BenchmarkPack` objects (v1
 * shape with family discriminator).
 *
 * Two surfaces are exposed:
 *   - `loadCoreTasks()` / `loadTaskPack()` / `filterQuickTasks()`:
 *       legacy tool-free helpers that produce `BenchmarkTask[]`. Existing
 *       callers (`gemmaclaw benchmark`) keep using these.
 *   - `loadBenchmarkPack()` / `loadBuiltinPack()` / `loadAgentFixtureTasks()`:
 *       v1 helpers that produce typed `BenchmarkPack` objects, including
 *       agent packs that the core-model runner cannot grade.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkTask } from "../benchmark/tasks.js";
import { type AgentPack, type BenchmarkPack, parseBenchmarkPack } from "./pack-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TaskPackJson = {
  pack: string;
  version: string;
  description: string;
  tasks: Array<{
    id: string;
    name: string;
    category: string;
    difficulty: string;
    prompt: string;
    system?: string;
    grading: {
      type: string;
      expected?: string[];
      requiredKeys?: string[];
      criteria?: string[];
      maxScore: number;
    };
    mock?: {
      prompt?: string;
      expectedOutput: string;
      fuzzyMatches?: string[];
    };
    tags?: string[];
  }>;
};

/**
 * Built-in task pack identifiers that ship with benchmark-kit.
 */
export const BUILTIN_PACKS = ["core", "agent-fixtures"] as const;
export type BuiltinPackName = (typeof BUILTIN_PACKS)[number];

/**
 * Resolve a built-in pack name to an absolute file path.
 */
export function builtinPackPath(name: BuiltinPackName): string {
  return path.join(__dirname, "tasks", `${name}.json`);
}

/**
 * Load the built-in tool-free core task pack.
 */
export function loadCoreTasks(): BenchmarkTask[] {
  return loadTaskPack(builtinPackPath("core"));
}

/**
 * Load a tool-free task pack from a JSON file path. Legacy shape (no
 * `family`/`schemaVersion`) and v1 `family: "tool-free"` shape both work.
 *
 * Throws if the file is an agent pack: tool-free callers should use
 * `loadBenchmarkPack` for the discriminated-union surface.
 */
export function loadTaskPack(filePath: string): BenchmarkTask[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsedJson = JSON.parse(raw) as Record<string, unknown>;
  if (parsedJson.family === "agent") {
    throw new Error(
      `task pack at ${filePath} is family='agent'; use loadBenchmarkPack() ` +
        `or loadAgentFixtureTasks() instead`,
    );
  }
  const pack = parsedJson as unknown as TaskPackJson;

  return pack.tasks.map((t) =>
    Object.assign(
      {
        id: t.id,
        name: t.name,
        category: t.category as BenchmarkTask[`category`],
        difficulty: t.difficulty as BenchmarkTask[`difficulty`],
        prompt: t.prompt,
        system: t.system,
        grading: {
          type: t.grading.type as BenchmarkTask[`grading`][`type`],
          expected: t.grading.expected,
          requiredKeys: t.grading.requiredKeys,
          criteria: t.grading.criteria,
          maxScore: t.grading.maxScore,
        },
        mock: t.mock
          ? {
              prompt: t.mock.prompt,
              expectedOutput: t.mock.expectedOutput,
              fuzzyMatches: t.mock.fuzzyMatches,
            }
          : undefined,
      },
      (t.tags?.length ?? 0) > 0 ? { tags: t.tags } : {},
    ),
  );
}

/**
 * Filter tasks to those tagged "quick" for the fast benchmark mode.
 */
export function filterQuickTasks(tasks: BenchmarkTask[]): BenchmarkTask[] {
  return tasks.filter((t) => (t as BenchmarkTask & { tags?: string[] }).tags?.includes("quick"));
}

/**
 * Load a v1-shaped pack file as a typed `BenchmarkPack`. Accepts both the
 * v1 shape and the legacy benchmark-kit shape (auto-promoted to
 * `family: "tool-free"`).
 */
export function loadBenchmarkPack(filePath: string): BenchmarkPack {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsedJson = JSON.parse(raw) as unknown;
  return parseBenchmarkPack(parsedJson);
}

/**
 * Load a built-in pack by name (`"core"` or `"agent-fixtures"`).
 */
export function loadBuiltinPack(name: BuiltinPackName): BenchmarkPack {
  return loadBenchmarkPack(builtinPackPath(name));
}

/**
 * Convenience: load the built-in agent-fixtures pack as a typed `AgentPack`.
 * Throws if the vendored pack is somehow not family='agent' (would mean a
 * regression in the source-of-truth file).
 */
export function loadAgentFixtureTasks(): AgentPack {
  const pack = loadBuiltinPack("agent-fixtures");
  if (pack.family !== "agent") {
    throw new Error(`built-in agent-fixtures pack must be family='agent', got '${pack.family}'`);
  }
  return pack;
}
