import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPublishableJudgeConfig,
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
          {
            status: "met",
            pointsAwarded: 5,
            reasoning: "read inbox",
            evidence: "turn #2: gog gmail search",
            turnRefs: [1],
          },
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
    expect(parsed.authoritative).toBe(true);
    expect(parsed.evaluationMode).toBe("publishable");
    expect(parsed.criteria[0]).toMatchObject({ status: "met", pointsAwarded: 5 });
    expect(parsed.criteria[0].turnRefs).toEqual([1]);
  });

  it("blocks local/Qwen judges for publishable benchmark evaluation", () => {
    expect(() =>
      assertPublishableJudgeConfig({
        outputDir: "/tmp/results",
        runId: "run",
        provider: "openai",
        model: "qwen3.6:35b",
      }),
    ).toThrow(/publishable benchmark judging/);

    expect(() =>
      assertPublishableJudgeConfig({
        outputDir: "/tmp/results",
        runId: "run",
        provider: "openai",
        model: "gpt-5.5",
        judgeBaseUrl: "http://127.0.0.1:11434/v1/",
      }),
    ).toThrow(/--judge-base-url is exploratory only/);
  });

  it("allows Gemini CLI OAuth judges for publishable benchmark evaluation", () => {
    assertPublishableJudgeConfig({
      outputDir: "/tmp/results",
      runId: "run",
      provider: "gemini-cli",
      model: "gemini-3-flash-preview",
    });

    expect(() =>
      assertPublishableJudgeConfig({
        outputDir: "/tmp/results",
        runId: "run",
        provider: "gemini-cli",
        model: "gemini-3-flash-preview",
        judgeBaseUrl: "http://127.0.0.1:11434/v1/",
      }),
    ).toThrow(/judge-base-url/);
  });

  it("records Gemini CLI as the judge provider", () => {
    const parsed = parseAgentJudgeResponse(
      JSON.stringify({
        score: 7,
        confidence: "medium",
        criteria: [{ status: "partial", pointsAwarded: 7, reasoning: "some evidence" }],
        reasoning: "usable",
        issues: [],
      }),
      10,
      {
        provider: "gemini-cli",
        model: "gemini-3-flash-preview",
        judgedAt: "2026-05-08T00:00:00.000Z",
        criteria: ["Must read inbox"],
      },
    );

    expect(parsed.provider).toBe("gemini-cli");
    expect(parsed.authoritative).toBe(true);
  });

  it("allows explicit exploratory local judge output but labels it non-authoritative", () => {
    const parsed = parseAgentJudgeResponse(
      JSON.stringify({
        score: 2,
        confidence: "low",
        criteria: [{ status: "partial", pointsAwarded: 2, reasoning: "smoke only" }],
        reasoning: "local smoke",
        issues: [],
      }),
      10,
      {
        provider: "openai",
        model: "qwen3.6:35b",
        judgedAt: "2026-05-08T00:00:00.000Z",
        criteria: ["Must read inbox"],
        exploratoryLocalJudge: true,
      },
    );

    assertPublishableJudgeConfig({
      outputDir: "/tmp/results",
      runId: "run",
      provider: "openai",
      model: "qwen3.6:35b",
      judgeBaseUrl: "http://127.0.0.1:11434/v1/",
      exploratoryLocalJudge: true,
    });
    expect(parsed.authoritative).toBe(false);
    expect(parsed.evaluationMode).toBe("exploratory-local");
  });

  it("summarizes only authoritative scored evaluation files", () => {
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
      {
        taskId: "b",
        taskName: "B",
        gradingCriteria: [],
        maxScore: 10,
        toolCallCount: 0,
        toolsUsed: [],
        completionStatus: "completed",
        elapsedMs: 1,
        conversationTurns: 1,
        transcriptFile: "transcripts/b.txt",
        deterministicScorer: null,
        llmJudge: {
          schemaVersion: 1,
          provider: "openai",
          model: "qwen3.6:35b",
          judgedAt: "2026-05-08T00:00:00.000Z",
          authoritative: false,
          evaluationMode: "exploratory-local",
          score: 10,
          maxScore: 10,
          percentage: 100,
          passed: true,
          confidence: "low",
          criteria: [],
          reasoning: "local smoke only",
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
    expect(summary.scoredTaskCount).toBe(1);
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
