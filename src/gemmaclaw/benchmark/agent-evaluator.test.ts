import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAgentJudgePrompt,
  evaluateAgentBenchmarkRun,
  generateAgentEvaluationMarkdown,
  parseAgentJudgeResponse,
  summarizeAgentEvaluations,
  type AgentEvaluationFile,
} from "./agent-evaluator.js";
import type { AgentTaskResult } from "./agent-runner.js";

const taskResult: AgentTaskResult = {
  task: {
    id: "email_summarize",
    name: "Email Inbox Summary",
    description: "Summarize inbox",
    category: "email",
    difficulty: "medium",
    prompt: "Check my inbox",
    grading: {
      type: "conversation_check",
      criteria: ["Must read inbox", "Must summarize priorities"],
      maxScore: 10,
    },
  },
  conversation: [
    { role: "user", content: "Check my inbox" },
    {
      role: "tool_call",
      toolName: "exec",
      toolArgs: { command: "gog gmail search" },
      content: "{}",
    },
    { role: "tool_result", content: "3 emails" },
    { role: "assistant", content: "Three emails need attention." },
  ],
  elapsedMs: 1000,
  toolCallCount: 1,
  toolsUsed: ["exec"],
  completionStatus: "completed",
};

describe("agent evaluator", () => {
  it("builds a prompt with task rubric and transcript", () => {
    const prompt = buildAgentJudgePrompt(taskResult);

    expect(prompt).toContain("Email Inbox Summary");
    expect(prompt).toContain("Must read inbox");
    expect(prompt).toContain("TOOL_CALL exec");
    expect(prompt).toContain("Return ONLY this JSON shape");
  });

  it("parses JSON judge responses and computes pass percentage", () => {
    const parsed = parseAgentJudgeResponse(
      JSON.stringify({
        score: 8.5,
        confidence: "high",
        criteria: [
          { status: "met", pointsAwarded: 5, reasoning: "read inbox", evidence: "gog" },
          { status: "partial", pointsAwarded: 3.5, reasoning: "summary ok" },
        ],
        reasoning: "good",
        issues: ["minor miss"],
      }),
      10,
      {
        provider: "openai",
        model: "gpt-5.5",
        judgedAt: "2026-05-08T00:00:00.000Z",
        criteria: ["Must read inbox", "Must summarize priorities"],
      },
    );

    expect(parsed.score).toBe(8.5);
    expect(parsed.percentage).toBe(85);
    expect(parsed.passed).toBe(true);
    expect(parsed.criteria[0]).toMatchObject({ status: "met", pointsAwarded: 5 });
  });

  it("summarizes scored evaluation files", () => {
    const evaluations: AgentEvaluationFile[] = [
      {
        taskId: "a",
        taskName: "A",
        gradingCriteria: [],
        maxScore: 10,
        toolCallCount: 0,
        toolsUsed: [],
        completionStatus: "completed",
        elapsedMs: 1,
        conversationTurns: 1,
        transcriptFile: "transcripts/a.txt",
        deterministicScorer: null,
        llmJudge: {
          schemaVersion: 1,
          provider: "openai",
          model: "gpt-5.5",
          judgedAt: "2026-05-08T00:00:00.000Z",
          score: 9,
          maxScore: 10,
          percentage: 90,
          passed: true,
          confidence: "high",
          criteria: [],
          reasoning: "ok",
          issues: [],
        },
      },
    ];

    const summary = summarizeAgentEvaluations(
      "run",
      "openai",
      "gpt-5.5",
      "2026-05-08T00:00:00.000Z",
      evaluations,
    );

    expect(summary.totalScore).toBe(9);
    expect(summary.maxScore).toBe(10);
    expect(summary.percentage).toBe(90);
    expect(generateAgentEvaluationMarkdown(summary)).toContain("9 / 10");
  });

  it("writes per-task judge results and aggregate summary", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-evaluator-"));
    const runId = "run-1";
    const runDir = path.join(dir, "runs", runId);
    const evalDir = path.join(dir, "evaluations", runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(evalDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify({ tasks: [taskResult] }));
    fs.writeFileSync(
      path.join(evalDir, "email_summarize.json"),
      JSON.stringify({
        taskId: "email_summarize",
        taskName: "Email Inbox Summary",
        gradingCriteria: taskResult.task.grading.criteria,
        maxScore: 10,
        toolCallCount: 1,
        toolsUsed: ["exec"],
        completionStatus: "completed",
        elapsedMs: 1000,
        conversationTurns: 4,
        transcriptFile: "transcripts/email_summarize.txt",
        deterministicScorer: null,
        llmJudge: null,
      }),
    );

    const summary = await evaluateAgentBenchmarkRun(
      {
        outputDir: dir,
        runId,
        provider: "openai",
        model: "gpt-5.5",
      },
      {
        async judge() {
          return JSON.stringify({
            score: 10,
            confidence: "high",
            criteria: [
              { status: "met", pointsAwarded: 5, reasoning: "read inbox" },
              { status: "met", pointsAwarded: 5, reasoning: "summarized" },
            ],
            reasoning: "complete",
            issues: [],
          });
        },
      },
      () => {},
    );

    const evaluation = JSON.parse(
      fs.readFileSync(path.join(evalDir, "email_summarize.json"), "utf-8"),
    ) as AgentEvaluationFile;
    expect(evaluation.llmJudge?.score).toBe(10);
    expect(summary.percentage).toBe(100);
    expect(fs.existsSync(path.join(evalDir, "summary.json"))).toBe(true);
    expect(fs.existsSync(path.join(evalDir, "LLM_EVALUATION.md"))).toBe(true);
  });
});
