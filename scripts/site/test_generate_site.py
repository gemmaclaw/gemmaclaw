#!/usr/bin/env python3
"""Regression tests for Gemmaclaw site-generator speed handling.

Guards the 2026-06-04 policy: the public site publishes ONLY measured generation
throughput (llama.cpp / provider timing). The old output-est / full-task
wall-clock fallback must never be rendered as model tok/s.

Pure stdlib (unittest) so it runs in CI without extra deps:
    python3 scripts/site/test_generate_site.py
"""
import importlib.util
import unittest
from pathlib import Path

GEN_PATH = Path(__file__).resolve().parent / "generate-site.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("gen_site_under_test", GEN_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gen = _load_module()


def _synthetic_run(measured_tps, per_task_output_est):
    """A run whose per-task records carry an output-est speed and whose metadata
    carries a measured generation TPS (mirrors the merge done in
    load_benchmark_results)."""
    return {
        "metadata": {
            "model": "gemma-4-test",
            "startedAt": "2026-06-04T00:00:00Z",
            "hardware": {
                "cpu": {"model": "Test CPU"},
                "ram": {"totalBytes": 16 * 1024**3},
                "gpu": {
                    "name": "RTX 3090",
                    "generationTokensPerSecond": measured_tps,
                    "generationTokensPerSecondSource": "measured-llamacpp",
                },
            },
        },
        "config": {"backend": "llama.cpp"},
        "tasks": [
            {
                "task": {"id": "t1", "name": "Task 1", "grading": {"criteria": ["c"], "maxScore": 10}},
                "completionStatus": "completed",
                "elapsedMs": 120000,
                "tokensPerSecond": per_task_output_est,
                "tokensPerSecondSource": "effective-output",
                "conversation": [{"role": "assistant", "content": "hi"}],
            }
        ],
    }


class FormatMeasuredSpeed(unittest.TestCase):
    def test_measured_value_renders_tok_s(self):
        self.assertEqual(gen.format_measured_speed(70.6), "71 tok/s")

    def test_zero_and_none_render_na(self):
        self.assertEqual(gen.format_measured_speed(None), "N/A")
        self.assertEqual(gen.format_measured_speed(0), "N/A")
        self.assertEqual(gen.format_measured_speed(-5), "N/A")

    def test_detail_pending_label(self):
        self.assertEqual(gen.format_measured_speed(None, short=False), "Pending measurement")

    def test_output_est_suffix_is_gone(self):
        # No code path may ever append the old "output-est" suffix.
        self.assertNotIn("output-est", gen.format_measured_speed(70.6))
        self.assertFalse(hasattr(gen, "format_speed"), "legacy format_speed must be removed")
        self.assertFalse(hasattr(gen, "estimate_output_tokens_per_second"),
                         "dead output-est fallback must be removed")


class MeasuredWinsOverOutputEst(unittest.TestCase):
    def test_summary_uses_measured_generation_tps(self):
        run = _synthetic_run(measured_tps=70.6, per_task_output_est=1.3)
        norm = gen.normalize_agentic_benchmark_result(run, "synthetic-run")
        # The summary speed must be the measured value, never the per-task output-est.
        self.assertEqual(norm["summary"]["generationTokensPerSecond"], 70.6)
        self.assertNotIn("medianTokensPerSecond", norm["summary"])
        rendered = gen.format_measured_speed(norm["summary"]["generationTokensPerSecond"])
        self.assertEqual(rendered, "71 tok/s")

    def test_no_measured_source_renders_na_not_estimate(self):
        run = _synthetic_run(measured_tps=None, per_task_output_est=1.3)
        norm = gen.normalize_agentic_benchmark_result(run, "synthetic-run")
        self.assertIn(norm["summary"]["generationTokensPerSecond"], (None, 0))
        rendered = gen.format_measured_speed(norm["summary"]["generationTokensPerSecond"])
        self.assertEqual(rendered, "N/A")
        self.assertNotIn("1.3", rendered)

    def test_per_task_detail_row_never_shows_output_est_tok_s(self):
        run = _synthetic_run(measured_tps=70.6, per_task_output_est=1.3)
        norm = gen.normalize_agentic_benchmark_result(run, "synthetic-run")
        rows = gen.generate_task_detail_rows(norm["tasks"])
        html = "\n".join(rows) if isinstance(rows, list) else str(rows)
        self.assertNotIn("output-est", html)
        self.assertNotIn("1.3 tok/s", html)


if __name__ == "__main__":
    unittest.main(verbosity=2)
