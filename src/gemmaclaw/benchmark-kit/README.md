# Benchmark Kit

Shared benchmark harness for evaluating local LLMs. Used by [gemmaclaw](https://github.com/gemmaclaw/gemmaclaw) and [jake-benchmark](https://github.com/frankhli843/jake-benchmark).

## Task Packs

Benchmarks are organized into task packs, each a JSON file with a set of evaluation tasks:

- **`core.json`**: Tool-free model quality tasks (instruction following, reasoning, data extraction, safety, coding). Tests raw model capability by sending prompts directly to Ollama and scoring the output.
- **`jake-agent.json`** (planned): Agent capability tasks (email, calendar, browser automation, error recovery, phishing detection). Tests tool-calling and multi-step planning through an OpenClaw gateway.

Each task includes an id, prompt, grading criteria, difficulty, and optional `tags` for filtering. Tasks tagged `"quick"` are included in the fast benchmark mode.

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
# Full benchmark (all tasks, LLM judge scoring)
gemmaclaw benchmark

# Deterministic scoring only (fast, no judge needed)
gemmaclaw benchmark --mock

# Quick mode: tagged subset, under 10 minutes
gemmaclaw benchmark --quick

# Sweep: test a matrix of models x context x thinking level
gemmaclaw benchmark --sweep --models gemma3:4b,gemma3:12b

# Upload results to the community dataset (opens a PR)
gemmaclaw benchmark --upload --upload-repo gemmaclaw/gemmaclaw
```

### Quick Mode

Runs only tasks tagged `"quick"` (7 of 15 core tasks). Produces the same output formats as a full run. Useful for smoke-testing a new model or configuration before committing to a full benchmark.

### Sweep Mode

Iterates over a config matrix (models x context windows x thinking levels). Each combination runs the full task pack. Results are saved incrementally to a `sweep-state.json` file, so a sweep can be interrupted and resumed. When complete, the sweep emits:

- Per-config result files (`results.json` in each subdirectory)
- A `sweep-summary.md` with a comparison table
- A `recommended.json` with the auto-selected best configuration

### Upload

After a run completes, `--upload` strips private identifiers (hostnames, usernames, IPs, file paths, model output text), converts the result to the standardized schema, and opens a PR against the target repo's community benchmarks folder via `gh` CLI.

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

## Architecture

For the full design document covering module boundaries, consumer integration, task pack format, and migration plan, see [benchmark-kit-design.md](../../docs/benchmark-kit-design.md).
