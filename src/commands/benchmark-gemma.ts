import fs from "node:fs";
import path from "node:path";
import type { BackendType } from "../gemmaclaw/benchmark/runner.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export type BenchmarkGemmaCommandOpts = {
  mock?: boolean;
  model?: string;
  backend?: string;
  ollamaUrl?: string;
  llamaCppUrl?: string;
  gguf?: string;
  filter?: string;
  outputDir?: string;
  contextLength?: number;
  gpuLayers?: number;
  batchSize?: number;
  pack?: string;
  runner?: string;
  listPack?: boolean;
  validatePack?: boolean;
};

export async function benchmarkGemmaCommand(
  opts: BenchmarkGemmaCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  // Pack-aware short-circuits run before any backend probing or runner setup.
  // These cover: --validate-pack, --list-pack, and any agent-family pack (which
  // is not executable through the tool-free benchmark runner).
  const packHandled = await handlePackCommands(opts, runtime);
  if (packHandled) {
    return;
  }

  const { detectHardware, formatHardwareInfo } = await import("../gemmaclaw/provision/hardware.js");
  const { BENCHMARK_TASKS, runBenchmark, writeResults, getMaxPossibleScore } =
    await import("../gemmaclaw/benchmark/index.js");
  const { findPreset } = await import("../gemmaclaw/provision/model-registry.js");

  // Resolve backend.
  const backend: BackendType = (
    opts.backend === "llama-cpp" ? "llama-cpp" : "ollama"
  ) as BackendType;

  // Resolve model. Priority: --model flag > gemmaclaw config > default.
  const model = opts.model ?? resolveConfiguredModel() ?? "gemma3:4b";
  const ollamaUrl = opts.ollamaUrl ?? "http://127.0.0.1:11434";
  const llamaCppUrl = opts.llamaCppUrl ?? "http://127.0.0.1:8080";
  const isMock = Boolean(opts.mock);

  // Look up preset for context length defaults.
  const preset = findPreset(model);
  const contextLength = opts.contextLength ?? preset?.defaultContextLength;

  runtime.log("");
  runtime.log("========================================");
  runtime.log(`  Gemmaclaw Benchmark${isMock ? " (deterministic)" : ""}`);
  runtime.log("========================================");
  runtime.log("");

  // Detect hardware.
  runtime.log("Detecting hardware...");
  const hw = detectHardware();
  for (const line of formatHardwareInfo(hw)) {
    runtime.log(line);
  }
  runtime.log("");

  // Filter tasks if requested.
  let tasks = [...BENCHMARK_TASKS];
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    tasks = tasks.filter(
      (t) =>
        t.id.toLowerCase().includes(f) ||
        t.category.toLowerCase().includes(f) ||
        t.difficulty.toLowerCase().includes(f) ||
        t.name.toLowerCase().includes(f),
    );
  }

  if (tasks.length === 0) {
    runtime.error(`No tasks match filter "${opts.filter}"`);
    runtime.exit(1);
    return;
  }

  runtime.log(`Backend: ${backend}`);
  runtime.log(`Model: ${model}`);
  if (preset) {
    runtime.log(`Preset: ${preset.displayName} (${preset.architecture}, ${preset.parameterCount})`);
  }
  if (backend === "ollama") {
    runtime.log(`Ollama: ${ollamaUrl}`);
  } else {
    runtime.log(`llama-server: ${llamaCppUrl}`);
    if (opts.gguf) {
      runtime.log(`GGUF: ${opts.gguf}`);
    }
  }
  runtime.log(`Tasks: ${tasks.length} (max ${getMaxPossibleScore()} points)`);
  runtime.log(`Mode: ${isMock ? "deterministic (mock)" : "full (LLM judge)"}`);
  if (contextLength) {
    runtime.log(`Context length: ${contextLength}`);
  }
  if (opts.gpuLayers != null) {
    runtime.log(`GPU layers: ${opts.gpuLayers}`);
  }
  if (opts.batchSize) {
    runtime.log(`Batch size: ${opts.batchSize}`);
  }
  runtime.log("");

  // Verify backend is reachable (unless mock-only with no real inference needed).
  if (!isMock) {
    if (backend === "ollama") {
      try {
        await ollamaPing(ollamaUrl, model);
        runtime.log("Ollama connection verified.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        runtime.error(`Cannot reach Ollama at ${ollamaUrl}: ${msg}`);
        runtime.error("Make sure Ollama is running with the model loaded.");
        runtime.error("  ollama serve");
        runtime.error(`  ollama pull ${model}`);
        runtime.exit(1);
        return;
      }
    } else {
      try {
        await llamaCppPing(llamaCppUrl);
        runtime.log("llama-server connection verified.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        runtime.error(`Cannot reach llama-server at ${llamaCppUrl}: ${msg}`);
        runtime.error("Make sure llama-server is running:");
        runtime.error(`  llama-server --model <gguf-path> --port 8080 --host 127.0.0.1 -ngl 99`);
        runtime.exit(1);
        return;
      }
    }
  }

  // Run benchmark.
  const result = await runBenchmark(
    tasks,
    {
      backend,
      ollamaUrl,
      llamaCppUrl,
      model,
      ggufPath: opts.gguf,
      mock: isMock,
      filter: opts.filter,
      contextLength,
      gpuLayers: opts.gpuLayers,
      batchSize: opts.batchSize,
    },
    hw,
    (msg) => runtime.log(msg),
  );

  // Write results.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backendSuffix = backend === "llama-cpp" ? "__llamacpp" : "__ollama";
  const defaultDir = path.join(
    process.cwd(),
    "benchmark-results",
    `${safePathSegment(model)}${backendSuffix}__${timestamp}`,
  );
  const outputDir = opts.outputDir ?? defaultDir;
  const files = writeResults(result, outputDir);

  // Print summary.
  const s = result.summary;
  runtime.log("");
  runtime.log("========================================");
  runtime.log("  RESULTS");
  runtime.log("========================================");
  runtime.log(`  Backend: ${backend}`);
  runtime.log(`  Score: ${s.totalScore} / ${s.maxScore} (${s.percentage}%)`);
  runtime.log(`  Pass rate: ${s.passRate}% (${s.passedCount}/${s.passedCount + s.failedCount})`);
  runtime.log(`  Time: ${(s.totalTimeMs / 1000).toFixed(1)}s`);
  if (s.avgTokensPerSecond != null) {
    runtime.log(`  Avg tok/s: ${s.avgTokensPerSecond}`);
  }
  if (s.medianTokensPerSecond != null) {
    runtime.log(`  Median tok/s: ${s.medianTokensPerSecond}`);
  }
  if (s.p50LatencyMs != null) {
    runtime.log(`  p50 latency: ${(s.p50LatencyMs / 1000).toFixed(1)}s`);
  }
  if (s.p95LatencyMs != null) {
    runtime.log(`  p95 latency: ${(s.p95LatencyMs / 1000).toFixed(1)}s`);
  }
  if (s.totalPromptTokens > 0) {
    runtime.log(`  Prompt tokens: ${s.totalPromptTokens}`);
  }
  if (s.totalCompletionTokens > 0) {
    runtime.log(`  Completion tokens: ${s.totalCompletionTokens}`);
  }
  // Show failure modes if any errors occurred.
  const errorModes = Object.entries(s.failureModes).filter(([k]) => k !== "none");
  if (errorModes.length > 0) {
    runtime.log(`  Failures: ${errorModes.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  runtime.log("");
  runtime.log(`  JSON: ${files.json}`);
  runtime.log(`  Markdown: ${files.markdown}`);
  runtime.log(`  Dashboard: ${files.html}`);
  runtime.log("========================================");
}

function resolveConfiguredModel(): string | undefined {
  // Check openclaw.json for a configured model.
  const configPaths = [
    path.join(process.env.HOME ?? "", ".openclaw", "openclaw.json"),
    path.join(process.cwd(), "openclaw.json"),
  ];

  for (const cp of configPaths) {
    try {
      const raw = fs.readFileSync(cp, "utf8");
      const config = JSON.parse(raw);
      // Look for model in various config locations.
      const model = config.model ?? config.llm?.model ?? config.agents?.defaults?.model;
      if (typeof model === "string" && model.length > 0) {
        return model;
      }
    } catch {
      // Config not found or invalid, continue.
    }
  }
  return undefined;
}

async function ollamaPing(url: string, model: string): Promise<{ content: string }> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      keep_alive: "6h",
      options: { num_predict: 5 },
    });

    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 11434,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 120_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve({ content: data.message?.content ?? "" });
          } catch (e: unknown) {
            reject(new Error(`Invalid Ollama response: ${String(e)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Ollama ping timed out"));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Resolve the pack argument to either a built-in name or a filesystem path.
 * Returns null if no `--pack` was supplied (existing core flow keeps running).
 */
async function handlePackCommands(
  opts: BenchmarkGemmaCommandOpts,
  runtime: RuntimeEnv,
): Promise<boolean> {
  const requestedRunner = opts.runner;
  const requestedPack = opts.pack;
  const wantsList = Boolean(opts.listPack);
  const wantsValidate = Boolean(opts.validatePack);

  // Without --pack, --list-pack, --validate-pack, or --runner, fall through
  // to the existing core flow (back-compat: `gemmaclaw benchmark` still works).
  if (!requestedPack && !wantsList && !wantsValidate && !requestedRunner) {
    return false;
  }

  const { BUILTIN_PACKS, builtinPackPath, loadBenchmarkPack } =
    await import("../gemmaclaw/benchmark-kit/index.js");

  // Resolve the pack source. Default to "core" if other pack-only flags were
  // passed without --pack (validate/list of nothing is unhelpful but
  // explicit > implicit when the user asked).
  const packArg = requestedPack ?? "core";
  let packPath: string;
  const isBuiltin = (BUILTIN_PACKS as readonly string[]).includes(packArg);
  if (isBuiltin) {
    packPath = builtinPackPath(packArg as (typeof BUILTIN_PACKS)[number]);
  } else {
    packPath = path.resolve(packArg);
    if (!fs.existsSync(packPath)) {
      runtime.error(
        `Pack not found: '${packArg}'. Built-in packs: ${BUILTIN_PACKS.join(", ")}, ` +
          `or pass a path to a pack JSON.`,
      );
      runtime.exit(1);
      return true;
    }
  }

  let pack: Awaited<ReturnType<typeof loadBenchmarkPack>>;
  try {
    pack = loadBenchmarkPack(packPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    runtime.error(`Pack '${packArg}' failed to validate: ${msg}`);
    runtime.exit(1);
    return true;
  }

  if (wantsValidate) {
    runtime.log(
      `OK: pack '${pack.pack}' v${pack.version} (family=${pack.family}) ` +
        `validates against task-pack-v1. tasks=${pack.tasks.length}`,
    );
    return true;
  }

  if (wantsList) {
    runtime.log(`Pack: ${pack.pack} v${pack.version} (family=${pack.family})`);
    if (pack.description) {
      runtime.log(`Description: ${pack.description}`);
    }
    runtime.log(`Tasks: ${pack.tasks.length}`);
    for (const task of pack.tasks) {
      const max = "max_score" in task.grading ? task.grading.max_score : task.grading.maxScore;
      const difficulty = task.difficulty ?? "?";
      const name = task.name ?? task.id;
      runtime.log(`  - ${task.id} [${difficulty}] (${max} pts) — ${name}`);
    }
    return true;
  }

  // Agent-family packs run through the explicit agent runner seam. The
  // default public path is deterministic `mock-agent`: it proves the Jake
  // agent pack is loadable and executable in Gemmaclaw, and writes the same
  // standard artifact bundle, without requiring Frank's private Jake/OpenClaw
  // runtime. Live OpenClaw/Jake runners can still register under `agent`.
  if (pack.family === "agent") {
    const normalizedRequestedRunner = normalizeRunnerKind(requestedRunner);
    if (requestedRunner && !normalizedRequestedRunner) {
      runtime.error(
        `Unknown runner '${requestedRunner}'. Valid runners: core-model, agent, mock-agent.`,
      );
      runtime.exit(2);
      return true;
    }
    const desiredRunner = normalizedRequestedRunner ?? "mock-agent";
    if (desiredRunner === "core-model") {
      runtime.error(
        `Agent pack '${pack.pack}' cannot be executed by runner '${desiredRunner}'. ` +
          `Use --runner mock-agent for the built-in deterministic smoke path, ` +
          `or --runner agent from a custom binary that registers a live agent runner.`,
      );
      runtime.exit(2);
      return true;
    }
    const { buildRunner, AgentRunnerNotConfiguredError, writeAgentBenchmarkResults } =
      await import("../gemmaclaw/benchmark-kit/index.js");
    const runner = (() => {
      try {
        return buildRunner(desiredRunner);
      } catch (e) {
        if (e instanceof AgentRunnerNotConfiguredError) {
          runtime.error(
            `Agent pack '${pack.pack}' loaded successfully (${pack.tasks.length} tasks), ` +
              "but no live agent runner is registered in this binary. " +
              "Use the built-in deterministic smoke path with --runner mock-agent, " +
              "or run via a custom binary that calls registerAgentRunner(factory).",
          );
          runtime.exit(2);
          return null;
        }
        throw e;
      }
    })();
    if (!runner) {
      return true;
    }

    const modelSpec =
      opts.model ?? (desiredRunner === "mock-agent" ? "mock-agent:jake-agent" : "agent:default");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outputDir =
      opts.outputDir ??
      path.join(
        process.cwd(),
        "benchmark-results",
        `${safePathSegment(pack.pack)}__${safePathSegment(runner.name)}__${safePathSegment(modelSpec)}__${timestamp}`,
      );

    runtime.log("");
    runtime.log("========================================");
    runtime.log("  Gemmaclaw Agent Benchmark");
    runtime.log("========================================");
    runtime.log(`Pack: ${pack.pack} v${pack.version}`);
    runtime.log(`Runner: ${runner.name}`);
    runtime.log(`Model spec: ${modelSpec}`);
    runtime.log(`Tasks: ${pack.tasks.length}`);
    runtime.log(`Output: ${outputDir}`);
    if (desiredRunner === "mock-agent") {
      runtime.log("Mode: deterministic agent smoke (no network, no private Jake runtime)");
    }
    runtime.log("");

    const runResult = await runner.run(pack, {
      modelSpec,
      outDir: outputDir,
      onProgress: (line) => runtime.log(line),
    });
    const files = writeAgentBenchmarkResults(pack, runResult, outputDir);
    const s = files.artifact.summary;

    runtime.log("");
    runtime.log("========================================");
    runtime.log("  AGENT RESULTS");
    runtime.log("========================================");
    runtime.log(`  Pack: ${files.artifact.pack.id}`);
    runtime.log(`  Runner: ${files.artifact.runner.name}`);
    runtime.log(`  Score: ${s.totalScore} / ${s.maxScore} (${s.percentage}%)`);
    runtime.log(`  Pass rate: ${s.passRate}% (${s.passedCount}/${s.passedCount + s.failedCount})`);
    runtime.log(`  JSON: ${files.json}`);
    runtime.log(`  Markdown: ${files.markdown}`);
    runtime.log(`  Dashboard: ${files.html}`);
    runtime.log("========================================");
    return true;
  }

  const normalizedRunner = normalizeRunnerKind(requestedRunner);
  if (requestedRunner && !normalizedRunner) {
    runtime.error(
      `Unknown runner '${requestedRunner}'. Valid runners: core-model, agent, mock-agent.`,
    );
    runtime.exit(2);
    return true;
  }

  // Tool-free pack with explicit --pack: the user wants the existing core
  // flow but pointed at a different pack file. Only the built-in 'core' pack
  // is wired into the benchmark/index.ts task graph today; for other tool-
  // free packs, point users at --list-pack / --validate-pack.
  if (requestedPack && requestedPack !== "core") {
    runtime.error(
      `Tool-free pack '${pack.pack}' is supported by the loader and v1 schema, ` +
        `but the gemmaclaw benchmark runner currently only executes the built-in ` +
        `'core' pack. Use --list-pack or --validate-pack for now, or run the pack ` +
        `via the jake-benchmark CLI which supports arbitrary tool-free packs.`,
    );
    runtime.exit(2);
    return true;
  }

  if (normalizedRunner && normalizedRunner !== "core-model") {
    runtime.error(
      `Runner '${requestedRunner}' is incompatible with tool-free pack '${pack.pack}'. ` +
        `Use --runner core-model or omit --runner.`,
    );
    runtime.exit(2);
    return true;
  }

  // Fall through: tool-free 'core' pack, no --runner override → existing flow.
  return false;
}

function normalizeRunnerKind(
  raw: string | undefined,
): "core-model" | "agent" | "mock-agent" | null {
  if (!raw) {
    return null;
  }
  if (raw === "core-model" || raw === "agent" || raw === "mock-agent") {
    return raw;
  }
  return null;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

async function llamaCppPing(url: string): Promise<void> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 8080,
        path: "/health",
        method: "GET",
        timeout: 10_000,
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`llama-server health check returned ${res.statusCode}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("llama-server ping timed out"));
    });
    req.end();
  });
}
