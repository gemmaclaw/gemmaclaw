import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentTaskResult } from "./agent-runner.js";
import type { AgentBenchmarkTask } from "./agent-tasks.js";
import {
  HOST_OAUTH_MARKERS,
  HOST_PATH_MARKERS,
  REAL_ACCOUNT_MARKERS,
  inspectTaskQuality,
  summarizeValidation,
  summarizeQualityInspection,
  validateTaskArtifact,
} from "./agent-validator.js";

const baseTask: AgentBenchmarkTask = {
  id: "validator_email_smoke",
  name: "Validator Email Smoke",
  description: "Test fixture",
  category: "email",
  difficulty: "medium",
  prompt: "Check inbox",
  grading: { type: "conversation_check", criteria: ["reads inbox"], maxScore: 10 },
};

function freshRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gemmaclaw-validator-"));
}

function writeTaskArtifacts(
  runDir: string,
  taskId: string,
  opts: {
    transcript?: string;
    sessionJsonl?: string;
    trajectoryJsonl?: string;
  } = {},
): void {
  const taskDir = path.join(runDir, "tasks", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  if (opts.transcript !== undefined) {
    fs.writeFileSync(path.join(taskDir, "transcript.txt"), opts.transcript);
  }
  if (opts.sessionJsonl !== undefined) {
    fs.writeFileSync(path.join(taskDir, "session.jsonl"), opts.sessionJsonl);
  }
  if (opts.trajectoryJsonl !== undefined) {
    fs.writeFileSync(path.join(taskDir, "trajectory.jsonl"), opts.trajectoryJsonl);
  }
}

const okConversation: AgentTaskResult["conversation"] = [
  { role: "user", content: "Check inbox" },
  { role: "assistant", content: "I will check it." },
  { role: "tool_call", toolName: "gog", toolArgs: { cmd: "gmail list" }, content: "{}" },
  { role: "tool_result", content: "3 emails from alex@acme-corp.dev" },
  { role: "assistant", content: "You have 3 emails." },
];

function makeResult(overrides: Partial<AgentTaskResult> = {}): AgentTaskResult {
  return {
    task: baseTask,
    conversation: okConversation,
    elapsedMs: 1234,
    toolCallCount: 1,
    toolsUsed: ["gog"],
    completionStatus: "completed",
    ...overrides,
  };
}

describe("validateTaskArtifact", () => {
  it("passes a clean fake-gog email task", () => {
    const runDir = freshRunDir();
    writeTaskArtifacts(runDir, baseTask.id, {
      transcript: "[user] Check inbox\n[assistant] You have 3 emails from alex@acme-corp.dev",
      sessionJsonl:
        '{"timestamp":"t","message":{"role":"assistant","content":"You have 3 emails."}}\n',
      trajectoryJsonl: '{"type":"session.ended","status":"ok"}\n',
    });
    const fakeGogLogPath = path.join(runDir, "fake-gog.log");
    fs.writeFileSync(fakeGogLogPath, "gog gmail list -> 3 mock messages\n");

    const validation = validateTaskArtifact({
      runDir,
      task: baseTask,
      result: makeResult(),
      fakeGogLogPath,
    });

    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
  });

  it("blocks when transcript is empty", () => {
    const runDir = freshRunDir();
    writeTaskArtifacts(runDir, baseTask.id, { transcript: "", sessionJsonl: "" });
    const validation = validateTaskArtifact({
      runDir,
      task: baseTask,
      result: makeResult({ conversation: [], completionStatus: "error" }),
    });
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((i) => i.kind)).toContain("transcript_empty");
    expect(summarizeValidation(validation)).toContain("block:transcript_empty");
  });

  it("blocks when completed but no assistant turn is present", () => {
    const runDir = freshRunDir();
    writeTaskArtifacts(runDir, baseTask.id, {
      transcript: "[user] Check inbox\n[tool_result] something",
    });
    const result = makeResult({
      conversation: [
        { role: "user", content: "Check inbox" },
        { role: "tool_result", content: "something" },
      ],
    });
    const validation = validateTaskArtifact({ runDir, task: baseTask, result });
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((i) => i.kind)).toContain("no_assistant_turn");
  });

  it("blocks long-horizon results with pending required steps", () => {
    const task: AgentBenchmarkTask = {
      ...baseTask,
      id: "long_horizon_20_step_followthrough",
    };
    const runDir = freshRunDir();
    writeTaskArtifacts(runDir, task.id, {
      transcript: `[assistant] Done\n[tool_result] {
        "completed_step_ids": ["step_01_read_email", "step_02_read_policy"],
        "pending_step_ids": ["step_18_create_followup_if_needed"]
      }`,
    });

    const validation = validateTaskArtifact({
      runDir,
      task,
      result: makeResult({ task }),
    });

    expect(validation.valid).toBe(false);
    expect(validation.issues.map((i) => i.kind)).toContain("long_horizon_report_incomplete");
    expect(summarizeValidation(validation)).toContain("block:long_horizon_report_incomplete");
  });

  it("accepts long-horizon results that list all steps completed with no pending steps", () => {
    const task: AgentBenchmarkTask = {
      ...baseTask,
      id: "long_horizon_20_step_followthrough",
    };
    const completed = Array.from({ length: 20 }, (_, index) => {
      const stepNumber = String(index + 1).padStart(2, "0");
      const suffixes = [
        "read_email",
        "read_policy",
        "read_contract",
        "read_sources",
        "read_log",
        "inspect_scheduler",
        "verify_command_target",
        "fix_scheduler_command",
        "generate_release_notes",
        "validate_release_notes",
        "update_risk_register",
        "create_rollout_checklist",
        "prepare_stakeholder_message",
        "create_delivery_artifact",
        "run_mock_delivery",
        "read_delivery_receipt",
        "update_dedupe_history",
        "create_followup_if_needed",
        "qa_readback",
        "write_final_report",
      ];
      return `step_${stepNumber}_${suffixes[index]}`;
    });
    const runDir = freshRunDir();
    writeTaskArtifacts(runDir, task.id, {
      transcript: `[assistant] Done\n[tool_result] ${JSON.stringify({
        completed_step_ids: completed,
        pending_step_ids: [],
      })}`,
    });

    const validation = validateTaskArtifact({
      runDir,
      task,
      result: makeResult({ task }),
    });

    expect(validation.issues.map((i) => i.kind)).not.toContain("long_horizon_report_incomplete");
  });

  it("blocks when transcript contains a real account marker", () => {
    const runDir = freshRunDir();
    writeTaskArtifacts(runDir, baseTask.id, {
      transcript: "[assistant] Latest mail is from lifrank1994@gmail.com about the genie deploy.",
    });
    const validation = validateTaskArtifact({ runDir, task: baseTask, result: makeResult() });
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((i) => i.kind)).toContain("real_account_marker");
    const evidence = validation.issues.find((i) => i.kind === "real_account_marker")?.evidence;
    expect(evidence).toContain("lifrank1994@gmail.com");
  });

  it("blocks when session jsonl contains an OAuth-shaped token", () => {
    const runDir = freshRunDir();
    writeTaskArtifacts(runDir, baseTask.id, {
      sessionJsonl:
        '{"timestamp":"t","message":{"role":"assistant","content":"got token ya29.A0ARrdaM_ABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"}}\n',
    });
    const validation = validateTaskArtifact({ runDir, task: baseTask, result: makeResult() });
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((i) => i.kind)).toContain("host_oauth_marker");
  });

  it("blocks when trajectory references the real user state dir", () => {
    const runDir = freshRunDir();
    writeTaskArtifacts(runDir, baseTask.id, {
      trajectoryJsonl:
        '{"type":"tool.exec","cmd":"ls /home/frank/.config/gogcli/state","result":"..."}\n',
    });
    const validation = validateTaskArtifact({ runDir, task: baseTask, result: makeResult() });
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((i) => i.kind)).toContain("host_path_leak");
  });

  it("blocks when trajectory ends with a session.ended error", () => {
    const runDir = freshRunDir();
    writeTaskArtifacts(runDir, baseTask.id, {
      trajectoryJsonl:
        '{"type":"session.ended","status":"error","error":{"message":"LLM idle timeout"}}\n',
    });
    const validation = validateTaskArtifact({ runDir, task: baseTask, result: makeResult() });
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((i) => i.kind)).toContain("trajectory_error");
  });

  it("warns (not blocks) when fake-gog log is missing for a gog-touching task", () => {
    const runDir = freshRunDir();
    writeTaskArtifacts(runDir, baseTask.id, {
      transcript: "[user] Check inbox\n[assistant] You have 3 emails.",
    });
    const validation = validateTaskArtifact({
      runDir,
      task: baseTask,
      result: makeResult(),
      fakeGogLogPath: path.join(runDir, "fake-gog.log"), // does not exist
    });
    expect(validation.valid).toBe(true);
    expect(validation.issues.map((i) => i.kind)).toContain("fake_gog_missing");
    const issue = validation.issues.find((i) => i.kind === "fake_gog_missing");
    expect(issue?.severity).toBe("warn");
  });

  it("does not flag fake-gog when the task does not invoke gog", () => {
    const runDir = freshRunDir();
    const result = makeResult({
      conversation: [
        { role: "user", content: "Extract this JSON" },
        { role: "assistant", content: '{"person":"Maya Chen"}' },
      ],
      toolsUsed: [],
      toolCallCount: 0,
    });
    writeTaskArtifacts(runDir, baseTask.id, {
      transcript: '[user] Extract\n[assistant] {"person":"Maya Chen"}',
    });
    const validation = validateTaskArtifact({ runDir, task: baseTask, result });
    expect(validation.issues.map((i) => i.kind)).not.toContain("fake_gog_missing");
  });

  it("exposes the marker lists for site rendering", () => {
    expect(REAL_ACCOUNT_MARKERS).toContain("lifrank1994@gmail.com");
    expect(REAL_ACCOUNT_MARKERS).toContain("wsfccorp@gmail.com");
    expect(HOST_OAUTH_MARKERS.length).toBeGreaterThan(0);
    expect(HOST_PATH_MARKERS).toContain("/home/frank/.config/gogcli/state");
  });
});

