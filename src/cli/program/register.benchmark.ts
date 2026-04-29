import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerBenchmarkCommand(program: Command) {
  const bench = program
    .command("benchmark")
    .description("Run the gemmaclaw benchmark suite (Docker by default, --local to skip)")
    .option("--mock", "Run deterministic scoring only (no LLM judge, fast CI mode)", false)
    .option("--local", "Run directly on the host instead of inside Docker", false)
    .option("--model <model>", "Ollama model name (default: from config or gemma3:4b)")
    .option("--ollama-url <url>", "Ollama API URL (default: http://127.0.0.1:11434)")
    .option("--filter <text>", "Run only tasks matching this text (id, category, difficulty, name)")
    .option(
      "--output-dir <dir>",
      "Output directory for results (default: ./results/<model>__<timestamp>)",
    )
    .option("--context-length <n>", "Context window size (num_ctx)", parseInt)
    .option("--gpu-layers <n>", "Number of GPU layers (num_gpu)", parseInt)
    .option("--batch-size <n>", "Batch size (num_batch)", parseInt)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { benchmarkGemmaCommand } = await import("../../commands/benchmark-gemma.js");
        await benchmarkGemmaCommand({
          mock: Boolean(opts.mock),
          local: Boolean(opts.local),
          model: opts.model as string | undefined,
          ollamaUrl: opts.ollamaUrl as string | undefined,
          filter: opts.filter as string | undefined,
          outputDir: opts.outputDir as string | undefined,
          contextLength: opts.contextLength as number | undefined,
          gpuLayers: opts.gpuLayers as number | undefined,
          batchSize: opts.batchSize as number | undefined,
        });
      });
    });

  bench
    .command("sandbox")
    .description(
      "Run a benchmark inside a persistent Docker container with a custom file. Returns a container ID for easy iteration.",
    )
    .requiredOption("--file <path>", "Path to the file to include in the container")
    .option("--model <model>", "Ollama model name (default: gemma3:1b)")
    .option("--mock", "Run deterministic scoring only (no LLM judge)", false)
    .option("--keep", "Keep the container running after the benchmark finishes", false)
    .option("--gemini-api-key <key>", "Gemini API key for cloud-based evaluation")
    .option("--gemini-model <model>", "Gemini model name (default: gemini-2.5-pro)")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { benchmarkSandboxCommand } = await import("../../commands/benchmark-gemma.js");
        await benchmarkSandboxCommand({
          file: opts.file as string,
          model: opts.model as string | undefined,
          mock: Boolean(opts.mock),
          keep: Boolean(opts.keep),
          geminiApiKey: opts.geminiApiKey as string | undefined,
          geminiModel: opts.geminiModel as string | undefined,
        });
      });
    });
}
