# Public Gemmaclaw Benchmark Inventory — Judge & Speed Sources (2026-06-04)

Task: t_01KT92RYTY9S4B0XQN4DHETDC2. Worktree: `code/gemmaclaw-rejudge-tps-20260604`
(branch `fix/rejudge-acp-tps-20260604`, based on `origin/main` @ 4f3d7de0d4).

Allowlist source: `scripts/site/generate-site.py` `PUBLIC_BENCHMARK_RUNS` (5 runs).
Method: inspected per-task evaluation JSON `llmJudge`/`judgeProvider` fields,
`runs/<id>/results.json` `tokensPerSecond`/`tokensPerSecondSource`, metadata,
commit messages, and `LLM_EVALUATION.md`. Not inferred from page text.

## Policy recap
- Authoritative judge MUST be a CC ACP agent (`provider: cc-acp`) reading the
  transcript directly. Allowed.
- `gemini-cli`, `openai`, `gemini`, `anthropic`, `ollama`, `qwen`, `openrouter`
  (any standalone model API/CLI evaluator) as authoritative judge = DISALLOWED.
- Speed: only measured llama.cpp/provider generation throughput is publishable.
  Output-est / full-task wall-clock fallback must be REMOVED, not relabelled.
  If no measured source exists → N/A / pending measurement.

## Run-by-run inventory

### 1. gemma4-31b-q4-high
- Artifacts: `benchmark-results/runs/gemma4-31b-q4-high/results.json` (47 tasks, 47 transcripts ✓);
  `benchmark-results/evaluations/gemma4-31b-q4-high/*.json` (47).
- Public score (authoritative sum): **88% (3007/3403)**.
- Judge source: **MIXED** — 24 `cc-acp/claude-sonnet-4-6` (✓ allowed), 21 `gemini-cli/gemini-3.1-pro-preview` (❌ DISALLOWED, authoritative=true), 1 unjudged.
- Speed value (published): **~1.2 tok/s output-est**.
- Speed source: `effective-output` on 47/47 tasks (full-task wall-clock; broken). No measured `generationTokensPerSecond` (None).
- Action: rejudge 21 gemini-cli tasks via CC ACP. Speed → N/A unless llama.cpp timing recovered.

### 2. gemma4-26b-q4-high
- Artifacts: `runs/gemma4-26b-q4-high/results.json` (47 tasks, 47 transcripts ✓); `evaluations/` (48 incl summary).
- Public score: **79% (2724/3438)**.
- Judge source: **MIXED** — 27 `cc-acp/claude-sonnet-4-6` (✓), 19 `gemini-cli/gemini-2.5-pro` (❌ DISALLOWED), 1 unjudged.
- Speed value: **~2.8–2.9 tok/s output-est**.
- Speed source: `estimated-output` on 16/47, null on 31. No measured gen TPS.
- Action: rejudge 19 gemini-cli tasks via CC ACP. Speed → N/A unless recovered.
- Note: a 26B-A4B llama-server is currently live on port 8080 (different process; do not touch).

### 3. gemma4-e4b-q4-high
- Artifacts: `runs/gemma4-e4b-q4-high/results.json` (47 tasks, 47 transcripts ✓); `evaluations/` (48).
- Public score: **~1% (15/2800)** — almost entirely unjudged or low.
- Judge source: **DISALLOWED + MISSING** — 19 `gemini-cli/gemini-3-flash-preview` (❌), 28 unjudged (no authoritative judge).
- Speed value: **~6.0 / 20.1 tok/s output-est**.
- Speed source: `effective-output` on 19/47, null on 28. No measured gen TPS.
- Action: rejudge 19 gemini-cli + judge 28 missing = 47 via CC ACP. Speed → N/A unless recovered.

### 4. functiongemma-270m-high
- Artifacts: `runs/functiongemma-270m-high/results.json` (2 tasks, 2 transcripts ✓); `evaluations/` (3).
- Public score: **0% (0/10)**.
- Judge source: **CLEAN** — 2 `cc-acp/claude-sonnet-4-6` (✓ allowed, via `judgeProvider`/`evaluationMode: authoritative-cc-acp`).
- Speed value: **20.1 tok/s output-est**.
- Speed source: `effective-output` on 1/2. No measured gen TPS.
- Action: judging already ACP-compliant. Speed → N/A unless recovered.

### 5. gemma4-12b-q4-nothink
- Artifacts: **NO repo `runs/` results.json**. Full run (with 50 transcripts) at durable root
  `/home/frank/gemmaclaw-benchmarks/gemma4-12b-20260604/runs/gemma4-12b-q4-nothink/results.json`.
  Repo has `benchmark-results/evaluations/gemma4-12b-q4-nothink/*.json` (51) + committed
  `site/benchmark-results/gemma4-12b-q4-nothink.html`.
- Public score: **~11% (454/4228)** (10% per commit 5f97a4df1d).
- Judge source: **DISALLOWED** — 49–50 `openai/gpt-4.1` (❌, authoritative=true, evalMode `publishable`). Commit explicitly states "Judge: GPT-4.1 via OpenAI API".
- Speed value: page page (separate); durable run uses `estimated-output` on 43/50.
- Speed source: `estimated-output`; commit msg claims "68 tok/s generation" but **NOT** in any structured `generationTokensPerSecond` field (metadata None). Needs llama-server log verification.
- Action: import durable `results.json` into repo runs/ (so page regenerates + transcripts available), then rejudge all 50 via CC ACP. Speed → N/A unless 68 tok/s confirmed from llama.cpp log.

## Totals
- CC ACP rejudgments needed: 31b 21 + 26b 19 + e4b 47 + 12b 50 = **137 task judgments**. functiongemma already clean.
- Disallowed authoritative judgments to replace/quarantine: 21 gemini-cli + 19 gemini-cli + 19 gemini-cli + ~49 openai/gpt-4.1 = **108**.
- Measured generation TPS available in structured artifacts: **0 runs**. All published speeds are output-est / effective-output (full-task wall-clock) and must be removed → N/A/pending unless llama.cpp timing is recovered per run.

## Generator speed mechanics (for the TPS fix)
- `normalize_agentic_benchmark_result` reads `tr["tokensPerSecond"]` + `tr["tokensPerSecondSource"]` from results.json (lines 155–161).
- `estimate_output_tokens_per_second` (line 407) is **dead code** (never called) — the output-est values are baked into the results.json artifacts by the harness, not computed in the generator.
- `format_speed` (line 436) renders `effective-output`/`estimated-output`/`mixed` with a " output-est" suffix; `measured` with none.
- Fix direction: generator must only surface `measured` generation TPS (from `generationTokensPerSecond` / llama.cpp log). Any non-measured source → "N/A" / "pending measurement", never a number.
