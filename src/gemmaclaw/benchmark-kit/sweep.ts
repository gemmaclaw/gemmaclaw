/**
 * Sweep runner: iterates over a config matrix (model x context x thinking level),
 * runs the benchmark for each combination, saves intermediate state for resumability.
 */

import fs from "node:fs";
import path from "node:path";
import type { BenchmarkResult, BenchmarkConfig } from "../benchmark/runner.js";
import { runBenchmark } from "../benchmark/runner.js";
import type { BenchmarkTask } from "../benchmark/tasks.js";
import type { HardwareInfo } from "../provision/hardware.js";
import { selectBestConfig, type RecommendedConfig } from "./select-config.js";

export type SweepConfig = {
  models: string[];
  contextWindows: number[];
  thinkingLevels: string[];
  ollamaUrl: string;
  outputDir: string;
  gpuLayers?: number;
  batchSize?: number;
};

type SweepState = {
  completed: string[]; // "model|ctx|thinking" keys
  results: BenchmarkResult[];
};

function sweepKey(model: string, ctx: number, thinking: string): string {
  return `${model}|${ctx}|${thinking}`;
}

function stateFilePath(outputDir: string): string {
  return path.join(outputDir, "sweep-state.json");
}

function loadState(outputDir: string): SweepState {
  const fp = stateFilePath(outputDir);
  if (fs.existsSync(fp)) {
    try {
      return JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch {
      // Corrupted state, start fresh.
    }
  }
  return { completed: [], results: [] };
}

function saveState(outputDir: string, state: SweepState): void {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(stateFilePath(outputDir), JSON.stringify(state, null, 2));
}

export async function runSweep(
  tasks: BenchmarkTask[],
  sweepCfg: SweepConfig,
  hardware: HardwareInfo,
  progress?: (msg: string) => void,
): Promise<{ results: BenchmarkResult[]; recommended: RecommendedConfig | null }> {
  const log = progress ?? console.log;
  const state = loadState(sweepCfg.outputDir);

  // Build the full matrix.
  const matrix: Array<{ model: string; ctx: number; thinking: string }> = [];
  for (const model of sweepCfg.models) {
    for (const ctx of sweepCfg.contextWindows) {
      for (const thinking of sweepCfg.thinkingLevels) {
        matrix.push({ model, ctx, thinking });
      }
    }
  }

  const total = matrix.length;
  const remaining = matrix.filter(
    (m) => !state.completed.includes(sweepKey(m.model, m.ctx, m.thinking)),
  );

  log(`\nSweep: ${total} configs total, ${remaining.length} remaining`);
  if (state.completed.length > 0) {
    log(`  Resuming from ${state.completed.length} completed runs`);
  }

  for (let i = 0; i < remaining.length; i++) {
    const { model, ctx, thinking } = remaining[i];
    const key = sweepKey(model, ctx, thinking);
    const runLabel = `[${state.completed.length + 1}/${total}]`;

    log(`\n${runLabel} ${model} ctx=${ctx} thinking=${thinking}`);

    const config: BenchmarkConfig = {
      ollamaUrl: sweepCfg.ollamaUrl,
      model,
      mock: false,
      contextLength: ctx,
      gpuLayers: sweepCfg.gpuLayers,
      batchSize: sweepCfg.batchSize,
    };

    // Extend config with thinkingLevel (not in base BenchmarkConfig type, but
    // the runner passes it through to Ollama options).
    (config as Record<string, unknown>).thinkingLevel = thinking;

    try {
      const result = await runBenchmark(tasks, config, hardware, log);
      state.results.push(result);
      state.completed.push(key);
      saveState(sweepCfg.outputDir, state);

      // Write individual result file.
      const runDir = path.join(
        sweepCfg.outputDir,
        `${model.replace(/[/:]/g, "-")}__ctx${ctx}__think-${thinking}`,
      );
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(result, null, 2));

      log(
        `  Done: ${result.summary.percentage}% (${result.summary.avgTokensPerSecond?.toFixed(1) ?? "?"} tok/s)`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`  ERROR: ${msg}`);
      // Mark as completed to avoid infinite retry loops. The error is recorded
      // in the state so users can see which configs failed.
      state.completed.push(key);
      saveState(sweepCfg.outputDir, state);
    }
  }

  // Select best config.
  const recommended = selectBestConfig(state.results);

  if (recommended) {
    fs.writeFileSync(
      path.join(sweepCfg.outputDir, "recommended.json"),
      JSON.stringify(recommended, null, 2),
    );
    log(`\nRecommended config:`);
    log(`  Model: ${recommended.model}`);
    log(`  Quality: ${recommended.qualityPct}%`);
    log(`  Speed: ${recommended.tokPerSec?.toFixed(1) ?? "?"} tok/s`);
    log(`  Composite: ${recommended.compositeScore}`);
    log(`  ${recommended.reasoning}`);
  } else {
    log(`\nNo config met the minimum quality threshold.`);
  }

  // Write summary.
  const summaryPath = path.join(sweepCfg.outputDir, "sweep-summary.md");
  const summaryLines = [
    "# Benchmark Sweep Summary",
    "",
    `Date: ${new Date().toISOString()}`,
    `Configs tested: ${state.completed.length}`,
    "",
    "## Results",
    "",
    "| Model | Context | Thinking | Score | tok/s |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const r of state.results) {
    const thinkingRaw = (r.config as Record<string, unknown>).thinkingLevel;
    const thinking = typeof thinkingRaw === "string" ? thinkingRaw : "off";
    const tps = r.summary.avgTokensPerSecond?.toFixed(1) ?? "-";
    summaryLines.push(
      `| ${r.config.model} | ${r.config.contextLength ?? "-"} | ${thinking} | ${r.summary.percentage}% | ${tps} |`,
    );
  }

  if (recommended) {
    summaryLines.push(
      "",
      "## Recommended",
      "",
      `**${recommended.model}** (composite: ${recommended.compositeScore})`,
      "",
      recommended.reasoning,
    );
  }

  fs.writeFileSync(summaryPath, summaryLines.join("\n"));

  return { results: state.results, recommended };
}
