import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { AgentTaskResult } from "./agent-runner.js";

export type AgentJudgeProvider = "openai";

export type AgentJudgeCriterionResult = {
  criterion: string;
  status: "met" | "partial" | "not_met";
  pointsAwarded: number;
  reasoning: string;
  /** Brief text evidence from transcript, e.g. "turn #3: gog calendar create..." */
  evidence?: string;
  /** Transcript turn index(es) where the issue/evidence was observed (0-based) */
  turnRefs?: number[];
};

export type AgentLlmJudgeResult = {
  schemaVersion: 1;
  provider: AgentJudgeProvider;
  model: string;
  judgedAt: string;
  authoritative?: boolean;
  evaluationMode?: "publishable" | "exploratory-local";
  score: number;
  maxScore: number;
  percentage: number;
  passed: boolean;
  confidence: "high" | "medium" | "low";
  criteria: AgentJudgeCriterionResult[];
  reasoning: string;
  issues: string[];
  rawResponse?: string;
};

export type AgentEvaluationFile = {
  taskId: string;
  taskName: string;
  gradingCriteria: string[];
  maxScore: number;
  toolCallCount: number;
  toolsUsed: string[];
  completionStatus: string;
  elapsedMs: number;
  conversationTurns: number;
  transcriptFile: string;
  deterministicScorer: unknown;
  llmJudge: AgentLlmJudgeResult | null;
};

export type AgentEvaluationSummary = {
  schemaVersion: 1;
  runId: string;
  provider: AgentJudgeProvider;
  model: string;
  judgedAt: string;
  taskCount: number;
  scoredTaskCount: number;
  passCount: number;
  failCount: number;
  totalScore: number;
  maxScore: number;
  percentage: number;
  tasks: Array<{
    taskId: string;
    taskName: string;
    score: number;
    maxScore: number;
    percentage: number;
    passed: boolean;
    confidence: "high" | "medium" | "low";
  }>;
};

export type AgentEvaluationConfig = {
  outputDir: string;
  runId: string;
  provider: AgentJudgeProvider;
  model: string;
  /** Optional base URL for exploratory local judge API calls. Never allowed for publishable scoring. */
  judgeBaseUrl?: string;
  exploratoryLocalJudge?: boolean;
  force?: boolean;
  includeRaw?: boolean;
};

export type AgentJudgeClient = {
  judge(prompt: string): Promise<string>;
};

const JUDGE_SYSTEM_PROMPT = [
  "You are a strict but fair benchmark evaluator.",
  "Score only against the task prompt, grading criteria, and transcript provided.",
  "Reward correct tool use, correct final answer, safety behavior, and completing required side effects.",
  "Penalize hallucinated actions, missing side effects, unsafe actions, and ignoring explicit constraints.",
  "Do not require perfection outside the rubric.",
  "Return only valid JSON.",
].join(" ");

function clampScore(score: number, maxScore: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.min(Math.max(score, 0), maxScore);
}

function roundScore(score: number): number {
  return Math.round(score * 10) / 10;
}

function percentage(score: number, maxScore: number): number {
  if (maxScore <= 0) {
    return 0;
  }
  return Math.round((score / maxScore) * 100);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => stringFromUnknown(item));
}

function stringFromUnknown(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function normalizeStatus(value: unknown): AgentJudgeCriterionResult["status"] {
  if (value === "met" || value === "partial" || value === "not_met") {
    return value;
  }
  return "partial";
}

function normalizeConfidence(value: unknown): AgentLlmJudgeResult["confidence"] {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "medium";
}

function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Continue to fenced/object extraction.
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // Continue to first-object extraction.
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }

  throw new Error("judge response did not contain a JSON object");
}

