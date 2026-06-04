#!/usr/bin/env python3
"""Publication guard for Gemmaclaw public benchmark judging + speed sources.

Policy (Frank, 2026-06-04):
  * Authoritative benchmark judgment must be produced by a CC ACP agent
    (provider == "cc-acp"). Direct OpenAI / Anthropic / Gemini / OpenRouter /
    local Ollama / Qwen / any standalone model-API or CLI evaluator must NEVER
    be the authoritative judge of a published run.
  * Published model speed must be MEASURED generation throughput
    (llama.cpp / provider timing). The output-est / full-task-wall-clock
    fallback must not be presented as model tok/s.

This guard reads the structured judge fields (provider / judgeProvider /
authoritative / evaluationMode) of every evaluation for every run in the
generator's PUBLIC_BENCHMARK_RUNS allowlist and FAILS LOUDLY (exit 1) when a
public run carries an authoritative judgment from a disallowed source. It is a
structured check, not free-text matching. Run it in the publication workflow
(check-site-quality.sh / deploy-site.yml).
"""
import importlib.util
import json
import sys
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent.parent
GEN = REPO_DIR / "scripts" / "site" / "generate-site.py"
EVAL_DIR = REPO_DIR / "benchmark-results" / "evaluations"
RUNS_DIR = REPO_DIR / "benchmark-results" / "runs"

# The ONLY provider allowed to hold an authoritative (publishable) judgment.
ALLOWED_AUTHORITATIVE_PROVIDERS = {"cc-acp"}
# Known disallowed standalone model-API / CLI / local evaluators (for clearer
# messages); any provider not in ALLOWED is treated as a violation regardless.
DISALLOWED_PROVIDERS = {
    "openai", "anthropic", "gemini", "gemini-cli", "openrouter",
    "ollama", "qwen", "local", "vllm", "vertex", "groq",
}


def load_public_runs():
    spec = importlib.util.spec_from_file_location("gen_site", GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return set(mod.PUBLIC_BENCHMARK_RUNS)


def judge_of(ev):
    """Return the active judge object, handling nested llmJudge and the legacy
    top-level judge layout."""
    j = ev.get("llmJudge")
    if isinstance(j, dict) and j:
        return j
    if ev.get("judgeProvider") or ev.get("judgeModel"):
        return ev
    return {}


def provider_of(j):
    return j.get("provider") or j.get("judgeProvider")


def scan(public, eval_dir, runs_dir):
    """Scan the given evaluation/runs trees and return (violations, warnings,
    runs_seen). Pure function over filesystem paths so it can be unit-tested."""
    violations = []
    warnings = []
    runs_seen = 0
    for run in sorted(public):
        edir = eval_dir / run
        if not edir.exists():
            warnings.append(f"{run}: no evaluations directory")
            continue
        runs_seen += 1
        for ef in sorted(edir.glob("*.json")):
            if ef.name == "summary.json":
                continue
            try:
                ev = json.loads(ef.read_text())
            except (json.JSONDecodeError, OSError) as e:
                violations.append(f"{run}/{ef.name}: unreadable evaluation ({e})")
                continue
            j = judge_of(ev)
            if not j:
                warnings.append(f"{run}/{ef.name}: no judge (pending) — must be excluded from public scoring")
                continue
            authoritative = j.get("authoritative")
            prov = provider_of(j)
            if authoritative and prov not in ALLOWED_AUTHORITATIVE_PROVIDERS:
                tag = "DISALLOWED" if prov in DISALLOWED_PROVIDERS else "NON-ACP"
                violations.append(
                    f"{run}/{ef.name}: authoritative judge provider={prov!r} "
                    f"model={j.get('model') or j.get('judgeModel')!r} [{tag}] "
                    f"— publishable judgment must be cc-acp"
                )

    # Speed-source check: a public run may only carry a numeric generation speed
    # when it comes from a measured llama.cpp/provider source.
    for run in sorted(public):
        mfile = runs_dir / run / "metadata.json"
        if not mfile.exists():
            continue
        try:
            m = json.loads(mfile.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        gpu = (m.get("hardware") or {}).get("gpu") or {}
        tps = gpu.get("generationTokensPerSecond")
        src = gpu.get("generationTokensPerSecondSource")
        if isinstance(tps, (int, float)) and tps > 0:
            if src and not str(src).startswith("measured"):
                violations.append(
                    f"{run}: generationTokensPerSecond={tps} has non-measured source {src!r} "
                    f"— only measured generation TPS may be published"
                )
    return violations, warnings, runs_seen


def main():
    public = load_public_runs()
    violations, warnings, runs_seen = scan(public, EVAL_DIR, RUNS_DIR)
    print(f"Checked {runs_seen} public run(s) against the judge/speed policy.")
    for w in warnings:
        print(f"  WARN: {w}")
    if violations:
        print(f"\nFAILED: {len(violations)} judging/speed policy violation(s):")
        for v in violations:
            print(f"  FAIL: {v}")
        sys.exit(1)
    print("PASS: every public run is judged by cc-acp; no disallowed authoritative judges; no non-measured published TPS.")


if __name__ == "__main__":
    main()
