#!/usr/bin/env node
/**
 * Standalone benchmark CLI runner.
 * Allows running benchmarks directly via `pnpm benchmark` without building the full project.
 *
 * Usage:
 *   pnpm benchmark                          # Docker (default)
 *   pnpm benchmark --local                  # Direct host execution
 *   pnpm benchmark --mock                   # Deterministic mock mode
 *   pnpm benchmark --model gemma3:4b        # Specify model
 *   pnpm benchmark --filter coding          # Run only coding tasks
 *   pnpm benchmark --context-length 8192    # Set context window
 *   pnpm benchmark sandbox --file tasks.json   # Sandbox with custom file
 */

import process from "node:process";
import { benchmarkGemmaCommand, benchmarkSandboxCommand } from "../../commands/benchmark-gemma.js";
import { defaultRuntime } from "../../runtime.js";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const opts: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mock") {
      opts.mock = true;
    } else if (arg === "--local") {
      opts.local = true;
    } else if (arg === "--keep") {
      opts.keep = true;
    } else if (arg === "--model" && args[i + 1]) {
      opts.model = args[++i]!;
    } else if (arg === "--ollama-url" && args[i + 1]) {
      opts.ollamaUrl = args[++i]!;
    } else if (arg === "--filter" && args[i + 1]) {
      opts.filter = args[++i]!;
    } else if (arg === "--output-dir" && args[i + 1]) {
      opts.outputDir = args[++i]!;
    } else if (arg === "--context-length" && args[i + 1]) {
      opts.contextLength = args[++i]!;
    } else if (arg === "--gpu-layers" && args[i + 1]) {
      opts.gpuLayers = args[++i]!;
    } else if (arg === "--batch-size" && args[i + 1]) {
      opts.batchSize = args[++i]!;
    } else if (arg === "--file" && args[i + 1]) {
      opts.file = args[++i]!;
    } else if (arg === "--gemini-api-key" && args[i + 1]) {
      opts.geminiApiKey = args[++i]!;
    } else if (arg === "--gemini-model" && args[i + 1]) {
      opts.geminiModel = args[++i]!;
    } else if (arg === "sandbox") {
      opts.sandbox = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: pnpm benchmark [options]
       pnpm benchmark sandbox --file <path> [options]

Commands:
  sandbox              Run benchmark in a persistent Docker container with a custom file

Options:
  --mock                 Run deterministic scoring only (fast, no LLM judge)
  --local                Run directly on the host instead of inside Docker
  --model <name>         Ollama model name (default: from config or gemma3:4b)
  --ollama-url <url>     Ollama API URL (default: http://127.0.0.1:11434)
  --filter <text>        Run only tasks matching text (id, category, difficulty)
  --output-dir <dir>     Output directory for results
  --context-length <n>   Context window size
  --gpu-layers <n>       Number of GPU layers
  --batch-size <n>       Batch size
  -h, --help             Show this help

Sandbox options:
  --file <path>          Path to the file to include in the container (required)
  --keep                 Keep container running after benchmark finishes
  --mock                 Run deterministic scoring only
  --model <name>         Ollama model name (default: gemma3:1b)
  --gemini-api-key <key> Gemini API key for cloud-based evaluation
  --gemini-model <model> Gemini model name (default: gemini-2.5-pro)
`);
      process.exit(0);
    }
  }

  return opts;
}

const opts = parseArgs(process.argv);

if (opts.sandbox) {
  if (!opts.file) {
    console.error("Error: --file is required for sandbox mode");
    process.exit(1);
  }
  benchmarkSandboxCommand(
    {
      file: opts.file as string,
      model: opts.model as string | undefined,
      mock: Boolean(opts.mock),
      keep: Boolean(opts.keep),
      geminiApiKey: opts.geminiApiKey as string | undefined,
      geminiModel: opts.geminiModel as string | undefined,
    },
    defaultRuntime,
  ).catch((err) => {
    console.error("Benchmark sandbox failed:", err);
    process.exit(1);
  });
} else {
  benchmarkGemmaCommand(
    {
      mock: Boolean(opts.mock),
      local: Boolean(opts.local),
      model: opts.model as string | undefined,
      ollamaUrl: opts.ollamaUrl as string | undefined,
      filter: opts.filter as string | undefined,
      outputDir: opts.outputDir as string | undefined,
      contextLength: opts.contextLength
        ? Number.parseInt(String(opts.contextLength), 10)
        : undefined,
      gpuLayers: opts.gpuLayers ? Number.parseInt(String(opts.gpuLayers), 10) : undefined,
      batchSize: opts.batchSize ? Number.parseInt(String(opts.batchSize), 10) : undefined,
    },
    defaultRuntime,
  ).catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}
