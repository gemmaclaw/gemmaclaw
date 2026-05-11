import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveResults, type AgentBenchmarkResult } from "./agent-runner.js";
import {
  AGENT_BENCHMARK_TASKS,
  OPENCLAW_HARD_WORKFLOW_TASK_IDS,
  type AgentTaskCategory,
  evaluateDeterministicAgentTaskConversation,
  evaluateDeterministicAgentTaskOutput,
  getTaskById,
  getTasksByDifficulty,
} from "./agent-tasks.js";

const EASY_TASK_IDS = ["gemma3n_json_extract", "gemma3n_tool_intent"];
const AGENT_TASK_CATEGORIES: AgentTaskCategory[] = [
  "email",
  "calendar",
  "task_management",
  "multi_step",
  "security",
  "error_recovery",
  "memory",
  "ambiguous",
  "data_analysis",
  "coordination",
  "structured_output",
  "tool_intent",
];
describe("Gemma 3n easy agent benchmark tasks", () => {
  it("registers the two easy tasks in the agent benchmark list", () => {
    const easyTasks = getTasksByDifficulty("easy");

    expect(easyTasks.map((task) => task.id)).toEqual(EASY_TASK_IDS);
    expect(AGENT_BENCHMARK_TASKS.slice(0, 2).map((task) => task.id)).toEqual(EASY_TASK_IDS);
  });

  it("includes deterministic fixtures and scoring metadata", () => {
    for (const id of EASY_TASK_IDS) {
      const task = getTaskById(id);

      expect(task).toBeDefined();
      expect(task?.difficulty).toBe("easy");
      expect(task?.grading.maxScore).toBe(5);
      expect(task?.grading.deterministic).toBeDefined();
      expect(task?.mock?.finalResponse).toBeTruthy();
    }
  });

  it("passes deterministic scoring for the structured JSON mock response", () => {
    const task = getTaskById("gemma3n_json_extract")!;
    const score = evaluateDeterministicAgentTaskOutput(task, task.mock!.finalResponse);

    expect(score).toMatchObject({ score: 5, maxScore: 5, percentage: 100, passed: true });
  });

  it("passes deterministic scoring for the single-step tool intent mock response", () => {
    const task = getTaskById("gemma3n_tool_intent")!;
    const score = evaluateDeterministicAgentTaskOutput(task, task.mock!.finalResponse);

    expect(score).toMatchObject({ score: 5, maxScore: 5, percentage: 100, passed: true });
  });

  it("fails deterministic scoring for invalid JSON", () => {
    const task = getTaskById("gemma3n_json_extract")!;
    const score = evaluateDeterministicAgentTaskOutput(task, "Maya wants a checklist Friday.");

    expect(score).toMatchObject({ score: 0, maxScore: 5, percentage: 0, passed: false });
    expect(score?.details).toContain("not a JSON object");
  });

  it("penalizes wrong tool intent actions", () => {
    const task = getTaskById("gemma3n_tool_intent")!;
    const score = evaluateDeterministicAgentTaskOutput(
      task,
      '{"action":"send_email","arguments":{"to":"priya@example.com","subject":"Q2 forecast","body":"Reminder"}}',
    );

    expect(score?.passed).toBe(false);
    expect(score?.details).toContain("expected action create_task");
  });

  it("scores the final assistant response from a conversation transcript", () => {
    const task = getTaskById("gemma3n_tool_intent")!;
    const score = evaluateDeterministicAgentTaskConversation(task, [
      { role: "user", content: task.prompt },
      { role: "assistant", content: "thinking" },
      { role: "assistant", content: task.mock!.finalResponse },
    ]);

    expect(score).toMatchObject({ score: 5, passed: true });
  });

  it("writes deterministic evaluation stubs for schema-scored tasks", () => {
    const task = getTaskById("gemma3n_json_extract")!;
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemma3n-agent-eval-"));
    const result: AgentBenchmarkResult = {
      config: {
        gatewayUrl: "http://localhost:3001",
        backend: "llama-cpp",
        ollamaUrl: "http://127.0.0.1:11434",
        llamaCppUrl: "http://127.0.0.1:8080",
        model: "gemma-3n-e2b-it-q4_k_m",
        taskTimeoutSeconds: 60,
        idleTimeoutSeconds: 5,
        mock: true,
      },
      metadata: {
        model: "gemma-3n-e2b-it-q4_k_m",
        hardware: {
          cpu: { arch: "arm64", cores: 4, model: "Raspberry Pi 5" },
          ram: { totalBytes: 8_000_000_000, availableBytes: 5_000_000_000 },
          gpu: { detected: false, nvidia: false, apple: false },
        },
        gatewayUrl: "http://localhost:3001",
        ollamaUrl: "http://127.0.0.1:11434",
        startedAt: "2026-05-04T00:00:00.000Z",
        finishedAt: "2026-05-04T00:00:01.000Z",
      },
      tasks: [
        {
          task,
          conversation: [
            { role: "user", content: task.prompt },
            { role: "assistant", content: task.mock!.finalResponse },
          ],
          elapsedMs: 1000,
          toolCallCount: 0,
          toolsUsed: [],
          completionStatus: "completed",
        },
      ],
      summary: {
        totalTasks: 1,
        completedCount: 1,
        errorCount: 0,
        timeoutCount: 0,
        totalTimeMs: 1000,
        totalToolCalls: 0,
        avgToolCallsPerTask: 0,
      },
    };

    saveResults(result, outputDir);

    const evalRuns = fs.readdirSync(path.join(outputDir, "evaluations"));
    expect(evalRuns).toHaveLength(1);
    const evalStub = JSON.parse(
      fs.readFileSync(path.join(outputDir, "evaluations", evalRuns[0], `${task.id}.json`), "utf8"),
    );
    expect(evalStub.deterministicScorer).toMatchObject({ score: 5, passed: true });
    expect(evalStub.llmJudge).toBeNull();
  });

  it("registers the full hard OpenClaw-style workflow suite by default without private fixture terms", () => {
    const newTaskCategories = new Set<AgentTaskCategory>();
    const defaultTaskIds = AGENT_BENCHMARK_TASKS.map((task) => task.id);

    for (const id of OPENCLAW_HARD_WORKFLOW_TASK_IDS) {
      const task = getTaskById(id);

      expect(task).toBeDefined();
      expect(defaultTaskIds).toContain(id);
      expect(task?.difficulty).toBe("very_hard");
      expect(task?.grading.maxScore).toBeGreaterThanOrEqual(90);
      newTaskCategories.add(task!.category);
    }

    expect(OPENCLAW_HARD_WORKFLOW_TASK_IDS).toHaveLength(19);
    expect(newTaskCategories.size).toBeGreaterThanOrEqual(7);

    const taskText = OPENCLAW_HARD_WORKFLOW_TASK_IDS.map((id) => {
      const task = getTaskById(id)!;
      return [task.id, task.name, task.description, task.prompt, ...task.grading.criteria].join(
        "\n",
      );
    }).join("\n");

    expect(taskText).not.toMatch(
      /Frank|Charlotte|Doraemon|Doramon|lifrank|wsfccorp|Massachusetts|Markham/i,
    );
  });

  it("keeps at least one agent benchmark task in every category", () => {
    const categories = new Set(AGENT_BENCHMARK_TASKS.map((task) => task.category));

    for (const category of AGENT_TASK_CATEGORIES) {
      expect(categories.has(category), `missing category ${category}`).toBe(true);
    }
  });
});
