import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerBenchmarkCommand(program: Command) {
  const benchmark = program
    .command("benchmark")
    .description("Run the gemmaclaw benchmark suite against your local Gemma model")
    .option("--mock", "Run deterministic scoring only (no LLM judge, fast CI mode)", false)
    .option("--model <model>", "Model name or Ollama tag (default: from config or gemma3:4b)")
    .option(
      "--backend <backend>",
      "Inference backend: ollama or llama-cpp (default: ollama)",
      "ollama",
    )
    .option("--ollama-url <url>", "Ollama API URL (default: http://127.0.0.1:11434)")
    .option("--llama-cpp-url <url>", "llama-server API URL (default: http://127.0.0.1:8080)")
    .option("--gguf <path>", "Path to GGUF model file (for llama-cpp backend info)")
    .option("--filter <text>", "Run only tasks matching this text (id, category, difficulty, name)")
    .option(
      "--output-dir <dir>",
      "Output directory for results (default: ./benchmark-results/<run>__<timestamp>)",
    )
    .option("--context-length <n>", "Context window size (num_ctx)", parseInt)
    .option("--gpu-layers <n>", "Number of GPU layers (num_gpu)", parseInt)
    .option("--batch-size <n>", "Batch size (num_batch)", parseInt)
    .option(
      "--pack <name|path>",
      "Task pack: 'core' (default tool-free), 'jake-agent' (agent pack), or path to a pack JSON",
    )
    .option(
      "--runner <kind>",
      "Runner: 'core-model' (tool-free), 'mock-agent' (default for jake-agent), or 'agent' (requires registered runner)",
    )
    .option(
      "--list-pack",
      "Print pack metadata and task summaries instead of running. Useful with --pack jake-agent.",
      false,
    )
    .option(
      "--validate-pack",
      "Validate the pack against the v1 schema and exit. Combine with --pack <name|path>.",
      false,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { benchmarkGemmaCommand } = await import("../../commands/benchmark-gemma.js");
        await benchmarkGemmaCommand({
          mock: Boolean(opts.mock),
          model: opts.model as string | undefined,
          backend: opts.backend as string | undefined,
          ollamaUrl: opts.ollamaUrl as string | undefined,
          llamaCppUrl: opts.llamaCppUrl as string | undefined,
          gguf: opts.gguf as string | undefined,
          filter: opts.filter as string | undefined,
          outputDir: opts.outputDir as string | undefined,
          contextLength: opts.contextLength as number | undefined,
          gpuLayers: opts.gpuLayers as number | undefined,
          batchSize: opts.batchSize as number | undefined,
          pack: opts.pack as string | undefined,
          runner: opts.runner as string | undefined,
          listPack: Boolean(opts.listPack),
          validatePack: Boolean(opts.validatePack),
        });
      });
    });

  benchmark
    .command("submit [results-dir]")
    .description(
      "Package a benchmark result, anonymize it, and open a PR to share it with the community",
    )
    .option(
      "--repo <owner/name>",
      "GitHub repo to open the PR against (default: gemmaclaw/gemmaclaw)",
    )
    .option(
      "--dataset-dir <dir>",
      "Subdirectory in the target repo for results (default: community-benchmarks)",
    )
    .option(
      "--results-root <dir>",
      "Root directory containing benchmark runs when auto-detecting (default: ./benchmark-results)",
    )
    .option(
      "--dry-run",
      "Print the anonymized payload and PR body without forking or pushing",
      false,
    )
    .option("-y, --yes", "Skip confirmation prompts", false)
    .action(async (resultsDir: string | undefined, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { submitBenchmarkCommand } = await import("../../commands/submit-benchmark.js");
        await submitBenchmarkCommand(
          {
            resultsDir,
            repo: opts.repo as string | undefined,
            datasetDir: opts.datasetDir as string | undefined,
            resultsRoot: opts.resultsRoot as string | undefined,
            dryRun: Boolean(opts.dryRun),
            yes: Boolean(opts.yes),
          },
          defaultRuntime,
        );
      });
    });
}