export function parseAgentJudgeResponse(
  response: string,
  maxScore: number,
  options: {
    provider: AgentJudgeProvider;
    model: string;
    judgedAt: string;
    criteria: string[];
    exploratoryLocalJudge?: boolean;
    includeRaw?: boolean;
  },
): AgentLlmJudgeResult {
  const parsed = extractJsonObject(response) as Record<string, unknown>;
  const score = roundScore(clampScore(Number(parsed.score), maxScore));
  const criteriaInput = Array.isArray(parsed.criteria) ? parsed.criteria : [];
  const criteria = options.criteria.map((criterion, index) => {
    const item = (criteriaInput[index] ?? {}) as Record<string, unknown>;
    const turnRefs = Array.isArray(item.turnRefs)
      ? (item.turnRefs as unknown[]).filter((v) => Number.isInteger(v)).map(Number)
      : undefined;
    return {
      criterion,
      status: normalizeStatus(item.status),
      pointsAwarded: roundScore(clampScore(Number(item.pointsAwarded), maxScore)),
      reasoning: stringFromUnknown(item.reasoning),
      ...(item.evidence ? { evidence: stringFromUnknown(item.evidence) } : {}),
      ...(turnRefs && turnRefs.length > 0 ? { turnRefs } : {}),
    };
  });

  return {
    schemaVersion: 1,
    provider: options.provider,
    model: options.model,
    judgedAt: options.judgedAt,
    authoritative: !options.exploratoryLocalJudge,
    evaluationMode: options.exploratoryLocalJudge ? "exploratory-local" : "publishable",
    score,
    maxScore,
    percentage: percentage(score, maxScore),
    passed: score / maxScore >= 0.7,
    confidence: normalizeConfidence(parsed.confidence),
    criteria,
    reasoning: stringFromUnknown(parsed.reasoning),
    issues: asStringArray(parsed.issues),
    ...(options.includeRaw ? { rawResponse: response } : {}),
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function buildTranscript(result: AgentTaskResult): string {
  return result.conversation
    .map((turn, index) => {
      const label =
        turn.role === "tool_call"
          ? `TOOL_CALL ${turn.toolName ?? "unknown"}`
          : turn.role.toUpperCase();
      const args =
        turn.role === "tool_call" && turn.toolArgs
          ? `\nARGS: ${JSON.stringify(turn.toolArgs)}`
          : "";
      return `#${index + 1} ${label}${turn.timestamp ? ` (${turn.timestamp})` : ""}${args}\n${turn.content}`;
    })
    .join("\n\n");
}

export function buildAgentJudgePrompt(result: AgentTaskResult): string {
  const criteriaText = result.task.grading.criteria
    .map((criterion, index) => `${index + 1}. ${criterion}`)
    .join("\n");
  const transcript = buildTranscript(result);

  return [
    "Evaluate this Gemmaclaw agent benchmark task.",
    "",
    `Task id: ${result.task.id}`,
    `Task name: ${result.task.name}`,
    `Category: ${result.task.category}`,
    `Difficulty: ${result.task.difficulty}`,
    `Max score: ${result.task.grading.maxScore}`,
    "",
    "Prompt given to the agent:",
    result.task.prompt,
    "",
    "Grading criteria:",
    criteriaText,
    "",
    "Observed run metadata:",
    `completionStatus: ${result.completionStatus}`,
    `toolCallCount: ${result.toolCallCount}`,
    `toolsUsed: ${result.toolsUsed.join(", ") || "(none)"}`,
    `elapsedMs: ${result.elapsedMs}`,
    result.error ? `error: ${result.error}` : "",
    "",
    "Full transcript:",
    transcript,
    "",
    "Return ONLY this JSON shape (no prose before or after, no markdown fences):",
    JSON.stringify(
      {
        score: 0,
        confidence: "high | medium | low",
        criteria: result.task.grading.criteria.map((criterion) => ({
          criterion,
          status: "met | partial | not_met",
          pointsAwarded: 0,
          reasoning: "short reason",
          evidence:
            "brief transcript quote or turn reference, e.g. turn #3: gog calendar create ...",
          turnRefs: [0],
        })),
        reasoning: "overall scoring rationale",
        issues: ["important misses or risks, empty if none"],
      },
      null,
      2,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

export function summarizeAgentEvaluations(
  runId: string,
  provider: AgentJudgeProvider,
  model: string,
  judgedAt: string,
  evaluations: AgentEvaluationFile[],
): AgentEvaluationSummary {
  const scored = evaluations.filter(
    (evaluation) => evaluation.llmJudge && evaluation.llmJudge.authoritative !== false,
  );
  const tasks = scored.map((evaluation) => {
    const judge = evaluation.llmJudge!;
    return {
      taskId: evaluation.taskId,
      taskName: evaluation.taskName,
      score: judge.score,
      maxScore: judge.maxScore,
      percentage: judge.percentage,
      passed: judge.passed,
      confidence: judge.confidence,
    };
  });
  const totalScore = roundScore(tasks.reduce((sum, task) => sum + task.score, 0));
  const maxScore = roundScore(tasks.reduce((sum, task) => sum + task.maxScore, 0));

  return {
    schemaVersion: 1,
    runId,
    provider,
    model,
    judgedAt,
    taskCount: evaluations.length,
    scoredTaskCount: scored.length,
    passCount: tasks.filter((task) => task.passed).length,
    failCount: tasks.filter((task) => !task.passed).length,
    totalScore,
    maxScore,
    percentage: percentage(totalScore, maxScore),
    tasks,
  };
}

export function generateAgentEvaluationMarkdown(summary: AgentEvaluationSummary): string {
  const lines = [
    `# LLM Evaluation: ${summary.runId}`,
    "",
    `Judge: \`${summary.provider}/${summary.model}\``,
    `Judged at: ${summary.judgedAt}`,
    "",
    "## Score Summary",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Scored tasks | ${summary.scoredTaskCount} / ${summary.taskCount} |`,
    `| Passed tasks | ${summary.passCount} |`,
    `| Failed tasks | ${summary.failCount} |`,
    `| Total score | ${summary.totalScore} / ${summary.maxScore} |`,
    `| Percentage | ${summary.percentage}% |`,
    "",
    "## Per-Task Scores",
    "",
    "| Task | Score | Pass | Confidence |",
    "|---|---:|:---:|---|",
  ];

  for (const task of summary.tasks) {
    lines.push(
      `| ${task.taskName} | ${task.score}/${task.maxScore} (${task.percentage}%) | ${task.passed ? "yes" : "no"} | ${task.confidence} |`,
    );
  }

  lines.push("");
  lines.push("Detailed per-criterion judge results are stored in the sibling per-task JSON files.");
  return lines.join("\n") + "\n";
}

export class OpenAIAgentJudgeClient implements AgentJudgeClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(model: string, apiKey = process.env.OPENAI_API_KEY, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.model = model;
  }

  async judge(prompt: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: JUDGE_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: 4096,
    });
    return response.choices[0]?.message?.content ?? "";
  }
}

function makeJudgeClient(config: AgentEvaluationConfig): AgentJudgeClient {
  // Local Ollama: accepts any API key value, uses OpenAI-compatible /v1/ API.
  const apiKey = config.judgeBaseUrl ? "ollama" : process.env.OPENAI_API_KEY;
  return new OpenAIAgentJudgeClient(config.model, apiKey, config.judgeBaseUrl);
}

export function assertPublishableJudgeConfig(config: AgentEvaluationConfig): void {
  if (config.exploratoryLocalJudge) {
    return;
  }

  const model = config.model.toLowerCase();
  if (config.judgeBaseUrl) {
    throw new Error(
      "--judge-base-url is exploratory only and cannot be used for publishable benchmark judging. " +
        "Use CC ACP/Claude Code or Codex CLI to read transcripts directly, or pass " +
        "--exploratory-local-judge only for non-authoritative local smoke output.",
    );
  }
  if (model.includes("qwen")) {
    throw new Error(
      "--judge-model qwen is exploratory only and cannot be used for publishable benchmark judging. " +
        "Use CC ACP/Claude Code or Codex CLI to read transcripts directly, or pass " +
        "--exploratory-local-judge only for non-authoritative local smoke output.",
    );
  }
}

export async function evaluateAgentBenchmarkRun(
  config: AgentEvaluationConfig,
  judgeClient?: AgentJudgeClient,
  log: (message: string) => void = console.log,
): Promise<AgentEvaluationSummary> {
  assertPublishableJudgeConfig(config);
  const client = judgeClient ?? makeJudgeClient(config);

  const runDir = path.join(config.outputDir, "runs", config.runId);
  const evalDir = path.join(config.outputDir, "evaluations", config.runId);
  const resultsPath = path.join(runDir, "results.json");
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`benchmark run results not found: ${resultsPath}`);
  }
  if (!fs.existsSync(evalDir)) {
    throw new Error(`evaluation directory not found: ${evalDir}`);
  }

  const results = readJson(resultsPath) as { tasks: AgentTaskResult[] };
  const judgedAt = new Date().toISOString();
  const evaluations: AgentEvaluationFile[] = [];

  for (const taskResult of results.tasks) {
    const evalPath = path.join(evalDir, `${taskResult.task.id}.json`);
    const evaluation = readJson(evalPath) as AgentEvaluationFile;
    if (evaluation.llmJudge && !config.force) {
      log(`skip ${taskResult.task.id}: already judged`);
      evaluations.push(evaluation);
      continue;
    }

    log(`judge ${taskResult.task.id} (${taskResult.task.grading.maxScore} pts)`);
    const prompt = buildAgentJudgePrompt(taskResult);
    const response = await client.judge(prompt);
    const judge = parseAgentJudgeResponse(response, taskResult.task.grading.maxScore, {
      provider: config.provider,
      model: config.model,
      judgedAt,
      criteria: taskResult.task.grading.criteria,
      exploratoryLocalJudge: config.exploratoryLocalJudge,
      includeRaw: config.includeRaw,
    });
    const updated: AgentEvaluationFile = {
      ...evaluation,
      maxScore: taskResult.task.grading.maxScore,
      toolCallCount: taskResult.toolCallCount,
      toolsUsed: taskResult.toolsUsed,
      completionStatus: taskResult.completionStatus,
      elapsedMs: taskResult.elapsedMs,
      conversationTurns: taskResult.conversation.length,
      llmJudge: judge,
    };
    writeJson(evalPath, updated);
    evaluations.push(updated);
  }

  const summary = summarizeAgentEvaluations(
    config.runId,
    config.provider,
    config.model,
    judgedAt,
    evaluations,
  );
  writeJson(path.join(evalDir, "summary.json"), summary);
  fs.writeFileSync(
    path.join(evalDir, "LLM_EVALUATION.md"),
    generateAgentEvaluationMarkdown(summary),
  );

  log(
    `LLM evaluation complete: ${summary.totalScore}/${summary.maxScore} (${summary.percentage}%), ${summary.passCount}/${summary.scoredTaskCount} passed`,
  );
  return summary;
}
