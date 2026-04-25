/**
 * Opt-in anonymized benchmark result upload.
 *
 * After a run completes, the user can opt to share their results.
 * This module:
 *   1. Strips private identifiers (hostnames, usernames, IPs, paths).
 *   2. Converts the result to the standardized schema.
 *   3. Forks the target repo (if needed), creates a branch, commits the result,
 *      and opens a PR via the `gh` CLI.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BenchmarkResult } from "../benchmark/runner.js";

export type UploadOpts = {
  /** GitHub repo to open the PR against, e.g. "gemmaclaw/gemmaclaw". */
  targetRepo: string;
  /** Subdirectory in the repo for result files, e.g. "community-benchmarks". */
  datasetDir: string;
  /** If true, skip the user confirmation prompt and just upload. */
  autoConfirm?: boolean;
};

type AnonymizedResult = {
  schemaVersion: string;
  runId: string;
  timestamp: string;
  hardware: {
    cpu: { arch: string; cores: number; model: string };
    ram: { totalBytes: number };
    gpu: { detected: boolean; name?: string; vramBytes?: number };
  };
  model: {
    name: string;
    backend: string;
    quantization?: string;
    contextWindow?: number;
  };
  config: {
    taskPack: string;
    mode: string;
    scoringMethod: string;
    thinkingLevel?: string;
  };
  summary: {
    totalScore: number;
    maxScore: number;
    percentage: number;
    totalTimeMs: number;
    avgTokensPerSecond?: number;
    passedCount: number;
    failedCount: number;
  };
  tasks: Array<{
    id: string;
    name: string;
    category: string;
    difficulty: string;
    score: number;
    maxScore: number;
    percentage: number;
    passed: boolean;
    elapsedMs: number;
    tokensPerSecond?: number;
  }>;
};

/**
 * Sanitize a benchmark result by removing private identifiers.
 *
 * Strips: ollamaUrl (may contain internal IPs), usernames from paths,
 * hostname from CPU model (some show hostname), and actual model output
 * text (may contain user data used in prompts).
 */
export function anonymize(result: BenchmarkResult): AnonymizedResult {
  const ts = result.timestamp || new Date().toISOString();
  const modelName = result.config.model;
  const dateTag = ts.replace(/[:.]/g, "-").slice(0, 19);
  const runId = `${modelName.replace(/[/:]/g, "-")}__${dateTag}`;

  // Sanitize CPU model: strip anything that looks like a hostname or username.
  const cpuModel = result.hardware.cpu.model
    .replace(new RegExp(os.hostname(), "gi"), "<host>")
    .replace(new RegExp(os.userInfo().username, "gi"), "<user>");

  return {
    schemaVersion: "1.0.0",
    runId,
    timestamp: ts,
    hardware: {
      cpu: {
        arch: result.hardware.cpu.arch,
        cores: result.hardware.cpu.cores,
        model: cpuModel,
      },
      ram: { totalBytes: result.hardware.ram.totalBytes },
      gpu: {
        detected: result.hardware.gpu.detected,
        name: result.hardware.gpu.name,
        vramBytes: result.hardware.gpu.vramBytes,
      },
    },
    model: {
      name: modelName,
      backend: "ollama",
      quantization: extractQuantization(modelName),
      contextWindow: result.config.contextLength,
    },
    config: {
      taskPack: "core",
      mode: result.config.mock ? "deterministic" : "full",
      scoringMethod: result.config.mock ? "deterministic" : "llm_judge",
      thinkingLevel: (result.config as Record<string, unknown>).thinkingLevel as string | undefined,
    },
    summary: {
      totalScore: result.summary.totalScore,
      maxScore: result.summary.maxScore,
      percentage: result.summary.percentage,
      totalTimeMs: result.summary.totalTimeMs,
      avgTokensPerSecond: result.summary.avgTokensPerSecond,
      passedCount: result.summary.passedCount,
      failedCount: result.summary.failedCount,
    },
    // Strip model output text, only keep scores and metadata.
    tasks: result.tasks.map((t) => ({
      id: t.task.id,
      name: t.task.name,
      category: t.task.category,
      difficulty: t.task.difficulty,
      score: t.score.score,
      maxScore: t.score.maxScore,
      percentage: t.score.percentage,
      passed: t.score.passed,
      elapsedMs: t.elapsedMs,
      tokensPerSecond: t.tokensPerSecond,
    })),
  };
}

function extractQuantization(modelName: string): string | undefined {
  const match = modelName.match(/[qQ]\d[_a-zA-Z]*/);
  return match?.[0];
}

/**
 * Check if `gh` CLI is available and authenticated.
 */
