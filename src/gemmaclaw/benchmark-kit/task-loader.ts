/**
 * Task pack loader: reads JSON task packs and converts to BenchmarkTask objects.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkTask } from "../benchmark/tasks.js";

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
 * Load the built-in core task pack.
 */
export function loadCoreTasks(): BenchmarkTask[] {
  const packPath = path.join(__dirname, "tasks", "core.json");
  return loadTaskPack(packPath);
}

/**
 * Load a task pack from a JSON file path.
 */
export function loadTaskPack(filePath: string): BenchmarkTask[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const pack: TaskPackJson = JSON.parse(raw);

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
