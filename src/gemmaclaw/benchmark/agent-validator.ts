/**
 * Per-task benchmark validation gate.
 *
 * Runs after each task dispatch and before moving on to the next task. Catches
 * harness bugs, transcript regressions, and isolation breaches that would
 * otherwise contaminate the benchmark result set:
 *
 *   1. Transcript / conversation must be non-empty and contain at least one
 *      assistant turn that is not just a thinking block.
 *   2. Trajectory and session JSONL must not record a terminal session error
 *      (already caught in the runner, but we re-confirm against the persisted
 *      artifact in case the runner missed a late error frame).
 *   3. No real-account markers may appear in transcript / session / trajectory.
 *      The list lives in {@link REAL_ACCOUNT_MARKERS} and includes Frank's real
 *      Gmail addresses, the WSFC corporate sender pattern, and the
 *      "Pesonal/Myself" tag that has shown up in past contamination incidents.
 *   4. No host OAuth tokens or paths to the real user state dir may leak into
 *      the artifact. Token shapes (`ya29.`, `1//`, `gho_`, `sk-ant-`) and the
 *      forbidden host paths are matched explicitly.
 *   5. Fake-gog must have been on PATH (presence of the fake-gog log file or a
 *      "(fake-gog)" marker in stdout). When the task spawned at least one
 *      `exec` tool call referencing `gog`, the fake-gog log must exist; this
 *      is the strongest "the agent talked to mocks, not real Google" check we
 *      can perform offline.
 *   6. Deterministic scorer (when configured for the task) must produce a
 *      score. A null deterministic result on a task that requires JSON / tool
 *      intent output is a validation failure, not a model failure.
 *
 * Validation is intentionally read-only over persisted artifacts. The runner
 * passes the run dir + task id; everything we need (transcript.txt,
 * session.jsonl, trajectory.jsonl, and the in-memory result) is already on
 * disk by the time `validateTaskArtifact` is called.
 *
 * Severity:
 *   - "block": the task result must not move on. The runner reruns the task
 *     once, and if the issue persists records the validation issues on the
 *     final artifact and continues to the next task with completionStatus
 *     forced to "error".
 *   - "warn": logged into the artifact and surfaced via the run summary, but
 *     does not block forward progress.
 */

import fs from "node:fs";
import path from "node:path";
import {
  evaluateDeterministicAgentTaskConversation,
  type AgentBenchmarkTask,
} from "./agent-tasks.js";
import type { ConversationTurn, ValidatableTaskResult } from "./agent-types.js";

export type ValidationSeverity = "block" | "warn";

export type ValidationIssueKind =
  | "transcript_empty"
  | "no_assistant_turn"
  | "trajectory_error"
  | "real_account_marker"
  | "host_oauth_marker"
  | "host_path_leak"
  | "fake_gog_missing"
  | "deterministic_scorer_missing";

export type ValidationIssue = {
  kind: ValidationIssueKind;
  severity: ValidationSeverity;
  message: string;
  /** Optional excerpt (clipped) showing where the issue was found. */
  evidence?: string;
};

export type ValidationResult = {
  valid: boolean;
  issues: ValidationIssue[];
  /** Computed deterministic score when task ships a deterministic grader. */
  deterministicScore?: ReturnType<typeof evaluateDeterministicAgentTaskConversation>;
};

export type QualityInspectionSeverity = "block" | "warn" | "info";

export type QualityInspectionIssueKind =
  | "validation_blocked"
  | "task_not_completed"
  | "llm_judge_missing"
  | "tool_command_failed"
  | "malformed_calendar_output"
  | "shell_dollar_expansion_risk"
  | "deterministic_score_low";

export type QualityInspectionIssue = {
  kind: QualityInspectionIssueKind;
  severity: QualityInspectionSeverity;
  message: string;
  evidence?: string;
};

export type QualityInspectionResult = {
  schemaVersion: 1;
  inspectedAt: string;
  publishable: boolean;
  issues: QualityInspectionIssue[];
};

