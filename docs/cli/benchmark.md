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
pnpm benchmark agent list --suite variants --sample-per-template 10 --sample-seed gemini-flash-smoke-20260513
pnpm benchmark agent --suite variants --sample-per-template 10 --sample-seed gemini-flash-smoke-20260513 --backend google-gemini-cli --model gemini-3-flash-preview --run-id variants-gemini-flash-sample --idle-timeout 10 --no-activity-timeout 120 --hard-cap 600
```

Use the 10-per-template sample before a full variation sweep. It runs 1,470
tasks, 10 sampled cases from each of the 147 generated templates, while still
covering the whole template catalog.

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
pnpm benchmark agent list --suite variants --sample-per-template 10 --sample-seed gemini-flash-smoke-20260513
pnpm benchmark agent --suite variants --sample-per-template 10 --sample-seed gemini-flash-smoke-20260513 --backend google-gemini-cli --model gemini-3-flash-preview --run-id variants-gemini-flash-sample --idle-timeout 10 --no-activity-timeout 120 --hard-cap 600
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
