# Benchmark Kit

Shared benchmark harness for evaluating local LLMs. Used by [gemmaclaw](https://github.com/gemmaclaw/gemmaclaw) and [jake-benchmark](https://github.com/frankhli843/jake-benchmark).

## Task Packs

Benchmarks are organized into task packs, each a JSON file with a set of evaluation tasks. Two families exist today (the v1 schema discriminates them by `family`):

- **`core.json`** (`family: "tool-free"`): Tool-free model quality tasks (instruction following, reasoning, data extraction, safety, coding). Tests raw model capability by sending prompts directly to Ollama and scoring the output. Loadable via `loadCoreTasks()` (legacy `BenchmarkTask[]`) or `loadBuiltinPack("core")` (typed `BenchmarkPack`).
- **`jake-agent.json`** (`family: "agent"`, 23 tasks): Agent capability tasks (email, calendar, browser automation, error recovery, phishing detection). The pack is vendored from [jake-benchmark](https://github.com/frankhli843/jake-benchmark) at v1, sanitized to public profile, and contains only fictional Adventure Time fixtures (BMO, Princess Bubblegum, Finn, Ice King). Loadable via `loadJakeAgentTasks()` or `loadBuiltinPack("jake-agent")`.

Each task includes an id, prompt, grading criteria, and (for tool-free packs) a difficulty plus optional `tags`. Tasks tagged `"quick"` are included in the fast benchmark mode.

### Task Pack Format

```json
{
  "pack": "core",
  "version": "1.0.0",
  "description": "Tool-free model quality tasks",
  "tasks": [
    {
      "id": "list_reverse",
      "name": "Reverse a List",
      "category": "instruction_following",
      "difficulty": "easy",
      "prompt": "...",
      "grading": {
        "type": "exact_match",
        "expected": ["5, 4, 3, 2, 1"],
        "maxScore": 5
      },
      "tags": ["quick"]
    }
  ]
}
```

Grading types: `exact_match`, `contains_all`, `json_structure`, `output_quality` (LLM judge).

## CLI

```bash
# Full benchmark of the built-in core (tool-free) pack against Ollama
gemmaclaw benchmark

# Deterministic scoring only (fast, no judge needed)
gemmaclaw benchmark --mock

# Inspect the agent pack without running it (no Ollama / OpenClaw required)
gemmaclaw benchmark --pack jake-agent --list-pack
gemmaclaw benchmark --pack jake-agent --validate-pack

# Run the Jake agent pack through Gemmaclaw's deterministic smoke runner
gemmaclaw benchmark --pack jake-agent --runner mock-agent

# Validate a custom pack file against the v1 schema
gemmaclaw benchmark --pack /path/to/my-pack.json --validate-pack
```

The `--pack` flag accepts either a built-in name (`core`, `jake-agent`) or a path to a pack JSON. `--list-pack` and `--validate-pack` are inspection-only modes that never touch Ollama, OpenClaw, or the network. They are safe to run in CI.

When running `--pack jake-agent` without a live runner, Gemmaclaw defaults to the built-in `mock-agent` runner. This is an actual runnable path through the Jake agent task pack: it loads the v1 agent pack, executes every task through the runner adapter seam, and writes `results.json`, `RESULTS.md`, and `index.html` under `./benchmark-results/<pack>__<runner>__<model>__<timestamp>/`. It is intended for smoke tests and CI portability. It does not claim to be a live OpenClaw/Jake quality score.

Tool-free packs other than the built-in `core` are recognized by the loader and v1 schema, but the gemmaclaw benchmark runner currently only executes the built-in `core` pack end-to-end. For arbitrary tool-free packs, use `loadBenchmarkPack(path)` from JS or invoke jake-benchmark's `jake-bench run` CLI.

### Sweep / Upload (legacy programmatic surface)

`runSweep` and `uploadResult` remain available as library functions:

- **Sweep**: iterate over a config matrix (models x context windows x thinking levels). Each combination runs the full task pack. Results are saved incrementally to `sweep-state.json`, so a sweep can be interrupted and resumed.
- **Upload**: strip private identifiers (hostnames, usernames, IPs, file paths, model output text), convert to the standardized schema, and open a PR via `gh` CLI.

These are not currently exposed as CLI flags; call them from a script.

### Pack Format (v1)

Newly authored packs declare:

```json
{
  "schemaVersion": "1",
  "pack": "demo-tool-free",
  "version": "1.0.0",
  "family": "tool-free",
  "tasks": [ ... ]
}
```

Two task families:

- `family: "tool-free"` — `grading.type` is one of `exact_match`, `contains_all`, `json_structure`, `output_quality`. Uses `maxScore` (camelCase) on grading.
- `family: "agent"` — `grading.type` is one of `output_check`, `command_check`, `artifact_check`, `file_check`, `multi_check`, `security_check`, `error_check`. Uses `max_score` (snake_case) and may carry pack-specific extension fields (`check_path`, `setup`, `fail_conditions`, `expected_files`, etc.). Validators do not reject unknown grading fields here.

The legacy benchmark-kit pack format (no `schemaVersion`, no `family`) is still accepted by `parseBenchmarkPack` and treated as `family: "tool-free"`. Authoring new packs without `family`/`schemaVersion` is discouraged.

### Agent Runner

`gemmaclaw benchmark --pack jake-agent --runner mock-agent` is the built-in deterministic smoke path and requires no private environment. `gemmaclaw benchmark --pack jake-agent --runner agent` requires a registered live agent runner. None ships in-tree because pack-specific orchestration (mock email/calendar fixtures, OpenClaw gateway lifecycle, sanitized transcripts, Pi/Tailscale paths) is not portable across packs and consumers.

Two paths for live agent execution:

1. **External binary**: register a runner once at startup via `registerAgentRunner(factory)`. The factory returns a `RunnerHandle` (see `runner-adapter.ts`). This is how a custom CLI bundle would wire OpenClaw or any other agent backend.
2. **jake-benchmark**: clone [jake-benchmark](https://github.com/frankhli843/jake-benchmark), follow `harness/README.md`, and run `jake-bench run --pack tasks-pack-v1.json --runner openclaw --spec ollama:<model> --baseline-config ... --baseline-home ...`. That path was hardened in PR #3 and PR #4 of jake-benchmark and produces v1 run artifacts with the same schema as gemmaclaw's loader expects.

Without a registered live runner, `--runner agent` exits with a clear "no agent runner registered" error and a pointer back to this section. `--runner mock-agent`, `--list-pack`, and `--validate-pack` always work without a live runner.

### Quick Mode

Runs only tasks tagged `"quick"` (7 of 15 core tasks). Produces the same output formats as a full run. Useful for smoke-testing a new model or configuration before committing to a full benchmark.

## Scoring

Two scoring methods, selectable per task:

**Deterministic** (`exact_match`, `contains_all`, `json_structure`): compares model output against expected values using string matching, keyword presence, or JSON key validation. Fast, reproducible, no external calls.

**LLM Judge** (`output_quality`): constructs a grading prompt with the task criteria and model output, sends it to a judge LLM, and parses the structured score and reasoning. More nuanced but slower and non-deterministic.

A full run uses LLM judge for all tasks. `--mock` mode uses deterministic scoring exclusively.

## Config Selection

After a sweep, the selection algorithm picks the best configuration:

1. Eliminate broken configs (>25% error rate)
2. Apply quality gate (minimum 30% score)
3. Compute composite score: `0.7 * quality + 0.3 * speed + context_bonus`
4. Within a 2% band of the top score, prefer `thinking=medium`
5. Tie-break by context window size, then quantization quality

Weights are customizable via `--quality-weight` and `--speed-weight` CLI flags.

Full algorithm specification: [config-selection-algorithm.md](../../docs/config-selection-algorithm.md)

## Result Schema

Results follow a standardized JSON schema covering hardware info, model metadata, configuration, per-task scores, and aggregate summary. Full schema: [benchmark-result-schema.json](../../docs/benchmark-result-schema.json)

## Privacy

The vendored `tasks/jake-agent.json` is run through the redaction audit on every test run. Adding any real internal hostname (`frank-pc`, `frankpi`, etc.), real email address, Tailscale IP, real phone number, home/root path, or known secret pattern to the vendored pack will fail the `redaction.test.ts` "vendored jake-agent.json has zero leak findings" test.

The redaction utilities (`sanitize`, `sanitizeObject`, `audit`, `auditPack`) are also useful for run artifacts and reports. Three profiles:

- `none` — pass through.
- `internal` — redact secrets only (API keys, OAuth tokens). Keep paths/IPs for debugging.
- `public` — also redact emails, IPs (incl. Tailscale CGNAT), internal hostnames, home paths, phone numbers.

Profiles are additive; `public` includes everything `internal` does. All rules are deterministic and idempotent: `sanitize(sanitize(x)) === sanitize(x)`. This mirrors `harness/lib/sanitize.py` in jake-benchmark so the two repos sanitize identically.

## Architecture

For the full design document covering module boundaries, consumer integration, task pack format, and migration plan, see [benchmark-kit-design.md](../../docs/benchmark-kit-design.md).