export function checkGhCli(): { available: boolean; authenticated: boolean; error?: string } {
  try {
    execSync("gh --version", { stdio: "pipe" });
  } catch {
    return {
      available: false,
      authenticated: false,
      error: "gh CLI not installed. Install from https://cli.github.com/",
    };
  }

  try {
    execSync("gh auth status", { stdio: "pipe" });
    return { available: true, authenticated: true };
  } catch {
    return {
      available: true,
      authenticated: false,
      error: "gh CLI not authenticated. Run: gh auth login",
    };
  }
}

/**
 * Upload an anonymized benchmark result by opening a PR.
 *
 * Steps:
 *   1. Fork the target repo (if not already forked).
 *   2. Clone the fork to a temp directory.
 *   3. Create a branch, add the result file.
 *   4. Push and open a PR against the upstream repo.
 *   5. Clean up the temp directory.
 *
 * Returns the PR URL on success.
 */
export async function uploadResult(
  result: BenchmarkResult,
  opts: UploadOpts,
  log?: (msg: string) => void,
): Promise<string> {
  const print = log ?? console.log;

  // Step 0: Verify gh CLI.
  const ghStatus = checkGhCli();
  if (!ghStatus.available || !ghStatus.authenticated) {
    throw new Error(ghStatus.error ?? "gh CLI not ready");
  }

  // Step 1: Anonymize.
  const anon = anonymize(result);
  print(`Anonymized result: ${anon.runId}`);

  // Step 2: Fork (idempotent).
  print(`Ensuring fork of ${opts.targetRepo}...`);
  try {
    execSync(`gh repo fork ${opts.targetRepo} --clone=false`, {
      stdio: "pipe",
      timeout: 30_000,
    });
  } catch {
    // Fork may already exist, that's fine.
  }

  // Get the user's GitHub username for the fork.
  const ghUser = execSync("gh api user --jq .login", { encoding: "utf8", timeout: 10_000 }).trim();
  const repoName = opts.targetRepo.split("/")[1];
  const forkRepo = `${ghUser}/${repoName}`;

  // Step 3: Clone to temp dir.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-upload-"));
  print(`Cloning ${forkRepo} to ${tmpDir}...`);

  try {
    execSync(`gh repo clone ${forkRepo} ${tmpDir} -- --depth 1`, {
      stdio: "pipe",
      timeout: 60_000,
    });

    // Step 4: Create branch and add file.
    const branchName = `benchmark/${anon.runId}`;
    const resultFileName = `${anon.runId}.json`;
    const resultDir = path.join(tmpDir, opts.datasetDir);
    fs.mkdirSync(resultDir, { recursive: true });
    fs.writeFileSync(path.join(resultDir, resultFileName), JSON.stringify(anon, null, 2));

    execSync(`git checkout -b "${branchName}"`, { cwd: tmpDir, stdio: "pipe" });
    execSync(`git add "${opts.datasetDir}/${resultFileName}"`, { cwd: tmpDir, stdio: "pipe" });
    execSync(`git commit -m "benchmark: add result ${anon.runId}"`, { cwd: tmpDir, stdio: "pipe" });

    // Step 5: Push and open PR.
    print("Pushing and opening PR...");
    execSync(`git push origin "${branchName}"`, { cwd: tmpDir, stdio: "pipe", timeout: 60_000 });

    const prBody = [
      "## Benchmark Result",
      "",
      `- **Model:** ${anon.model.name}`,
      `- **Score:** ${anon.summary.percentage}% (${anon.summary.totalScore}/${anon.summary.maxScore})`,
      `- **Speed:** ${anon.summary.avgTokensPerSecond?.toFixed(1) ?? "N/A"} tok/s`,
      `- **Hardware:** ${anon.hardware.cpu.arch} ${anon.hardware.cpu.cores} cores, ${(anon.hardware.ram.totalBytes / 1e9).toFixed(0)}GB RAM${anon.hardware.gpu.detected ? `, ${anon.hardware.gpu.name ?? "GPU"}` : ""}`,
      `- **Context:** ${anon.model.contextWindow ?? "default"}`,
      "",
      "This result was submitted via `gemmaclaw benchmark --upload`.",
      "All private identifiers have been stripped.",
    ].join("\n");

    const prUrl = execSync(
      `gh pr create --repo ${opts.targetRepo} --head "${ghUser}:${branchName}" --title "benchmark: ${anon.model.name} ${anon.summary.percentage}% on ${anon.hardware.cpu.arch}" --body "${prBody.replace(/"/g, '\\"')}"`,
      { cwd: tmpDir, encoding: "utf8", timeout: 30_000 },
    ).trim();

    print(`PR opened: ${prUrl}`);
    return prUrl;
  } finally {
    // Cleanup.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