/**
 * Markers that indicate real-user contamination in a benchmark transcript.
 * Frank's real Gmail addresses, the corporate sender pattern, and the
 * "Pesonal/Myself" tag have all shown up in past contaminated runs and are
 * the strongest single-line indicators that fake-gog was bypassed.
 */
export const REAL_ACCOUNT_MARKERS: readonly string[] = [
  "lifrank1994@gmail.com",
  "wsfccorp@gmail.com",
  "wsfccorp+",
  "WSFC <wsfccorp",
  "Pesonal/Myself",
  "Frank Li",
  "frankhli843",
];

/**
 * OAuth/access-token shapes and host paths that must never appear in a
 * benchmark artifact. Token shapes are scoped tightly to avoid false
 * positives on documentation snippets that happen to mention OAuth.
 */
export const HOST_OAUTH_MARKERS: readonly RegExp[] = [
  /\bya29\.[A-Za-z0-9_-]{30,}/,
  /\b1\/\/[A-Za-z0-9_-]{40,}/,
  /\bgho_[A-Za-z0-9]{30,}/,
  /\bsk-ant-[A-Za-z0-9-]{20,}/,
];

export const HOST_PATH_MARKERS: readonly string[] = [
  "/home/frank/.config/gogcli/state",
  "/home/frank/.openclaw/agents/main",
  "/home/frank/.openclaw/workspace/.secrets",
];

const EVIDENCE_CLIP = 240;

function clip(text: string, len = EVIDENCE_CLIP): string {
  if (text.length <= len) {
    return text;
  }
  return `${text.slice(0, len)}…`;
}

function readIfExists(filePath: string | undefined): string {
  if (!filePath) {
    return "";
  }
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function findFirstMarker(haystack: string, needles: readonly string[]): string | undefined {
  if (!haystack) {
    return undefined;
  }
  for (const needle of needles) {
    const idx = haystack.indexOf(needle);
    if (idx !== -1) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(haystack.length, idx + needle.length + 60);
      return clip(haystack.slice(start, end));
    }
  }
  return undefined;
}

function findFirstRegex(haystack: string, patterns: readonly RegExp[]): string | undefined {
  if (!haystack) {
    return undefined;
  }
  for (const pattern of patterns) {
    const match = pattern.exec(haystack);
    if (match) {
      const idx = match.index;
      const start = Math.max(0, idx - 40);
      const end = Math.min(haystack.length, idx + match[0].length + 40);
      return clip(haystack.slice(start, end));
    }
  }
  return undefined;
}

function transcriptText(conversation: ConversationTurn[]): string {
  return conversation
    .map((t) => {
      if (t.role === "tool_call") {
        return `[tool_call ${t.toolName ?? ""}] ${t.content}`;
      }
      if (t.role === "tool_result") {
        return `[tool_result] ${t.content}`;
      }
      return `[${t.role}] ${t.content}`;
    })
    .join("\n");
}

function hasGogToolCall(conversation: ConversationTurn[]): boolean {
  return conversation.some((t) => {
    if (t.role !== "tool_call") {
      return false;
    }
    const name = t.toolName ?? "";
    if (name === "gog") {
      return true;
    }
    if (name === "exec" && typeof t.content === "string" && /\bgog\b/.test(t.content)) {
      return true;
    }
    return false;
  });
}

function findAssistantTurn(conversation: ConversationTurn[]): ConversationTurn | undefined {
  return conversation.find(
    (t) => t.role === "assistant" && typeof t.content === "string" && t.content.trim().length > 0,
  );
}