describe("inspectTaskQuality", () => {
  it("records score-readiness info when an LLM judge is missing", () => {
    const runDir = freshRunDir();
    writeTaskArtifacts(runDir, baseTask.id, {
      transcript: "[user] Check inbox\n[assistant] You have 3 emails.",
    });
    const validation = validateTaskArtifact({
      runDir,
      task: baseTask,
      result: makeResult(),
      fakeGogLogPath: path.join(runDir, "fake-gog.log"),
    });

    const inspection = inspectTaskQuality({
      runDir,
      task: baseTask,
      result: makeResult(),
      validation,
      llmJudgePresent: false,
      inspectedAt: "2026-05-10T19:40:00.000Z",
    });

    expect(inspection.publishable).toBe(false);
    expect(inspection.issues.map((issue) => issue.kind)).toContain("llm_judge_missing");
    expect(summarizeQualityInspection(inspection)).toContain("info:llm_judge_missing");
  });

  it("flags malformed tool usage for critical post-task review", () => {
    const runDir = freshRunDir();
    const transcript = [
      '[tool_call] exec {"command":"gog calendar create \\"Backend\\" \\"2026-05-13T10:00:00\\""}',
      '[tool_result] {"id":"evt_1","calendarId":"Backend","summary":"2026-05-13T10:00:00","start":null,"end":null}',
      "[tool_result] {}",
      "(Command exited with code 3)",
    ].join("\n");
    writeTaskArtifacts(runDir, baseTask.id, { transcript });
    const result = makeResult({
      conversation: [
        { role: "user", content: "Schedule meetings" },
        {
          role: "tool_call",
          toolName: "exec",
          toolArgs: { command: 'gog tasks create --notes "Budget: $1200"' },
          content: '{"command":"gog tasks create --notes \\"Budget: $1200\\""}',
        },
        { role: "tool_result", content: transcript },
        { role: "assistant", content: "Done." },
      ],
    });

    const inspection = inspectTaskQuality({
      runDir,
      task: baseTask,
      result,
      validation: { valid: true, issues: [] },
      llmJudgePresent: true,
      inspectedAt: "2026-05-10T19:41:00.000Z",
    });

    expect(inspection.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining([
        "tool_command_failed",
        "malformed_calendar_output",
        "shell_dollar_expansion_risk",
      ]),
    );
    expect(inspection.publishable).toBe(true);
  });

  it("blocks publication when validation blocked or task did not complete", () => {
    const runDir = freshRunDir();
    writeTaskArtifacts(runDir, baseTask.id, { transcript: "" });
    const validation = validateTaskArtifact({
      runDir,
      task: baseTask,
      result: makeResult({ conversation: [], completionStatus: "error" }),
    });

    const inspection = inspectTaskQuality({
      runDir,
      task: baseTask,
      result: makeResult({ conversation: [], completionStatus: "error" }),
      validation,
      llmJudgePresent: true,
    });

    expect(inspection.publishable).toBe(false);
    expect(inspection.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining(["validation_blocked", "task_not_completed"]),
    );
  });
});
