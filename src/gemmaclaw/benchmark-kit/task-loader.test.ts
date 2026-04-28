import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_PACKS,
  builtinPackPath,
  filterQuickTasks,
  loadBenchmarkPack,
  loadBuiltinPack,
  loadCoreTasks,
  loadJakeAgentTasks,
  loadTaskPack,
} from "./task-loader.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("loadCoreTasks", () => {
  it("loads tasks from core.json", () => {
    const tasks = loadCoreTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(10);
  });

  it("tasks have required fields", () => {
    const tasks = loadCoreTasks();
    for (const task of tasks) {
      expect(task.id).toBeTruthy();
      expect(task.name).toBeTruthy();
      expect(task.category).toBeTruthy();
      expect(task.difficulty).toBeTruthy();
      expect(task.prompt).toBeTruthy();
      expect(task.grading.maxScore).toBeGreaterThan(0);
    }
  });

  it("tasks have unique IDs", () => {
    const tasks = loadCoreTasks();
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("BUILTIN_PACKS / builtinPackPath", () => {
  it("declares 'core' and 'jake-agent' as built-in", () => {
    expect(BUILTIN_PACKS).toContain("core");
    expect(BUILTIN_PACKS).toContain("jake-agent");
  });

  it("resolves built-in paths to files in tasks/", () => {
    const corePath = builtinPackPath("core");
    expect(corePath.endsWith(path.join("tasks", "core.json"))).toBe(true);
    expect(builtinPackPath("jake-agent").endsWith(path.join("tasks", "jake-agent.json"))).toBe(
      true,
    );
  });
});

describe("loadJakeAgentTasks", () => {
  it("loads the vendored agent pack with family='agent'", () => {
    const pack = loadJakeAgentTasks();
    expect(pack.family).toBe("agent");
    expect(pack.pack).toBe("jake-agent");
    expect(pack.schemaVersion).toBe("1");
    expect(pack.tasks.length).toBeGreaterThanOrEqual(20);
  });

  it("agent tasks declare snake_case max_score and a known grading type", () => {
    const pack = loadJakeAgentTasks();
    const allowedTypes = new Set([
      "output_check",
      "command_check",
      "artifact_check",
      "file_check",
      "multi_check",
      "security_check",
      "error_check",
    ]);
    for (const task of pack.tasks) {
      expect(allowedTypes.has(task.grading.type)).toBe(true);
      expect(task.grading.max_score).toBeGreaterThan(0);
    }
  });

  it("task ids are unique", () => {
    const pack = loadJakeAgentTasks();
    const ids = pack.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("loadBenchmarkPack", () => {
  it("returns 'tool-free' for the legacy core.json shape", () => {
    const pack = loadBenchmarkPack(builtinPackPath("core"));
    expect(pack.family).toBe("tool-free");
    expect(pack.tasks.length).toBeGreaterThan(0);
  });

  it("returns 'agent' for the v1 jake-agent.json", () => {
    const pack = loadBenchmarkPack(builtinPackPath("jake-agent"));
    expect(pack.family).toBe("agent");
  });
});

describe("loadBuiltinPack", () => {
  it("loads core by name", () => {
    const pack = loadBuiltinPack("core");
    expect(pack.family).toBe("tool-free");
  });

  it("loads jake-agent by name", () => {
    const pack = loadBuiltinPack("jake-agent");
    expect(pack.family).toBe("agent");
  });
});

describe("loadTaskPack on agent packs", () => {
  it("rejects agent packs with a clear error (legacy callers must migrate)", () => {
    expect(() => loadTaskPack(path.join(HERE, "tasks", "jake-agent.json"))).toThrow(
      /family='agent'/,
    );
  });
});

describe("filterQuickTasks", () => {
  it("returns subset tagged quick", () => {
    const all = loadCoreTasks();
    const quick = filterQuickTasks(all);
    expect(quick.length).toBeGreaterThan(0);
    expect(quick.length).toBeLessThan(all.length);
  });

  it("quick tasks are a subset of all tasks", () => {
    const all = loadCoreTasks();
    const quick = filterQuickTasks(all);
    const allIds = new Set(all.map((t) => t.id));
    for (const t of quick) {
      expect(allIds.has(t.id)).toBe(true);
    }
  });
});
