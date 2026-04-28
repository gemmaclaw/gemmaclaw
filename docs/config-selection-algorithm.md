# Config Selection Algorithm

After a benchmark sweep completes, the CLI auto-selects the "best" configuration for the user's hardware. This document defines the deterministic selection rules.

## Input

A sweep produces an array of `BenchmarkResult` objects, one per (model, quant, contextWindow, thinkingLevel) combination. Each has:

- `summary.percentage` (quality score, 0-100)
- `summary.avgTokensPerSecond` (throughput)
- `summary.totalTimeMs` (wall-clock time)
- `summary.errorCount` (tasks that errored)
- `model.contextWindow` (effective context used)
- `config.thinkingLevel`

## Selection Rules (ordered by priority)

### 1. Eliminate broken configs

Discard any result where `errorCount > 0.25 * taskCount` (more than 25% of tasks errored). These are fundamentally non-functional.

### 2. Minimum quality gate

Discard any result where `percentage < 30`. Below this threshold the model is not usably competent.

### 3. Score the remaining candidates

Each surviving candidate gets a composite score:

```
composite = (quality_weight * quality_norm)
          + (speed_weight * speed_norm)
          + (context_bonus)
```

Where:

- `quality_norm` = `percentage / 100` (0 to 1)
- `speed_norm` = `min(avgTokensPerSecond / 30, 1.0)` (normalized to 30 tok/s ceiling)
- `context_bonus` = `0.05` if contextWindow >= 32768, else `0`

Default weights:

- `quality_weight` = 0.7
- `speed_weight` = 0.3

These weights reflect that quality matters more than raw speed for agent tasks, but speed matters enough to break ties.

### 4. Thinking level preference

Among candidates with composite scores within 2% of each other, prefer `thinkingLevel: "medium"` over `"high"` or `"off"`. Empirical data from Jake benchmarks shows medium thinking beats both high (over-thinks, times out) and off (misses multi-step reasoning).

### 5. Tie-break

If composite scores are identical: prefer higher context window, then lower quantization loss (Q8 > Q5 > Q4 > Q2), then alphabetical model name.

## Output

The algorithm produces a `RecommendedConfig` object:

```json
{
  "model": "gemma3:4b",
  "backend": "ollama",
  "quantization": "Q4_K_M",
  "contextWindow": 32768,
  "thinkingLevel": "medium",
  "compositeScore": 0.72,
  "qualityPct": 59.4,
  "tokPerSec": 22.3,
  "reasoning": "Best composite score (0.72). Quality 59.4% with 22.3 tok/s at 32k context."
}
```

This is displayed in the CLI summary and written to the sweep results directory as `recommended.json`.

## CLI Usage

```bash
# Run sweep (overnight, tests all configs)
gemmaclaw benchmark --sweep

# Quick benchmark (5-10 min, subset of tasks)
gemmaclaw benchmark --quick

# After sweep, view recommendation
cat benchmark-results/sweep-*/recommended.json
```

## Customization

Users can override weights via CLI flags:

- `--quality-weight 0.9 --speed-weight 0.1` (quality-obsessed)
- `--quality-weight 0.5 --speed-weight 0.5` (balanced)
- `--min-quality 50` (raise the quality gate)

## Implementation Notes

- The selection algorithm is a pure function: `selectBestConfig(results: BenchmarkResult[], opts?: SelectionOpts) => RecommendedConfig`.
- No network calls. No state. Fully deterministic given the same inputs.
- Unit-testable with synthetic BenchmarkResult arrays.
