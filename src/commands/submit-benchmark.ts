/**
 * `gemmaclaw benchmark submit` — package a completed benchmark run, fork the
 * gemmaclaw repo, push a branch with the anonymized result, and open a PR.
 *
 * Reads the on-disk `results.json` (whatever the active runner writes) rather
 * than expecting an in-memory BenchmarkResult, so it works for both the
 * core-model and agent-family pipelines.
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export type SubmitOpts = {
  /** Optional path to a benchmark results directory. Auto-detected if omitted. */
  resultsDir?: string;
  /** GitHub repo to open the PR against. */
  repo?: string;
  /** Subdirectory in the repo where the result file lands. */
  datasetDir?: string;
  /** Skip prompts and any "are you sure" confirmations. */
  yes?: boolean;
  /** Print what would happen, do not fork / push / open PR. */
  dryRun?: boolean;
  /** Root to look under when auto-detecting (default: ./benchmark-results). */
  resultsRoot?: string;
};

const DEFAULT_REPO = "gemmaclaw/gemmaclaw";
const DEFAULT_DATASET_DIR = "community-benchmarks";
const DEFAULT_RESULTS_ROOT = "benchmark-results";

type RawResult = Record<string, unknown> & {
  model?: unknown;
  backend?: unknown;
  timestamp?: unknown;
  benchmarkFamily?: unknown;
  pack?: unknown;
  runner?: unknown;
  summary?: unknown;
  hardware?: unknown;
};

/**
 * Pick the most recently modified subdirectory under `root` that contains a
 * `results.json`. Returns the absolute path.
 */
export function findNewestResultsDir(root: string): string {
  if (!fs.existsSync(root)) {
    throw new Error(`Results root does not exist: ${root}`);
  }
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "results.json")));

  if (entries.length === 0) {
    throw new Error(
      `No benchmark result directories with results.json found under ${root}. ` +
        `Run \`gemmaclaw benchmark\` first.`,
    );
  }

  entries.sort((a, b) => {
    const aMtime = fs.statSync(a).mtimeMs;
    const bMtime = fs.statSync(b).mtimeMs;
    return bMtime - aMtime;
  });
  return entries[0];
}

/**
 * Strip likely-PII from a parsed results.json: hostname, username,
 * absolute filesystem paths under home dirs, and any URL host that looks
 * private (localhost / RFC1918 / WSL bridge ranges).
 */
export function anonymizeOnDiskResult(payload: RawResult): RawResult {
  const hostname = os.hostname();
  const username = os.userInfo().username;
  const homeDir = os.homedir();

  const replacers: Array<[RegExp, string]> = [];
  if (hostname) {
    replacers.push([new RegExp(escapeRegExp(hostname), "gi"), "<host>"]);
  }
  if (username) {
    replacers.push([new RegExp(escapeRegExp(username), "gi"), "<user>"]);
  }
  if (homeDir) {
    replacers.push([new RegExp(escapeRegExp(homeDir), "g"), "<home>"]);
  }
  // Strip private URLs (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x).
  replacers.push([
    /https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)(?::\d+)?\b/gi,
    "<private-url>",
  ]);

  const sanitizeValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const [pattern, replacement] of replacers) {
        out = out.replace(pattern, replacement);
      }
      return out;
    }
    if (Array.isArray(value)) {
      return value.map(sanitizeValue);
    }
    if (value && typeof value === "object") {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        obj[k] = sanitizeValue(v);
      }
      return obj;
    }
    return value;
  };

  return sanitizeValue(payload) as RawResult;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a stable run id used for the branch name and result filename.
 *
 * Prefers the legacy core-model fields (`model` + `timestamp`) when present,
 * falls back to the agent-family fields (`runner.name` + `pack.id` + `timestamp`),
 * and finally to the directory name.
 */
export function deriveRunId(payload: RawResult, fallbackDirName: string): string {
  const ts = typeof payload.timestamp === "string" ? payload.timestamp : "";
  const tsTag = ts ? ts.replace(/[:.]/g, "-").slice(0, 19) : "";

  const model = typeof payload.model === "string" ? payload.model : "";
  if (model) {
    const safeModel = model.replace(/[/:]/g, "-");
    return tsTag ? `${safeModel}__${tsTag}` : safeModel;
  }

  const family = typeof payload.benchmarkFamily === "string" ? payload.benchmarkFamily : "";
  const pack = (payload.pack as { id?: unknown } | undefined)?.id;
  const runner = (payload.runner as { name?: unknown } | undefined)?.name;
  if (family === "agent" && typeof pack === "string" && typeof runner === "string") {
    const safe = `${pack}__${runner}`.replace(/[/:]/g, "-");
    return tsTag ? `${safe}__${tsTag}` : safe;
  }

  return fallbackDirName.replace(/[/:]/g, "-");
}

