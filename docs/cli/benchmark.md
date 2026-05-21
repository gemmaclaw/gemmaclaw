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
pnpm benchmark agent --backend openai-codex --model gpt-5.5 --thinking medium --task scheduled_media_delivery_verification --run-id scheduled-media-smoke
pnpm benchmark agent --backend openai-codex --model gpt-5.5 --thinking medium --task scheduled_media_delivery_verification --run-id scheduled-media-no-enhance --gemmaclaw-enhancements none
```

Use `--gemmaclaw-enhancements default` for the normal Gemmaclaw prompt layer,
`--gemmaclaw-enhancements none` to reproduce behavior without optional
enhancements, or a comma-separated enhancement id list when isolating one
improvement.

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

## QwenClaw 3.6 benchmark port

The QwenClaw 3.6 benchmark port brings the original Jake / Pi benchmark
workflow for Qwen 3.6 into the Gemmaclaw benchmark system. The port is
defined in `src/gemmaclaw/benchmark/qwenclaw-models.ts` and
`src/gemmaclaw/benchmark/jake-manifest-validator.ts`.

### Provenance

The original workflow ran on the Raspberry Pi 5 (frankpi) via the Jake
OpenClaw gateway, with Ollama serving models on the Desktop PC RTX 3090. The
two canonical model targets were:

| Jake / Ollama model ID   | Role  | Status  |
| ------------------------ | ----- | ------- |
| `qwen3.6:35b`            | Dense | Blocked |
| `qwen3.6:35b-a3b-q4_K_M` | MoE   | Ready   |

**Dense blocker:** The unsloth GGUF for the dense model has empty tensor names
and crashes on llama.cpp b9190. The froggeric GGUF resolves this, but its
throughput (63-65 tok/s) is not competitive with the MoE (133-135 tok/s) at
comparable VRAM. Use the froggeric GGUF only as a smoke target. See
`knowledge/infra/gemmaclaw-benchmark-backends.md` for details.

### Running the MoE target

The Qwen 3.6 MoE model (`Qwen3.6-35B-A3B-UD-IQ4_XS.gguf`) is the primary
benchmark target. Serve it with the Desktop llama.cpp instance and run via
the Gemmaclaw benchmark CLI:

```bash
# Serve the model (llama.cpp on Desktop RTX 3090)
llama-server \
  -m /home/frank/models/gguf/qwen3.6-hf/Qwen3.6-35B-A3B-UD-IQ4_XS.gguf \
  --alias qwen3.6-35b-a3b \
  --host 0.0.0.0 --port 8080 \
  --n-gpu-layers 99 --ctx-size 65536 --parallel 1 \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --flash-attn on --threads 8 --jinja --no-webui

# Run the benchmark (from gemmaclaw repo)
pnpm benchmark agent \
  --backend llama-cpp \
  --llama-cpp-url http://100.69.102.71:8080 \
  --model qwen3.6-35b-a3b \
  --quant IQ4_XS \
  --thinking high \
  --run-id qwenclaw-36-moe-high
```

### Running the dense target (smoke only)

Use the froggeric GGUF as a smaller smoke target:

```bash
pnpm benchmark agent \
  --backend llama-cpp \
  --llama-cpp-url http://100.69.102.71:8080 \
  --model qwen3.6-27b-dense \
  --quant Q4_K_M \
  --thinking high \
  --run-id qwenclaw-36-dense-smoke
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
whether a historical Pi run meets the original completion criteria:

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
