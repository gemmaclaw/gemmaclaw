import { describe, expect, it } from "vitest";
import { loadCoreTasks, filterQuickTasks } from "./task-loader.js";

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
