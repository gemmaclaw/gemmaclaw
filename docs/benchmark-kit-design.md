# Benchmark Kit: Unified Harness Design

## Problem

Two benchmark systems exist today with overlapping infrastructure but fundamentally different task types:

1. **Legacy local-agent benchmark**: Tests _agent capability_ (tool-calling, multi-step planning, error recovery) via 22 tasks dispatched through an OpenClaw gateway. Bash/Python harness, Adventure Time theme, LLM-graded.
2. **Gemmaclaw Benchmark** (`gemmaclaw/src/gemmaclaw/benchmark/`): Tests _raw model quality_ (instruction following, reasoning, extraction, safety, coding) via 15 pure-completion tasks sent directly to Ollama. TypeScript harness, deterministic + LLM-judge scoring.

These share concepts (task definitions, scoring, hardware detection, result output) but were built independently. The goal is a shared **benchmark-kit** that both consume, eliminating duplicated docs/rules while keeping each system's unique task packs.

## Module Boundaries

```
benchmark-kit/                    (new: shared package in gemmaclaw repo)
  tasks/
    core.json                     (tool-free tasks: instruction, reasoning, extraction, safety, coding)
    agent-fixtures.json               (OpenClaw local agent-specific: email, calendar, browser, error recovery, phishing)
  schema/
    result.schema.json            (JSON Schema for benchmark results)
    config-selection.md           (algorithm doc for auto-selecting best config)
  runner/
    ollama-runner.ts              (direct Ollama chat, used by gemmaclaw benchmark)
    dispatch-runner.ts            (OpenClaw gateway dispatch, used by local agent benchmark)
    common.ts                     (shared types, progress reporting, keepalive, timeout logic)
  scorer/
    deterministic.ts              (exact match, contains-all, JSON structure, keyword overlap)
    llm-judge.ts                  (build judge prompt, parse judge response)
  results/
    json-writer.ts                (machine-readable JSON output)
    markdown-writer.ts            (human-readable summary)
    html-dashboard.ts             (browser dashboard)
  cli/
    quick.ts                      (5-10 min subset: 5-8 representative tasks)
    sweep.ts                      (full matrix: model x quant x context, resumable, overnight)
    upload.ts                     (opt-in anonymized PR submission)
  hardware/
    detect.ts                     (GPU/CPU/RAM detection, reused from gemmaclaw provision)
```

## Task Pack Format

Each task pack is a JSON file with this structure:

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
      "system": "optional system message",
      "grading": {
        "type": "exact_match | contains_all | json_structure | output_quality",
        "expected": ["..."],
        "requiredKeys": ["..."],
        "criteria": ["..."],
        "maxScore": 5
      },
      "mock": {
        "expectedOutput": "...",
        "fuzzyMatches": ["..."]
      },
      "tags": ["quick"]
    }
  ]
}
```

Key additions vs current:

- `tags`: array for filtering. `"quick"` marks tasks included in the quick benchmark.
- `pack` and `version` fields at the top level for identification.
- OpenClaw local-agent tasks add a `"runner": "dispatch"` field (default is `"ollama"` for direct inference).

## How Each Consumer Uses It

### Gemmaclaw (`gemmaclaw benchmark` CLI)

Current flow preserved, but tasks and scoring imported from benchmark-kit:

1. Reads `core.json` task pack (all 15 current tasks migrate here).
2. Uses `ollama-runner.ts` for inference.
3. Uses `deterministic.ts` / `llm-judge.ts` for scoring.
4. Uses `results/` writers for output.
5. Hardware detection from `hardware/detect.ts`.
6. Quick mode: filters to `tags: ["quick"]`.

### OpenClaw local agent Benchmark (`run-model-benchmark.sh`)

Current bash orchestration preserved (SSH to Pi, config swap, gateway restart), but task definitions and result format standardized:

1. Reads `agent-fixtures.json` task pack (all 22 current tasks migrate here).
2. Uses `dispatch-runner.ts` for OpenClaw gateway dispatch.
3. Result collection unchanged (artifacts, gog-state, memory files).
4. Post-run: emits standardized `result.schema.json` alongside existing per-task artifacts.
5. Quick mode: filters to `tags: ["quick"]` for a 5-task sanity check.

### GemmaHermes (fork of gemmaclaw)

Inherits from gemmaclaw via git upstream merge. No additional benchmark code needed, the `gemmaclaw benchmark` command works as-is since it's a rebrand.

## Migration Plan

### Phase 1: Extract shared code (this PR)

1. Create `src/gemmaclaw/benchmark-kit/` directory in gemmaclaw repo.
2. Move `tasks.ts` definitions into `tasks/core.json` (JSON, not TS, so OpenClaw local agent can consume without a TS build).
3. Move `scorer.ts` into `scorer/deterministic.ts` + `scorer/llm-judge.ts`.
4. Move `results.ts` into `results/` module.
5. Move hardware detection (already in `provision/hardware.ts`) ref into `hardware/detect.ts`.
6. Update `src/gemmaclaw/benchmark/` to import from benchmark-kit.
7. Update `src/commands/benchmark-gemma.ts` to use new paths.
8. All existing tests must pass.

### Phase 2: Standardize OpenClaw local agent Benchmark

1. Add `tasks/agent-fixtures.json` to benchmark-kit with all 22 OpenClaw local agent tasks (converted from `harness/tasks.json`).
2. OpenClaw local agent's `run-benchmark.sh` reads from the shared JSON instead of its local copy.
3. Add result schema validation to OpenClaw local agent's `validate-run.sh`.
4. OpenClaw local agent Benchmark README points to benchmark-kit docs for task format and scoring.

### Phase 3: Add CLI commands (quick, sweep, upload)

1. `gemmaclaw benchmark --quick`: runs tagged subset in under 10 minutes.
2. `gemmaclaw benchmark --sweep`: iterates over a config matrix (model x quant x context), resumable via state file.
3. `gemmaclaw benchmark --upload`: sanitizes results and opens a PR to the gemmaclaw/gemmaclaw dataset folder.

### Phase 4: Remove duplicate docs

1. OpenClaw local agent Benchmark `harness/README.md` references benchmark-kit for task format and scoring methodology.
2. GemmaHermes `benchmark/README.md` replaced with a one-liner pointing to gemmaclaw benchmark-kit docs.
3. Single source of truth for "how benchmarking works" lives in `docs/benchmark-kit-design.md` and the benchmark-kit README.

## What Does NOT Change

- Legacy local-agent bash orchestration (SSH, config swap, gateway restart, artifact collection) stays in the private benchmark runner repo.
- Legacy local-agent dispatch through the OpenClaw gateway stays in the private benchmark runner.
- Gemmaclaw's CLI entry point (`gemmaclaw benchmark`) stays as the primary interface.
- Hardware detection implementation stays in `provision/hardware.ts`, benchmark-kit re-exports it.
- Adventure Time theming for OpenClaw local agent tasks stays in agent-fixtures.json.
- Gemmaclaw's Dockerfile.benchmark stays for CI.

## Open Questions

1. **Package or directory?** Start as a directory in gemmaclaw (`src/gemmaclaw/benchmark-kit/`). If OpenClaw local agent needs it as a standalone npm package later, extract then.
2. **OpenClaw local agent dispatch in TS or keep Python?** Keep the legacy runner for now. The TS `dispatch-runner.ts` is a future option.
3. **Shared task IDs across packs?** Each pack has its own namespace (`core:list_reverse`, `agent-fixtures:email_summarize`). No collision.
