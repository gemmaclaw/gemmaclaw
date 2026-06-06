import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveResults, type AgentBenchmarkResult } from "./agent-runner.js";
import {
  AGENT_BENCHMARK_TASKS,
  ALL_AGENT_BENCHMARK_TASKS,
  BENCHMARK_TEST_TEMPLATE_TARGETS,
  EXPANDED_AGENT_BENCHMARK_TASKS,
  GENERATED_AGENT_VARIATION_TASKS,
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

    expect(OPENCLAW_HARD_WORKFLOW_TASK_IDS).toHaveLength(23);
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

  it("keeps expanded benchmark coverage separate from the default comparable suite", () => {
    const defaultIds = new Set(AGENT_BENCHMARK_TASKS.map((task) => task.id));
    const expandedIds = new Set(EXPANDED_AGENT_BENCHMARK_TASKS.map((task) => task.id));
    const variationIds = new Set(GENERATED_AGENT_VARIATION_TASKS.map((task) => task.id));

    expect(AGENT_BENCHMARK_TASKS).toHaveLength(55);
    expect(EXPANDED_AGENT_BENCHMARK_TASKS).toHaveLength(147);
    expect(GENERATED_AGENT_VARIATION_TASKS).toHaveLength(29400);
    expect(ALL_AGENT_BENCHMARK_TASKS).toHaveLength(29602);
    expect([...expandedIds].some((id) => defaultIds.has(id))).toBe(false);
    expect([...variationIds].some((id) => defaultIds.has(id) || expandedIds.has(id))).toBe(false);
  });

  it("uses Gemmaclaw-owned public naming for expanded benchmark tasks", () => {
    const publicText = EXPANDED_AGENT_BENCHMARK_TASKS.map((task) =>
      [task.id, task.name, task.description, task.category].join("\n"),
    ).join("\n");

    expect(publicText).not.toMatch(/pinchbench/i);
    expect(publicText).not.toMatch(/\bclaw\s+bench\b|\bhermes\b/i);
    expect(EXPANDED_AGENT_BENCHMARK_TASKS.every((task) => task.id.startsWith("expanded_"))).toBe(
      true,
    );
    expect(
      EXPANDED_AGENT_BENCHMARK_TASKS.every((task) => task.category.startsWith("expanded_")),
    ).toBe(true);
    expect(getTaskById("expanded_sanity")).toBeUndefined();
    expect(getTaskById("expanded_sanity", { includeExpanded: true })?.name).toBe(
      "Response Readiness",
    );
  });

  it("locks scheduled media delivery coverage against shadow cron and unverified sends", () => {
    const task = getTaskById("scheduled_media_delivery_verification");

    expect(task).toBeDefined();
    expect(task?.difficulty).toBe("very_hard");
    expect(task?.grading.maxScore).toBeGreaterThanOrEqual(200);

    const taskText = [task!.prompt, ...task!.grading.criteria].join("\n");
    expect(taskText).toContain("state/scheduled-media/active-scheduler.json");
    expect(taskText).toContain("state/scheduled-media/history.jsonl");
    expect(taskText).toContain("state/scheduled-media/latest-audio.mp3");
    expect(taskText).toContain("state/scheduled-media/telegram-send-receipt.json");
    expect(taskText).toContain("delivery_verified");
    expect(taskText).toContain("shadow_cron_created must be false");
    expect(taskText).toContain(
      "Must not claim the immediate Telegram delivery succeeded before receipt read-back exists",
    );
    expect(taskText).toMatch(/workspace\/\.openclaw\/cron\/jobs\.json/);
  });

  it("locks commitment follow-through coverage against empty promises", () => {
    const task = getTaskById("commitment_followthrough_verification");

    expect(task).toBeDefined();
    expect(task?.difficulty).toBe("very_hard");
    expect(task?.grading.maxScore).toBeGreaterThanOrEqual(200);

    const taskText = [task!.prompt, ...task!.grading.criteria].join("\n");
    expect(taskText).toContain("state/local-agent-scheduler/active-jobs.json");
    expect(taskText).toContain("state/local-agent-todos/daily-status-repair.json");
    expect(taskText).toContain("commitment-followthrough-policy.md");
    expect(taskText).toContain("daily-status-scheduler-contract.md");
    expect(taskText).toContain("memory/commitment-followthrough-report.json");
    expect(taskText).toContain("Gemmaclaw-native follow-up");
    expect(taskText).toContain("state/local-agent-work/daily-status-repair-loop.json");
    expect(taskText).toContain("inspect_active_scheduler");
    expect(taskText).toContain("qa_check.status pass");
    expect(taskText).toContain("idle_trigger");
    expect(taskText).toContain("active_owner");
    expect(taskText).toContain("no active owner/subagent/session");
    expect(taskText).toContain("command_invocation_verified");
    expect(taskText).toContain("bash scripts/send_daily_status.sh");
    expect(taskText).toContain("executable by the scheduled runtime");
    expect(taskText).toContain("promise_language_used");
    expect(taskText).toContain("Must not mention external ACP workers");
    expect(taskText).toContain("Must not rely on .openclaw/cron/jobs.json");
    expect(taskText).toMatch(/I'm on it/);
    expect(taskText).toMatch(/workspace\/\.openclaw\/cron\/jobs\.json/);
  });

  it("locks long-horizon follow-through coverage to 20 or more explicit steps", () => {
    const task = getTaskById("long_horizon_20_step_followthrough");

    expect(task).toBeDefined();
    expect(task?.difficulty).toBe("very_hard");
    expect(task?.grading.maxScore).toBeGreaterThanOrEqual(300);

    const taskText = [task!.prompt, ...task!.grading.criteria].join("\n");
    const stepIds = Array.from(taskText.matchAll(/step_\d{2}_[a-z_]+/g)).map((m) => m[0]);
    const uniqueStepIds = new Set(stepIds);

    expect(uniqueStepIds.size).toBeGreaterThanOrEqual(20);
    expect(taskText).toContain("at least 20 subtasks");
    expect(taskText).toContain("20 named step ids");
    expect(taskText).toContain("state/local-agent-work/long-horizon-release-loop.json");
    expect(taskText).toContain("state/long-horizon/active-scheduler.json");
    expect(taskText).toContain("bash scripts/generate_release_packet.sh");
    expect(taskText).toContain("state/long-horizon/mock-send-receipt.json");
    expect(taskText).toContain("memory/long-horizon-release-report.json");
    expect(taskText).toContain("required_step_count must be at least 20");
    expect(taskText).toContain("promise_language_used");
    expect(taskText).toContain("Must not rely on .openclaw/cron/jobs.json");
  });

  it("locks Home AI hill-climb coverage to labelled examples and same-label dedupe", () => {
    const task = getTaskById("home_ai_hill_climb_labelled_examples");

    expect(task).toBeDefined();
    expect(task?.difficulty).toBe("very_hard");
    expect(task?.grading.maxScore).toBeGreaterThanOrEqual(200);

    const taskText = [task!.prompt, ...task!.grading.criteria].join("\n");
    expect(taskText).toContain("ex_litter_white_1956");
    expect(taskText).toContain("2026-05-24T19:56:00-04:00");
    expect(taskText).toContain("white_cat");
    expect(taskText).toContain("ex_feed_cluster_1759_1806");
    expect(taskText).toContain("black_cat/eating");
    expect(taskText).toContain("white_cat/eating");
    expect(taskText).toContain("ex_empty_equipment_negative");
    expect(taskText).toContain("dedupe_window_seconds");
    expect(taskText).toContain("900");
    expect(taskText).toContain("cat and activity");
    expect(taskText).toContain("cat and usage_status");
    expect(taskText).toContain("memory/home-ai-hill-climb-report.json");
    expect(taskText).toContain("state/home-ai-hill-climb/cat_feeding_water/config.json");
    expect(taskText).toContain("state/home-ai-hill-climb/cat_litter_box/config.json");
    expect(taskText).toContain("semantic evaluation");
    expect(taskText).toContain("keyword");
    expect(taskText).toContain("clicked dashboard graph point");
    expect(taskText).toContain("future_agent_prompt");
  });

  it("keeps expanded benchmark task prompts and rubrics publishable", () => {
    for (const task of EXPANDED_AGENT_BENCHMARK_TASKS) {
      expect(task.name.trim().length, `${task.id} has a name`).toBeGreaterThan(3);
      expect(task.description.trim().length, `${task.id} has a description`).toBeGreaterThan(20);
      expect(task.prompt.trim().length, `${task.id} has a prompt`).toBeGreaterThan(50);
      expect(task.grading.criteria.length, `${task.id} has criteria`).toBeGreaterThan(0);
      expect(task.grading.maxScore, `${task.id} has score`).toBeGreaterThan(0);

      const taskText = [task.prompt, ...task.grading.criteria].join("\n");
      expect(taskText, `${task.id} does not expose imported template ids`).not.toMatch(
        /Complete this expanded Gemmaclaw benchmark task `task_|Expanded suite task_|internal template task_/i,
      );
      expect(taskText, `${task.id} does not expose external suite names`).not.toMatch(
        /\bpinchbench\b|\bclaw\s+bench\b|\bhermes\b/i,
      );
    }
  });

  it("declares template targets for scaling toward 1000+ benchmark variations", () => {
    expect(BENCHMARK_TEST_TEMPLATE_TARGETS).toHaveLength(EXPANDED_AGENT_BENCHMARK_TASKS.length);
    expect(
      BENCHMARK_TEST_TEMPLATE_TARGETS.every((template) => template.targetVariations === 200),
    ).toBe(true);
    expect(
      BENCHMARK_TEST_TEMPLATE_TARGETS.reduce(
        (total, template) => total + template.targetVariations,
        0,
      ),
    ).toBe(29400);
  });

  it("keeps all generated template variations high quality and public-safe", () => {
    const seenIds = new Set<string>();
    const countsByTemplate = new Map<string, number>();
    for (const task of GENERATED_AGENT_VARIATION_TASKS) {
      expect(seenIds.has(task.id), `${task.id} is unique`).toBe(false);
      seenIds.add(task.id);
      const templateId = task.id.replace(/^variant_/, "").replace(/_\d{2,3}$/, "");
      countsByTemplate.set(templateId, (countsByTemplate.get(templateId) ?? 0) + 1);

      expect(task.id, `${task.id} uses variant prefix`).toMatch(/^variant_[a-z0-9_]+_\d{2,3}$/);
      expect(task.category, `${task.id} uses variant category`).toMatch(/^variant_/);
      expect(task.name.trim().length, `${task.id} has a name`).toBeGreaterThan(10);
      expect(task.description.trim().length, `${task.id} has a description`).toBeGreaterThan(40);
      expect(task.prompt, `${task.id} has required artifact instruction`).toContain(
        "## Required Output",
      );
      expect(task.prompt, `${task.id} has explicit quality gates`).toContain("## Quality Gates");
      expect(task.prompt, `${task.id} has evidence axis`).toContain("Evidence mode:");
      expect(task.prompt, `${task.id} has ambiguity axis`).toContain("Ambiguity policy:");
      expect(task.prompt, `${task.id} has failure pressure axis`).toContain(
        "Failure pressure to watch for:",
      );
      expect(task.prompt, `${task.id} does not ask agents to manufacture pressure`).toContain(
        "do not invent extra distractors",
      );
      expect(task.prompt, `${task.id} avoids synthetic complication wording`).not.toContain(
        "Include this complication in your reasoning",
      );
      expect(task.prompt, `${task.id} has output contract axis`).toContain("Output contract:");
      expect(
        task.grading.criteria.length,
        `${task.id} has grading criteria`,
      ).toBeGreaterThanOrEqual(6);
      expect(task.grading.maxScore, `${task.id} has score`).toBeGreaterThanOrEqual(40);

      const taskText = [
        task.id,
        task.name,
        task.description,
        task.category,
        task.prompt,
        ...task.grading.criteria,
      ].join("\n");
      expect(taskText, `${task.id} does not expose external suite names`).not.toMatch(
        /\bpinchbench\b|\bclaw\s+bench\b|\bhermes\b/i,
      );
    }

    expect(countsByTemplate.size).toBe(EXPANDED_AGENT_BENCHMARK_TASKS.length);
    expect([...countsByTemplate.values()].every((count) => count === 200)).toBe(true);
    expect(
      GENERATED_AGENT_VARIATION_TASKS.find((task) => task.id === "variant_expanded_calendar_100")
        ?.grading.criteria,
    ).toContain(
      "Applies the variant evidence mode, ambiguity policy, failure pressure, and output contract",
    );
  });
});
