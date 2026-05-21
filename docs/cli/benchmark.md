---
summary: "CLI reference for `openclaw benchmark` (run benchmark suites, Docker sandbox with custom files)"
read_when:
  - Running benchmarks against a local Gemma model
  - Evaluating model quality with scoring tasks
  - Using Docker sandbox mode for benchmarking and security analysis
  - Passing a custom file to an isolated Docker container for evaluation
title: "benchmark"
---

# `openclaw benchmark`

Run the Gemmaclaw benchmark suite against a local Ollama model. Supports
Docker-isolated execution (default), direct host execution, and a persistent
sandbox mode for iterating on custom files.

Related:

- Models: [Models CLI](/cli/models)
- Sandbox: [Sandbox CLI](/cli/sandbox)
- Security: [Security CLI](/cli/security)

## Examples

```bash
openclaw benchmark
openclaw benchmark --local
openclaw benchmark --mock
openclaw benchmark --model gemma3:4b --filter coding
openclaw benchmark --context-length 8192
openclaw benchmark sandbox --file tasks.json
openclaw benchmark sandbox --file audit.txt --model gemma3:4b --gemini-api-key "$GEMINI_KEY"
```

Gemmaclaw agent benchmark suites can also be run through the package script:

```bash
pnpm benchmark agent list --suite variants --sample-per-template 2 --sample-seed gemini-flash-smoke-20260513
pnpm benchmark agent --suite variants --sample-per-template 2 --sample-seed gemini-flash-smoke-20260513 --backend google-gemini-cli --model gemini-3-flash-preview --run-id variants-gemini-flash-sample --idle-timeout 10 --no-activity-timeout 120 --hard-cap 600
```

Use the 2-per-template sample before a full variation sweep. It runs 1,470
tasks, 2 sampled cases from each of the 147 generated templates, while still
covering the whole template catalog.

The default agent suite also includes regression tasks for real production
agent failures. `scheduled_media_delivery_verification` covers recurring media
jobs that must schedule against an active scheduler, maintain durable dedupe
history, generate a non-empty audio artifact, and prove the immediate Telegram
send with a receipt. It explicitly fails agents that write an inert
`workspace/.openclaw/cron/jobs.json` shadow file or claim delivery before
read-back verification.

The related default setup enhancement is documented at
[Gemmaclaw enhancements](/gemmaclaw/enhancements).

```bash
pnpm benchmark agent --backend openai-codex --model gpt-5.5 --thinking medium --task scheduled_media_delivery_verification --run-id scheduled-media-raw
pnpm benchmark agent --backend openai-codex --model gpt-5.5 --thinking medium --task scheduled_media_delivery_verification --run-id scheduled-media-enhanced --gemmaclaw-enhancements default
pnpm benchmark agent --backend openai-codex --model gpt-5.5 --thinking medium --task scheduled_media_delivery_verification --run-id scheduled-media-no-enhance --gemmaclaw-enhancements none
```

Benchmarks default to the raw baseline with no optional Gemmaclaw enhancements.
Use `--gemmaclaw-enhancements default` for the normal Gemmaclaw prompt layer,
`--gemmaclaw-enhancements none` to make the raw baseline explicit, or a
comma-separated enhancement id list when isolating one improvement. Record the
selection in result notes and PRs so scorecards do not mix enhanced and
unenhanced runs.

## Modes

### Docker mode (default)

Builds a self-contained Docker image with Ollama, pulls the model, runs the
full benchmark suite, and writes results to the host via a volume mount. The
container is removed after the run.

```bash
openclaw benchmark --model gemma3:1b
```

### Local mode

Runs directly on the host. Requires Ollama to be running with the target model
already pulled.

```bash
openclaw benchmark --local --model gemma3:4b
```

### Mock mode

Deterministic scoring against expected outputs. No LLM judge needed, suitable
for CI.

```bash
openclaw benchmark --mock
```

## Options

| Flag                   | Description                                                       |
| ---------------------- | ----------------------------------------------------------------- |
| `--mock`               | Deterministic scoring only (no LLM judge, fast CI mode)           |
| `--local`              | Run directly on the host instead of inside Docker                 |
| `--model <model>`      | Ollama model name (default: from config or `gemma3:4b`)           |
| `--ollama-url <url>`   | Ollama API URL (default: `http://127.0.0.1:11434`)                |
| `--filter <text>`      | Run only tasks matching text (id, category, difficulty, name)     |
| `--output-dir <dir>`   | Output directory for results (default: `./results/<model>__<ts>`) |
| `--context-length <n>` | Context window size (`num_ctx`)                                   |
| `--gpu-layers <n>`     | Number of GPU layers (`num_gpu`)                                  |
| `--batch-size <n>`     | Batch size (`num_batch`)                                          |

