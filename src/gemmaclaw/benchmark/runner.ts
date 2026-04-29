/**
 * Benchmark runner: sends prompts to Ollama or llama-server, collects responses, scores them.
 *
 * Supports two backends:
 *   - ollama: Ollama API at /api/chat
 *   - llama-cpp: llama-server OpenAI-compatible API at /v1/chat/completions
 *
 * Supports two scoring modes:
 *   --mock: deterministic scoring against expected outputs (no LLM judge needed)
 *   default: full run with LLM judge scoring
 */

import http from "node:http";
import type { HardwareInfo } from "../provision/hardware.js";
import {
  buildJudgePrompt,
  parseJudgeResponse,
  scoreDeterministic,
  type TaskScore,
} from "./scorer.js";
import type { BenchmarkTask } from "./tasks.js";

export type BackendType = "ollama" | "llama-cpp" | "gemini";

export type BenchmarkConfig = {
  backend: BackendType;
  ollamaUrl: string;
  llamaCppUrl: string;
  model: string;
  ggufPath?: string;
  mock: boolean;
  filter?: string;
  contextLength?: number;
  gpuLayers?: number;
  batchSize?: number;
  geminiApiKey?: string;
  geminiModel?: string;
};

export type FailureMode =
  | "none"
  | "timeout"
  | "connection_error"
  | "empty_response"
  | "parse_error"
  | "server_error";

export type TaskResult = {
  task: BenchmarkTask;
  output: string;
  score: TaskScore;
  elapsedMs: number;
  tokensPerSecond?: number;
  promptTokens?: number;
  completionTokens?: number;
  timeToFirstTokenMs?: number;
  failureMode: FailureMode;
  error?: string;
};

export type BenchmarkResult = {
  config: BenchmarkConfig;
  hardware: HardwareInfo;
  tasks: TaskResult[];
  summary: {
    totalScore: number;
    maxScore: number;
    percentage: number;
    totalTimeMs: number;
    avgTokensPerSecond?: number;
    medianTokensPerSecond?: number;
    p50LatencyMs?: number;
    p95LatencyMs?: number;
    passedCount: number;
    failedCount: number;
    passRate: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    failureModes: Record<string, number>;
  };
  timestamp: string;
};

type ChatResponse = {
  content: string;
  evalCount?: number;
  evalDurationNs?: number;
  promptTokens?: number;
  completionTokens?: number;
};

function httpRequest(url: string, path: string, body: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString();
          if (status >= 400) {
            reject(new Error(`HTTP ${status}: ${text.slice(0, 200)}`));
          } else {
            resolve(text);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out (${timeoutMs}ms)`));
    });
    req.write(body);
    req.end();
  });
}

function ollamaChat(
  url: string,
  model: string,
  prompt: string,
  system?: string,
  options?: { num_ctx?: number; num_gpu?: number; num_batch?: number },
): Promise<ChatResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (system) {
    messages.push({ role: "system", content: system });
  }
  messages.push({ role: "user", content: prompt });

  const body = JSON.stringify({
    model,
    messages,
    stream: false,
    keep_alive: "6h",
    options: {
      ...(options?.num_ctx != null ? { num_ctx: options.num_ctx } : {}),
      ...(options?.num_gpu != null ? { num_gpu: options.num_gpu } : {}),
      ...(options?.num_batch != null ? { num_batch: options.num_batch } : {}),
    },
  });

  return httpRequest(url, "/api/chat", body, 300_000).then((text) => {
    const data = JSON.parse(text);
    return {
      content: data.message?.content ?? "",
      evalCount: data.eval_count,
      evalDurationNs: data.eval_duration,
      promptTokens: data.prompt_eval_count,
      completionTokens: data.eval_count,
    };
  });
}

function llamaCppChat(
  url: string,
  prompt: string,
  system?: string,
  options?: { num_ctx?: number },
): Promise<ChatResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (system) {
    messages.push({ role: "system", content: system });
  }
  messages.push({ role: "user", content: prompt });

  const body = JSON.stringify({
    messages,
    temperature: 0.7,
    max_tokens: 2048,
    ...(options?.num_ctx != null ? { max_context_length: options.num_ctx } : {}),
  });

  return httpRequest(url, "/v1/chat/completions", body, 300_000).then((text) => {
    const data = JSON.parse(text);
    const choice = data.choices?.[0];
    const usage = data.usage;
    return {
      content: choice?.message?.content ?? "",
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      evalCount: usage?.completion_tokens,
      evalDurationNs: undefined,
    };
  });
}

async function geminiChat(
  apiKey: string,
  model: string,
  prompt: string,
  system?: string,
): Promise<ChatResponse> {
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  if (system) {
    contents.push({ role: "user", parts: [{ text: system }] });
    contents.push({ role: "model", parts: [{ text: "Understood." }] });
  }
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const body = JSON.stringify({ contents });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const https = await import("node:https");
  const parsed = new URL(url);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 300_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString();
          if (status >= 400) {
            reject(new Error(`Gemini HTTP ${status}: ${text.slice(0, 300)}`));
            return;
          }
          try {
            const data = JSON.parse(text);
            const candidate = data.candidates?.[0];
            const content =
              candidate?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
            const usage = data.usageMetadata;
            resolve({
              content,
              promptTokens: usage?.promptTokenCount,
              completionTokens: usage?.candidatesTokenCount,
            });
          } catch (e) {
            reject(new Error(`Invalid Gemini response: ${String(e)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Gemini request timed out"));
    });
    req.write(body);
    req.end();
  });
}