function checkGhAvailable(): { ok: true } | { ok: false; reason: string } {
  const versionCheck = spawnSync("gh", ["--version"], { stdio: "pipe" });
  if (versionCheck.error || versionCheck.status !== 0) {
    return {
      ok: false,
      reason: "gh CLI is not installed. Install from https://cli.github.com/ and retry.",
    };
  }
  const authCheck = spawnSync("gh", ["auth", "status"], { stdio: "pipe" });
  if (authCheck.status !== 0) {
    return {
      ok: false,
      reason: "gh CLI is not authenticated. Run `gh auth login` and retry.",
    };
  }
  return { ok: true };
}

function buildPrTitle(payload: RawResult): string {
  const model = typeof payload.model === "string" ? payload.model : undefined;
  const summary = (payload.summary as { percentage?: unknown } | undefined) ?? {};
  const pct = typeof summary.percentage === "number" ? `${summary.percentage}%` : undefined;
  const hardware = (payload.hardware as { cpu?: unknown; gpu?: unknown } | undefined) ?? {};
  const cpu = typeof hardware.cpu === "string" ? hardware.cpu : undefined;
  const gpu = typeof hardware.gpu === "string" ? hardware.gpu : undefined;

  const headline = model ?? "agent benchmark";
  const score = pct ? ` ${pct}` : "";
  const hwShort = gpu && gpu !== "None detected" ? gpu : (cpu ?? "unknown hardware");

  return `benchmark: ${headline}${score} on ${hwShort}`.slice(0, 100);
}

function buildPrBody(payload: RawResult, runId: string): string {
  const lines: string[] = ["## Benchmark Result", ""];
  if (typeof payload.model === "string") {
    lines.push(`- **Model:** ${payload.model}`);
  }
  if (typeof payload.backend === "string") {
    lines.push(`- **Backend:** ${payload.backend}`);
  }
  const summary = (payload.summary as Record<string, unknown> | undefined) ?? {};
  if (typeof summary.percentage === "number") {
    const total =
      typeof summary.totalScore === "number" || typeof summary.totalScore === "string"
        ? summary.totalScore
        : "?";
    const max =
      typeof summary.maxScore === "number" || typeof summary.maxScore === "string"
        ? summary.maxScore
        : "?";
    lines.push(`- **Score:** ${summary.percentage}% (${total}/${max})`);
  }
  if (typeof summary.avgTokensPerSecond === "number") {
    lines.push(`- **Speed:** ${summary.avgTokensPerSecond.toFixed(1)} tok/s avg`);
  }
  const hardware = (payload.hardware as Record<string, unknown> | undefined) ?? {};
  if (typeof hardware.cpu === "string") {
    lines.push(`- **CPU:** ${hardware.cpu}`);
  }
  if (typeof hardware.ram === "string") {
    lines.push(`- **RAM:** ${hardware.ram}`);
  }
  if (typeof hardware.gpu === "string") {
    lines.push(`- **GPU:** ${hardware.gpu}`);
  }
  lines.push("", `- **Run ID:** ${runId}`, "");
  lines.push("This result was submitted via `gemmaclaw benchmark submit`.");
  lines.push(
    "All known private identifiers (hostname, username, home paths, private URLs) are stripped before upload.",
  );
  return lines.join("\n");
}

/**
 * Run the submit workflow. Returns the PR URL on success, or `null` for
 * dry-run mode.
 */
