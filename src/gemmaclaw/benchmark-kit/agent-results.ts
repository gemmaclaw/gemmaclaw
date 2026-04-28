/**
 * Result writer for agent-family benchmark packs.
 *
 * Tool-free Gemmaclaw benchmarks already write results through
 * `src/gemmaclaw/benchmark/results.ts`. Agent packs use the shared runner
 * adapter contract instead, so this module writes the same three standard
 * artifact names under the same standard benchmark-results directory:
 * `results.json`, `RESULTS.md`, and `index.html`.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentPack, BenchmarkPack } from "./pack-types.js";
import type { RunnerRunResult } from "./runner-adapter.js";

export type AgentBenchmarkSummary = {
  totalScore: number;
  maxScore: number;
  percentage: number;
  passedCount: number;
  failedCount: number;
  passRate: number;
  totalTimeMs: number;
};

export type AgentBenchmarkArtifact = {
  schemaVersion: "1";
  generatedBy: "gemmaclaw benchmark";
  benchmarkFamily: "agent";
  timestamp: string;
  pack: {
    id: string;
    version: string;
    description?: string;
    taskCount: number;
  };
  runner: {
    kind: BenchmarkPack["family"];
    name: string;
    modelSpec: string;
  };
  summary: AgentBenchmarkSummary;
  tasks: Array<{
    id: string;
    name?: string;
    category?: string;
    difficulty?: string;
    gradingType: string;
    score: number;
    maxScore: number;
    passed: boolean;
    detail?: string;
  }>;
};

export function writeAgentBenchmarkResults(
  pack: AgentPack,
  result: RunnerRunResult,
  outputDir: string,
): {
  json: string;
  markdown: string;
  html: string;
  artifact: AgentBenchmarkArtifact;
} {
  fs.mkdirSync(outputDir, { recursive: true });
  const artifact = buildArtifact(pack, result);
  const json = writeAgentJsonResults(artifact, outputDir);
  const markdown = writeAgentMarkdownSummary(artifact, outputDir);
  const html = writeAgentHtmlDashboard(artifact, outputDir);
  return { json, markdown, html, artifact };
}

function buildArtifact(pack: AgentPack, result: RunnerRunResult): AgentBenchmarkArtifact {
  const outcomesById = new Map(result.outcomes.map((o) => [o.taskId, o]));
  const tasks = pack.tasks.map((task) => {
    const outcome = outcomesById.get(task.id);
    const maxScore = task.grading.max_score;
    return {
      id: task.id,
      name: task.name,
      category: task.category,
      difficulty: task.difficulty,
      gradingType: task.grading.type,
      score: outcome?.score ?? 0,
      maxScore: outcome?.maxScore ?? maxScore,
      passed: outcome?.passed ?? false,
      detail: outcome?.detail,
    };
  });
  const totalScore = tasks.reduce((sum, task) => sum + task.score, 0);
  const maxScore = tasks.reduce((sum, task) => sum + task.maxScore, 0);
  const passedCount = tasks.filter((task) => task.passed).length;
  const failedCount = tasks.length - passedCount;
  const totalTimeMs = Math.max(
    0,
    new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime(),
  );
  const percentage = maxScore > 0 ? round1((totalScore / maxScore) * 100) : 0;
  const passRate = tasks.length > 0 ? round1((passedCount / tasks.length) * 100) : 0;

  return {
    schemaVersion: "1",
    generatedBy: "gemmaclaw benchmark",
    benchmarkFamily: "agent",
    timestamp: result.finishedAt,
    pack: {
      id: pack.pack,
      version: pack.version,
      description: pack.description,
      taskCount: pack.tasks.length,
    },
    runner: {
      kind: result.family,
      name: result.runnerName ?? "unknown",
      modelSpec: result.modelSpec,
    },
    summary: {
      totalScore,
      maxScore,
      percentage,
      passedCount,
      failedCount,
      passRate,
      totalTimeMs,
    },
    tasks,
  };
}

function writeAgentJsonResults(artifact: AgentBenchmarkArtifact, outputDir: string): string {
  const filePath = path.join(outputDir, "results.json");
  fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2));
  return filePath;
}

function writeAgentMarkdownSummary(artifact: AgentBenchmarkArtifact, outputDir: string): string {
  const filePath = path.join(outputDir, "RESULTS.md");
  const lines: string[] = [
    `# Agent Benchmark Results: ${artifact.pack.id}`,
    "",
    `Date: ${artifact.timestamp}`,
    `Pack: ${artifact.pack.id} v${artifact.pack.version}`,
    `Runner: ${artifact.runner.name}`,
    `Model spec: ${artifact.runner.modelSpec}`,
    "",
    "## Summary",
    "",
    `Total Score: ${artifact.summary.totalScore} / ${artifact.summary.maxScore} (${artifact.summary.percentage}%)`,
    `Pass Rate: ${artifact.summary.passRate}% (${artifact.summary.passedCount}/${artifact.pack.taskCount})`,
    `Total Time: ${(artifact.summary.totalTimeMs / 1000).toFixed(1)}s`,
    "",
    "## Task Results",
    "",
    "| Task | Category | Difficulty | Score | Status | Detail |",
    "| --- | --- | --- | --- | --- | --- |",
    ...artifact.tasks.map(
      (task) =>
        `| ${task.id} | ${task.category ?? ""} | ${task.difficulty ?? ""} | ` +
        `${task.score}/${task.maxScore} | ${task.passed ? "PASS" : "FAIL"} | ` +
        `${escapeMarkdownCell(task.detail ?? task.gradingType)} |`,
    ),
    "",
  ];
  fs.writeFileSync(filePath, lines.join("\n"));
  return filePath;
}

function writeAgentHtmlDashboard(artifact: AgentBenchmarkArtifact, outputDir: string): string {
  const filePath = path.join(outputDir, "index.html");
  const rows = artifact.tasks
    .map(
      (task) => `<tr>
  <td>${escapeHtml(task.id)}</td>
  <td>${escapeHtml(task.category ?? "")}</td>
  <td>${escapeHtml(task.difficulty ?? "")}</td>
  <td>${task.score}/${task.maxScore}</td>
  <td class="${task.passed ? "pass" : "fail"}">${task.passed ? "PASS" : "FAIL"}</td>
  <td>${escapeHtml(task.detail ?? task.gradingType)}</td>
</tr>`,
    )
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Agent Benchmark Results: ${escapeHtml(artifact.pack.id)}</title>
<style>
body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 2rem; color: #172033; }
.card { max-width: 1100px; margin: 0 auto; }
table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
th, td { border-bottom: 1px solid #d8dee9; padding: 0.55rem; text-align: left; vertical-align: top; }
th { background: #f4f6fb; }
.pass { color: #087f5b; font-weight: 700; }
.fail { color: #c92a2a; font-weight: 700; }
.summary { display: flex; gap: 1rem; flex-wrap: wrap; }
.metric { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 0.75rem 1rem; }
.metric strong { display: block; font-size: 1.35rem; }
</style>
</head>
<body>
<div class="card">
<h1>Agent Benchmark Results: ${escapeHtml(artifact.pack.id)}</h1>
<p>${escapeHtml(artifact.pack.description ?? "")}</p>
<div class="summary">
  <div class="metric"><span>Score</span><strong>${artifact.summary.totalScore}/${artifact.summary.maxScore}</strong></div>
  <div class="metric"><span>Percentage</span><strong>${artifact.summary.percentage}%</strong></div>
  <div class="metric"><span>Pass rate</span><strong>${artifact.summary.passRate}%</strong></div>
  <div class="metric"><span>Runner</span><strong>${escapeHtml(artifact.runner.name)}</strong></div>
</div>
<p><strong>Model spec:</strong> ${escapeHtml(artifact.runner.modelSpec)}<br />
<strong>Generated:</strong> ${escapeHtml(artifact.timestamp)}</p>
<table>
<thead><tr><th>Task</th><th>Category</th><th>Difficulty</th><th>Score</th><th>Status</th><th>Detail</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<footer>Generated by gemmaclaw benchmark | agent | ${escapeHtml(artifact.timestamp)}</footer>
</div>
</body>
</html>`;

  fs.writeFileSync(filePath, html);
  return filePath;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