export type ValidateTaskArtifactInput = {
  /** Run directory containing tasks/<id>/{result.json,transcript.txt,session.jsonl,trajectory.jsonl}. */
  runDir: string;
  /** Task definition (used for deterministic scoring + criteria). */
  task: AgentBenchmarkTask;
  /** Resolved task result (already persisted). */
  result: ValidatableTaskResult;
  /** Optional fake-gog log path. When present and non-empty, fake-gog was used. */
  fakeGogLogPath?: string;
  /** Optional benchmark home dir. Used to scope path-leak checks. */
  benchHomeDir?: string;
};

/**
 * Validate a saved task artifact. Reads the persisted transcript, session
 * JSONL, and trajectory JSONL alongside the in-memory result, and returns a
 * structured list of issues. Pure read-only; never mutates artifacts.
 */
export function validateTaskArtifact(input: ValidateTaskArtifactInput): ValidationResult {
  const { runDir, task, result, fakeGogLogPath } = input;
  const issues: ValidationIssue[] = [];

  const taskDir = path.join(runDir, "tasks", task.id);
  const transcriptPath = path.join(taskDir, "transcript.txt");
  const sessionPath = path.join(taskDir, "session.jsonl");
  const trajectoryPath = path.join(taskDir, "trajectory.jsonl");

  const conversation = result.conversation ?? [];
  const transcript = readIfExists(transcriptPath) || transcriptText(conversation);
  const sessionText = readIfExists(sessionPath);
  const trajectoryText = readIfExists(trajectoryPath);

  // (1) Transcript must be non-empty.
  if (conversation.length === 0 || transcript.trim().length === 0) {
    issues.push({
      kind: "transcript_empty",
      severity: "block",
      message: "Empty transcript: no conversation turns recorded for this task.",
    });
  }

  // (2) Must contain a non-empty assistant turn.
  const assistantTurn = findAssistantTurn(conversation);
  if (!assistantTurn && result.completionStatus === "completed") {
    issues.push({
      kind: "no_assistant_turn",
      severity: "block",
      message: "Task marked completed but conversation has no assistant turn with content.",
    });
  }

  // (3) Re-confirm trajectory error using the persisted file (the runner also
  // checks this in-process; redundant check keeps validation honest).
  if (trajectoryText) {
    const errorLine = trajectoryText
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { type?: unknown; status?: unknown; error?: unknown };
        } catch {
          return undefined;
        }
      })
      .find((entry) => {
        if (!entry || typeof entry !== "object") {
          return false;
        }
        const type = typeof entry.type === "string" ? entry.type : "";
        const status = typeof entry.status === "string" ? entry.status : "";
        return (
          (type === "session.ended" || type === "session_ended") &&
          (status === "error" ||
            status === "failed" ||
            status === "timeout" ||
            status === "aborted")
        );
      });
    if (errorLine) {
      const status = (errorLine as { status?: unknown }).status;
      const statusText = typeof status === "string" ? status : "unknown";
      issues.push({
        kind: "trajectory_error",
        severity: "block",
        message: `Trajectory recorded a terminal session error: status=${statusText}.`,
        evidence: clip(JSON.stringify(errorLine)),
      });
    }
  }

  // (4) Real account markers in any persisted artifact.
  for (const [bodyName, body] of [
    ["transcript", transcript],
    ["session", sessionText],
    ["trajectory", trajectoryText],
  ] as const) {
    const evidence = findFirstMarker(body, REAL_ACCOUNT_MARKERS);
    if (evidence) {
      issues.push({
        kind: "real_account_marker",
        severity: "block",
        message: `Real account marker detected in ${bodyName}.`,
        evidence,
      });
      break;
    }
  }

  // (5a) Host OAuth token shapes.
  for (const [bodyName, body] of [
    ["transcript", transcript],
    ["session", sessionText],
    ["trajectory", trajectoryText],
  ] as const) {
    const evidence = findFirstRegex(body, HOST_OAUTH_MARKERS);
    if (evidence) {
      issues.push({
        kind: "host_oauth_marker",
        severity: "block",
        message: `Host OAuth/access-token shape detected in ${bodyName}.`,
        evidence,
      });
      break;
    }
  }

  // (5b) Host path leaks (real user state dirs).
  for (const [bodyName, body] of [
    ["session", sessionText],
    ["trajectory", trajectoryText],
  ] as const) {
    const evidence = findFirstMarker(body, HOST_PATH_MARKERS);
    if (evidence) {
      issues.push({
        kind: "host_path_leak",
        severity: "block",
        message: `Host real-user path detected in ${bodyName}.`,
        evidence,
      });
      break;
    }
  }

  // (6) Fake-gog must have been used when the task touched gog.
  if (hasGogToolCall(conversation)) {
    const fakeGogPresent =
      fakeGogLogPath !== undefined &&
      fs.existsSync(fakeGogLogPath) &&
      fs.statSync(fakeGogLogPath).size > 0;
    if (!fakeGogPresent) {
      issues.push({
        kind: "fake_gog_missing",
        severity: "warn",
        message:
          "Task invoked gog but fake-gog.log is empty/missing. Fake-gog isolation may have been bypassed.",
      });
    }
  }

  // (7) Deterministic scorer must produce a score when configured.
  let deterministicScore: ReturnType<typeof evaluateDeterministicAgentTaskConversation>;
  try {
    deterministicScore = evaluateDeterministicAgentTaskConversation(task, conversation);
  } catch (err) {
    deterministicScore = undefined;
    issues.push({
      kind: "deterministic_scorer_missing",
      severity: "warn",
      message: `Deterministic scorer threw: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (task.grading.deterministic && deterministicScore == null) {
    issues.push({
      kind: "deterministic_scorer_missing",
      severity: "warn",
      message: "Task has a deterministic grader but it returned no result.",
    });
  }

  const hasBlocker = issues.some((issue) => issue.severity === "block");
  return {
    valid: !hasBlocker,
    issues,
    deterministicScore,
  };
}

export function summarizeValidation(result: ValidationResult): string {
  if (result.issues.length === 0) {
    return "validation: ok";
  }
  return result.issues
    .map((issue) => `${issue.severity}:${issue.kind}:${issue.message}`)
    .join("; ");
}

function pushQualityIssue(issues: QualityInspectionIssue[], issue: QualityInspectionIssue): void {
  const duplicate = issues.some(
    (existing) => existing.kind === issue.kind && existing.message === issue.message,
  );
  if (!duplicate) {
    issues.push(issue);
  }
}

function transcriptContainsCommandFailure(transcript: string): string | undefined {
  const match = transcript.match(/\(Command exited with code [1-9][0-9]*\)/);
  if (!match) {
    return undefined;
  }
  const start = Math.max(0, match.index! - 160);
  const end = Math.min(transcript.length, match.index! + match[0].length + 160);
  return clip(transcript.slice(start, end));
}

function transcriptContainsMalformedCalendarOutput(transcript: string): string | undefined {
  const patterns = [
    /"calendarId":\s*"[^"]+"\s*,\s*"summary":\s*"[^"]*"\s*,[\s\S]{0,500}?"start":\s*null\s*,\s*"end":\s*null/,
    /"start":\s*null\s*,\s*"end":\s*null/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(transcript);
    if (!match) {
      continue;
    }
    const start = Math.max(0, match.index - 160);
    const end = Math.min(transcript.length, match.index + match[0].length + 160);
    return clip(transcript.slice(start, end));
  }
  return undefined;
}

function transcriptContainsShellDollarExpansionRisk(
  conversation: ConversationTurn[],
): string | undefined {
  for (const turn of conversation) {
    if (turn.role !== "tool_call") {
      continue;
    }
    const body = `${turn.content}\n${JSON.stringify(turn.toolArgs ?? {})}`;
    const match = body.match(/\$\d/);
    if (!match) {
      continue;
    }
    const start = Math.max(0, match.index! - 120);
    const end = Math.min(body.length, match.index! + match[0].length + 120);
    return clip(body.slice(start, end));
  }
  return undefined;
}

/**
 * Lightweight per-task quality inspection for score readiness.
 *
 * This is not a replacement for the LLM judge. It is a durable stop-and-look
 * gate between "the harness produced an artifact" and "this artifact is safe
 * to carry forward into evaluation/site publishing." It records model-quality
 * warnings without rerunning to improve scores, while still blocking harness
 * and artifact failures that would make a score misleading.
 */
export function inspectTaskQuality(input: {
  runDir: string;
  task: AgentBenchmarkTask;
  result: ValidatableTaskResult;
  validation?: ValidationResult;
  llmJudgePresent?: boolean;
  inspectedAt?: string;
}): QualityInspectionResult {
  const { runDir, task, result, validation } = input;
  const issues: QualityInspectionIssue[] = [];
  const taskDir = path.join(runDir, "tasks", task.id);
  const transcript =
    readIfExists(path.join(taskDir, "transcript.txt")) || transcriptText(result.conversation ?? []);

  if (validation && !validation.valid) {
    pushQualityIssue(issues, {
      kind: "validation_blocked",
      severity: "block",
      message: "Per-task validation failed; this result must not be evaluated or published.",
      evidence: summarizeValidation(validation),
    });
  }

  if (result.completionStatus !== "completed") {
    pushQualityIssue(issues, {
      kind: "task_not_completed",
      severity: "block",
      message: `Task completionStatus is ${result.completionStatus}; inspect before scoring.`,
      evidence: result.error,
    });
  }

  if (!input.llmJudgePresent) {
    pushQualityIssue(issues, {
      kind: "llm_judge_missing",
      severity: "info",
      message:
        "No LLM judge score is attached yet. This artifact is runnable, but not a publishable evaluated result.",
    });
  }

  const commandFailure = transcriptContainsCommandFailure(transcript);
  if (commandFailure) {
    pushQualityIssue(issues, {
      kind: "tool_command_failed",
      severity: "warn",
      message:
        "A tool command exited nonzero inside a completed task. Preserve as model behavior unless it is a harness bug, but grade critically.",
      evidence: commandFailure,
    });
  }

  const malformedCalendar = transcriptContainsMalformedCalendarOutput(transcript);
  if (malformedCalendar) {
    pushQualityIssue(issues, {
      kind: "malformed_calendar_output",
      severity: "warn",
      message:
        "A calendar tool result has null start/end fields, usually caused by malformed command usage. Grade critically and inspect for harness ambiguity.",
      evidence: malformedCalendar,
    });
  }

  const shellDollarRisk = transcriptContainsShellDollarExpansionRisk(result.conversation ?? []);
  if (shellDollarRisk) {
    pushQualityIssue(issues, {
      kind: "shell_dollar_expansion_risk",
      severity: "warn",
      message:
        "A shell-exec tool call contains an unescaped dollar-number pattern. Shell expansion can corrupt benchmark side effects such as $1200 -> 200.",
      evidence: shellDollarRisk,
    });
  }

  const deterministicScore = validation?.deterministicScore;
  if (deterministicScore && !deterministicScore.passed) {
    pushQualityIssue(issues, {
      kind: "deterministic_score_low",
      severity: "warn",
      message: `Deterministic scorer failed: ${deterministicScore.score}/${deterministicScore.maxScore}.`,
      evidence: deterministicScore.details,
    });
  }

  const hasBlocker = issues.some((issue) => issue.severity === "block");
  return {
    schemaVersion: 1,
    inspectedAt: input.inspectedAt ?? new Date().toISOString(),
    publishable: !hasBlocker && Boolean(input.llmJudgePresent),
    issues,
  };
}

export function summarizeQualityInspection(result: QualityInspectionResult): string {
  if (result.issues.length === 0) {
    return "quality: ok";
  }
  return result.issues
    .map((issue) => `${issue.severity}:${issue.kind}:${issue.message}`)
    .join("; ");
}