## Agent variation sampling

The `variants` suite expands each Gemmaclaw-owned benchmark template into 200
controlled cases. A full run is 29,400 tasks. For harness validation, use a
deterministic sample before spending model quota on the full suite:

```bash
pnpm benchmark agent list --suite variants --sample-per-template 2 --sample-seed gemini-flash-smoke-20260513
pnpm benchmark agent --suite variants --sample-per-template 2 --sample-seed gemini-flash-smoke-20260513 --backend google-gemini-cli --model gemini-3-flash-preview --run-id variants-gemini-flash-sample --idle-timeout 10 --no-activity-timeout 120 --hard-cap 600
```

`--sample-per-template` selects the same number of generated variations from
each template. `--sample-seed` makes the selection stable, so failed sampled
tasks can be reproduced, rerun, and compared across backends.

## Subcommands

### `openclaw benchmark sandbox`

Run a benchmark inside a **persistent** Docker container with a custom file.
The container stays around after execution so you can swap the file in and
rerun without rebuilding.

This is useful for benchmarking and security analysis workflows where you want
to iterate on the input file quickly.

```bash
openclaw benchmark sandbox --file tasks.json
```

#### How it works

1. Builds the benchmark Docker image (cached after first build).
2. Creates a persistent container (not `--rm`).
3. Copies your file into the container at `/workspace/<filename>`.
4. Starts the container, which boots Ollama, pulls the model, and reads the file.
5. Prints the container ID when done.

After the run you can iterate without rebuilding:

```bash
docker cp updated-tasks.json <container-id>:/workspace/tasks.json
docker start -a <container-id>
```

Or inspect the container directly:

```bash
docker exec -it <container-id> bash
```

Or pull results back to the host:

```bash
docker cp <container-id>:/results ./results
```

Clean up when done:

```bash
docker rm <container-id>
```

#### Sandbox options

| Flag                     | Description                                                      |
| ------------------------ | ---------------------------------------------------------------- |
| `--file <path>`          | **(required)** Path to the file to include in the container      |
| `--model <model>`        | Ollama model name (default: `gemma3:1b`)                         |
| `--mock`                 | Deterministic scoring only (no LLM judge)                        |
| `--keep`                 | Keep container running after the benchmark finishes (for `exec`) |
| `--gemini-api-key <key>` | Gemini API key for cloud-based evaluation                        |
| `--gemini-model <model>` | Gemini model to use (default: `gemini-2.5-pro`)                  |

When `--gemini-api-key` is provided, the evaluation can use Gemini for
cloud-based judging instead of (or alongside) the local Ollama model.

## Task categories

The built-in benchmark suite covers five categories:

| Category                | What it tests                               |
| ----------------------- | ------------------------------------------- |
| `instruction_following` | Ability to follow formatting and rules      |
| `reasoning`             | Arithmetic, logic puzzles, pattern matching |
| `extraction`            | Pulling structured data from text           |
| `safety`                | Refusing harmful requests, prompt injection |
| `coding`                | FizzBuzz, bug finding, optimization         |

Filter by category:

```bash
openclaw benchmark --filter safety
openclaw benchmark --filter coding --mock
```

## Output

Results are written to the output directory in three formats:

- **JSON** - full structured results for programmatic use
- **Markdown** - human-readable summary
- **HTML** - interactive dashboard

The summary printed to the terminal includes total score, pass rate, average
tokens per second, and file paths for each output format.

## Qwen 3.6 local Jake provenance

This section documents the local Jake/Pi Qwen 3.6 runner that was brought
into the Gemmaclaw benchmark system as model presets and a manifest
validator. It is purely historical provenance for a workflow that
predates Gemmaclaw and is **not** the Qwen team's QwenClawBench. The
upstream QwenClawBench is covered in the next section.

The port is defined in `src/gemmaclaw/benchmark/qwen36-jake-models.ts`
and `src/gemmaclaw/benchmark/jake-manifest-validator.ts`.

### Provenance

The original workflow ran on a Raspberry Pi 5 via a local OpenClaw gateway,
with Ollama serving models on a workstation GPU. The two canonical model
targets were:

| Jake / Ollama model ID   | Role  | Status  |
| ------------------------ | ----- | ------- |
| `qwen3.6:35b`            | Dense | Blocked |
| `qwen3.6:35b-a3b-q4_K_M` | MoE   | Ready   |

**Dense blocker:** The unsloth GGUF for the dense model has empty tensor names
and crashes on llama.cpp b9190. The froggeric GGUF resolves this, but its
throughput (63-65 tok/s) is not competitive with the MoE (133-135 tok/s) at
comparable VRAM. Use the froggeric GGUF only as a smoke target.

### Running the MoE target