function classifyFailure(error: string): FailureMode {
  const lower = error.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "timeout";
  }
  if (lower.includes("econnrefused") || lower.includes("cannot reach")) {
    return "connection_error";
  }
  if (lower.includes("parse") || lower.includes("invalid")) {
    return "parse_error";
  }
  if (lower.includes("http 5") || lower.includes("server error")) {
    return "server_error";
  }
  return "connection_error";
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export async function runBenchmark(
  tasks: BenchmarkTask[],
  config: BenchmarkConfig,
  hardware: HardwareInfo,
  progress?: (msg: string) => void,
): Promise<BenchmarkResult> {
  const results: TaskResult[] = [];
  const startTime = Date.now();
  const log = progress ?? console.log;

  const ollamaOptions = {
    num_ctx: config.contextLength,
    num_gpu: config.gpuLayers,
    num_batch: config.batchSize,
  };

  const llamaCppOptions = {
    num_ctx: config.contextLength,
  };

  const isGemini = config.backend === "gemini";
  const isLlamaCpp = config.backend === "llama-cpp";
  const chatUrl = isLlamaCpp ? config.llamaCppUrl : config.ollamaUrl;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const taskNum = `[${i + 1}/${tasks.length}]`;

    log(`\n${taskNum} ${task.name} (${task.difficulty})`);

    const prompt = config.mock && task.mock?.prompt ? task.mock.prompt : task.prompt;
    const taskStart = Date.now();
    let output = "";
    let tokensPerSecond: number | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let error: string | undefined;
    let failureMode: FailureMode = "none";

    try {
      let response: ChatResponse;
      if (isGemini) {
        response = await geminiChat(
          config.geminiApiKey!,
          config.geminiModel ?? config.model,
          prompt,
          task.system,
        );
      } else if (isLlamaCpp) {
        response = await llamaCppChat(chatUrl, prompt, task.system, llamaCppOptions);
      } else {
        response = await ollamaChat(chatUrl, config.model, prompt, task.system, ollamaOptions);
      }
      output = response.content;
      promptTokens = response.promptTokens;
      completionTokens = response.completionTokens;

      if (response.evalCount && response.evalDurationNs) {
        tokensPerSecond = response.evalCount / (response.evalDurationNs / 1_000_000_000);
      } else if (response.completionTokens) {
        // For llama.cpp, compute tok/s from wall time
        const elapsedSec = (Date.now() - taskStart) / 1000;
        if (elapsedSec > 0) {
          tokensPerSecond = response.completionTokens / elapsedSec;
        }
      }

      if (!output || output.trim().length === 0) {
        failureMode = "empty_response";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      failureMode = classifyFailure(error);
      log(`  ERROR: ${error}`);
    }

    const elapsedMs = Date.now() - taskStart;

    // Score the output.
    let score: TaskScore;
    if (config.mock) {
      score = scoreDeterministic(output, task);
    } else if (error) {
      score = {
        taskId: task.id,
        score: 0,
        maxScore: task.grading.maxScore,
        percentage: 0,
        method: "deterministic",
        details: `Error: ${error}`,
        passed: false,
      };
    } else {
      // LLM judge mode: ask the same model to grade the output.
      try {
        const judgePrompt = buildJudgePrompt(task, output);
        const judgeSystem = "You are a strict but fair evaluator. Score the response accurately.";
        let judgeContent: string;
        if (isGemini) {
          const judgeResponse = await geminiChat(
            config.geminiApiKey!,
            config.geminiModel ?? config.model,
            judgePrompt,
            judgeSystem,
          );
          judgeContent = judgeResponse.content;
        } else if (isLlamaCpp) {
          const judgeResponse = await llamaCppChat(
            chatUrl,
            judgePrompt,
            judgeSystem,
            llamaCppOptions,
          );
          judgeContent = judgeResponse.content;
        } else {
          const judgeResponse = await ollamaChat(
            config.ollamaUrl,
            config.model,
            judgePrompt,
            judgeSystem,
            ollamaOptions,
          );
          judgeContent = judgeResponse.content;
        }
        score = parseJudgeResponse(judgeContent, task.grading.maxScore);
        score.taskId = task.id;
      } catch {
        // Fall back to deterministic if judge fails.
        score = scoreDeterministic(output, task);
      }
    }

    const tpsStr = tokensPerSecond ? ` (${tokensPerSecond.toFixed(1)} tok/s)` : "";
    const statusIcon = score.passed ? "PASS" : "FAIL";
    log(
      `  ${statusIcon} ${score.score}/${score.maxScore} (${score.percentage}%)${tpsStr} [${(elapsedMs / 1000).toFixed(1)}s]`,
    );

    results.push({
      task,
      output,
      score,
      elapsedMs,
      tokensPerSecond,
      promptTokens,
      completionTokens,
      failureMode,
      error,
    });
  }

  const totalTimeMs = Date.now() - startTime;
  const totalScore = results.reduce((s, r) => s + r.score.score, 0);
  const maxScore = results.reduce((s, r) => s + r.score.maxScore, 0);
  const tpsValues = results.map((r) => r.tokensPerSecond).filter((v): v is number => v != null);
  const avgTps =
    tpsValues.length > 0 ? tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length : undefined;
  const medianTps = tpsValues.length > 0 ? percentile(tpsValues, 50) : undefined;
  const latencies = results.map((r) => r.elapsedMs);
  const p50Latency = latencies.length > 0 ? percentile(latencies, 50) : undefined;
  const p95Latency = latencies.length > 0 ? percentile(latencies, 95) : undefined;

  const totalPromptTokens = results.reduce((s, r) => s + (r.promptTokens ?? 0), 0);
  const totalCompletionTokens = results.reduce((s, r) => s + (r.completionTokens ?? 0), 0);

  const failureModes: Record<string, number> = {};
  for (const r of results) {
    failureModes[r.failureMode] = (failureModes[r.failureMode] ?? 0) + 1;
  }

  const passedCount = results.filter((r) => r.score.passed).length;
  const failedCount = results.filter((r) => !r.score.passed).length;
  const totalTasks = passedCount + failedCount;

  return {
    config,
    hardware,
    tasks: results,
    summary: {
      totalScore: Math.round(totalScore * 10) / 10,
      maxScore,
      percentage: maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0,
      totalTimeMs,
      avgTokensPerSecond: avgTps ? Math.round(avgTps * 10) / 10 : undefined,
      medianTokensPerSecond: medianTps ? Math.round(medianTps * 10) / 10 : undefined,
      p50LatencyMs: p50Latency ? Math.round(p50Latency) : undefined,
      p95LatencyMs: p95Latency ? Math.round(p95Latency) : undefined,
      passedCount,
      failedCount,
      passRate: totalTasks > 0 ? Math.round((passedCount / totalTasks) * 1000) / 10 : 0,
      totalPromptTokens,
      totalCompletionTokens,
      failureModes,
    },
    timestamp: new Date().toISOString(),
  };
}
