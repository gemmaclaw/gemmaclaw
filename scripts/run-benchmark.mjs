#!/usr/bin/env node
/**
 * Direct benchmark runner that bypasses CLI config validation.
 * Usage: node scripts/run-benchmark.mjs --model gemma3:4b --backend ollama --output-dir benchmark-results/gemma3-4b__ollama
 */
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    model: { type: "string", default: "gemma3:4b" },
    backend: { type: "string", default: "ollama" },
    "ollama-url": { type: "string", default: "http://127.0.0.1:11434" },
    "llama-cpp-url": { type: "string", default: "http://127.0.0.1:8080" },
    "output-dir": { type: "string" },
    mock: { type: "boolean", default: false },
    filter: { type: "string" },
    "context-length": { type: "string" },
    "gpu-layers": { type: "string" },
    "batch-size": { type: "string" },
    gguf: { type: "string" },
  },
});

const { benchmarkGemmaCommand } = await import("../src/commands/benchmark-gemma.ts");

await benchmarkGemmaCommand({
  model: opts.model,
  backend: opts.backend,
  ollamaUrl: opts["ollama-url"],
  llamaCppUrl: opts["llama-cpp-url"],
  outputDir: opts["output-dir"],
  mock: opts.mock,
  filter: opts.filter,
  contextLength: opts["context-length"] ? Number.parseInt(opts["context-length"], 10) : undefined,
  gpuLayers: opts["gpu-layers"] ? Number.parseInt(opts["gpu-layers"], 10) : undefined,
  batchSize: opts["batch-size"] ? Number.parseInt(opts["batch-size"], 10) : undefined,
  gguf: opts.gguf,
});