The Qwen 3.6 MoE model (`Qwen3.6-35B-A3B-UD-IQ4_XS.gguf`) is the primary
benchmark target. Serve it with a local llama.cpp instance and run via the
Gemmaclaw benchmark CLI:

```bash
# Serve the model (llama.cpp on a workstation GPU)
llama-server \
  -m /path/to/Qwen3.6-35B-A3B-UD-IQ4_XS.gguf \
  --alias qwen3.6-35b-a3b \
  --host 0.0.0.0 --port 8080 \
  --n-gpu-layers 99 --ctx-size 65536 --parallel 1 \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --flash-attn on --threads 8 --jinja --no-webui

# Run the benchmark (from gemmaclaw repo)
pnpm benchmark agent \
  --backend llama-cpp \
  --llama-cpp-url http://gateway-host:8080 \
  --model qwen3.6-35b-a3b \
  --quant IQ4_XS \
  --thinking high \
  --run-id qwen36-jake-moe-high
```

### Running the dense target (smoke only)

Use the froggeric GGUF as a smaller smoke target:

```bash
pnpm benchmark agent \
  --backend llama-cpp \
  --llama-cpp-url http://gateway-host:8080 \
  --model qwen3.6-27b-dense \
  --quant Q4_K_M \
  --thinking high \
  --run-id qwen36-jake-dense-smoke
```

### Container isolation and credentials

All real benchmark agent runs must execute inside the Gemmaclaw Docker
container (`Dockerfile.benchmark`) with `GEMMACLAW_BENCHMARK_CONTAINER=1`
and the fake-gog shim active. Do not run publishable benchmarks in host mode.

This benchmark does not use `OPENAI_API_KEY`. The llama.cpp backend uses a
dummy auth token. Any semantic judging must go through an OAuth-backed
path (CC ACP or Claude Code), not a raw API key.

### Validating historical Jake run manifests

Use `validateJakeManifest` from `jake-manifest-validator.ts` to check
whether a historical Jake run meets the original completion criteria:

```typescript
import { validateJakeManifest } from "./src/gemmaclaw/benchmark/jake-manifest-validator.js";

const result = validateJakeManifest(manifest);
if (result.valid) {
  // manifest.finished is non-empty and tasks_run >= 22
} else {
  console.error(result.reason);
}
```

A run is complete when `manifest.finished` is non-empty and `manifest.tasks_run >= 22`.

## Upstream QwenClawBench (Qwen team, release-blocked)

The Qwen team's **QwenClawBench** is a separate benchmark that has **not yet
been open-sourced**. It is referenced in the official Qwen3.6 Hugging Face
model cards as:

> _QwenClawBench: An internal real-user-distribution Claw agent benchmark
> (open-sourcing soon); temp=0.6, 256K ctx._

Sources verified 2026-05-21:

- [github.com/QwenLM/Qwen3.6](https://github.com/QwenLM/Qwen3.6) (no
  QwenClawBench mention; no public dataset/repo)
- [huggingface.co/Qwen/Qwen3.6-35B-A3B](https://huggingface.co/Qwen/Qwen3.6-35B-A3B)
  (results table + footnote)
- [huggingface.co/Qwen/Qwen3.6-35B-A3B-FP8](https://huggingface.co/Qwen/Qwen3.6-35B-A3B-FP8)
  (same footnote)

Gemmaclaw must not publish a benchmark under the QwenClawBench name until
the Qwen team releases the official artifact. The release tracker lives in
`src/gemmaclaw/benchmark/qwenclaw-bench-upstream.ts`:

- `QWENCLAW_BENCH_UPSTREAM_STATUS` records the current release state.
- `QWENCLAW_BENCH_UPSTREAM_RUN_SETTINGS` carries the upstream-documented
  run settings (temperature 0.6, context length 256K).
- `assessQwenClawBenchRelease()` is a pure helper a watcher can call with
  fetched upstream text to detect when the "open-sourcing soon" language
  changes.
- `ensureQwenClawBenchImportAllowed()` throws while the status is still
  internal; use it as a guard in any code path that wants to expose a
  QwenClawBench-named artifact.
- `QWENCLAW_BENCH_RELEASE_CHECKLIST` lists the manual steps a future
  Gemmaclaw adapter must follow once the upstream artifact ships.

When Qwen releases QwenClawBench:

1. Confirm the public artifact lives under a Qwen-team-owned namespace
   (`github.com/QwenLM`, `huggingface.co/Qwen`, or an officially linked
   Qwen blog).
2. Update `QWENCLAW_BENCH_UPSTREAM_STATUS` to `released` and set
   `publicArtifactUrl`.
3. Implement the Gemmaclaw adapter behind the same container/credential
   guardrails listed above (no `OPENAI_API_KEY`, container-only,
   OAuth-backed judging).
4. Add an end-to-end smoke before any publishable run.