export async function submitBenchmarkCommand(
  opts: SubmitOpts = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<string | null> {
  const resultsRoot = opts.resultsRoot ?? DEFAULT_RESULTS_ROOT;
  const targetRepo = opts.repo ?? DEFAULT_REPO;
  const datasetDir = opts.datasetDir ?? DEFAULT_DATASET_DIR;
  const dryRun = Boolean(opts.dryRun);

  const resolvedDir = opts.resultsDir
    ? path.resolve(opts.resultsDir)
    : findNewestResultsDir(path.resolve(resultsRoot));

  const resultsJsonPath = path.join(resolvedDir, "results.json");
  if (!fs.existsSync(resultsJsonPath)) {
    runtime.error(`No results.json found at ${resultsJsonPath}`);
    runtime.exit(2);
    return null;
  }

  const raw = fs.readFileSync(resultsJsonPath, "utf8");
  let parsed: RawResult;
  try {
    parsed = JSON.parse(raw) as RawResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runtime.error(`Failed to parse ${resultsJsonPath}: ${msg}`);
    runtime.exit(2);
    return null;
  }

  const anonymized = anonymizeOnDiskResult(parsed);
  const runId = deriveRunId(anonymized, path.basename(resolvedDir));
  const branchName = `benchmark/${runId}`;
  const resultFileName = `${runId}.json`;
  const prTitle = buildPrTitle(anonymized);
  const prBody = buildPrBody(anonymized, runId);

  runtime.log(`Source: ${resolvedDir}`);
  runtime.log(`Run ID: ${runId}`);
  runtime.log(`Target: ${targetRepo} (${datasetDir}/${resultFileName})`);
  runtime.log(`Branch: ${branchName}`);
  runtime.log(`Title:  ${prTitle}`);

  if (dryRun) {
    runtime.log("");
    runtime.log("--- ANONYMIZED PAYLOAD (dry-run) ---");
    runtime.log(JSON.stringify(anonymized, null, 2));
    runtime.log("");
    runtime.log("--- PR BODY (dry-run) ---");
    runtime.log(prBody);
    runtime.log("");
    runtime.log("Dry run complete. No fork or PR was created.");
    return null;
  }

  const ghStatus = checkGhAvailable();
  if (!ghStatus.ok) {
    runtime.error(ghStatus.reason);
    runtime.exit(2);
    return null;
  }

  // Fork (idempotent).
  runtime.log(`Ensuring fork of ${targetRepo}...`);
  try {
    execSync(`gh repo fork ${targetRepo} --clone=false`, { stdio: "pipe", timeout: 30_000 });
  } catch {
    // Fork already exists, that's fine.
  }

  const ghUser = execSync("gh api user --jq .login", {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const repoName = targetRepo.split("/")[1];
  const forkRepo = `${ghUser}/${repoName}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemmaclaw-submit-"));
  runtime.log(`Cloning ${forkRepo} to ${tmpDir}...`);
  try {
    execSync(`gh repo clone ${forkRepo} ${tmpDir} -- --depth 1`, {
      stdio: "pipe",
      timeout: 60_000,
    });
    // Sync default branch with upstream so PR doesn't include unrelated drift.
    execSync(`git remote add upstream https://github.com/${targetRepo}.git`, {
      cwd: tmpDir,
      stdio: "pipe",
    });
    execSync("git fetch upstream", { cwd: tmpDir, stdio: "pipe", timeout: 60_000 });
    const defaultBranch = execSync("git symbolic-ref --short HEAD", {
      cwd: tmpDir,
      encoding: "utf8",
    }).trim();
    try {
      execSync(`git reset --hard upstream/${defaultBranch}`, { cwd: tmpDir, stdio: "pipe" });
    } catch {
      // If upstream branch differs in name, fall back to upstream/main.
      execSync("git reset --hard upstream/main", { cwd: tmpDir, stdio: "pipe" });
    }

    execSync(`git checkout -b "${branchName}"`, { cwd: tmpDir, stdio: "pipe" });

    const targetSubDir = path.join(tmpDir, datasetDir);
    fs.mkdirSync(targetSubDir, { recursive: true });
    fs.writeFileSync(path.join(targetSubDir, resultFileName), JSON.stringify(anonymized, null, 2));

    execSync(`git add "${datasetDir}/${resultFileName}"`, { cwd: tmpDir, stdio: "pipe" });
    execSync(`git commit -m "benchmark: add result ${runId}"`, { cwd: tmpDir, stdio: "pipe" });

    runtime.log("Pushing branch and opening PR...");
    execSync(`git push --force-with-lease origin "${branchName}"`, {
      cwd: tmpDir,
      stdio: "pipe",
      timeout: 60_000,
    });

    const prBodyFile = path.join(tmpDir, ".pr-body.md");
    fs.writeFileSync(prBodyFile, prBody);
    const prUrl = execSync(
      `gh pr create --repo ${targetRepo} --head "${ghUser}:${branchName}" --title ${JSON.stringify(prTitle)} --body-file ${JSON.stringify(prBodyFile)}`,
      { cwd: tmpDir, encoding: "utf8", timeout: 30_000 },
    ).trim();

    runtime.log(`PR opened: ${prUrl}`);
    return prUrl;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
