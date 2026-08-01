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


class TypographicDashNormalization(unittest.TestCase):
    """Community-card text must never emit typographic dashes (em/en/etc.).

    Raw Reddit excerpts routinely contain them and they trip the deliverable
    no-typographic-dashes gate. Guards the 2026-07-13 QA fix.
    """

    # Code points listed numerically so this test file stays free of typographic
    # dashes (which the no-typographic-dashes gate would otherwise flag here).
    DASHES = "".join(chr(cp) for cp in (
        0x2010, 0x2011, 0x2012, 0x2013, 0x2014,
        0x2015, 0x2043, 0x2E3A, 0x2E3B, 0x2212,
    ))

    def test_normalize_maps_every_dash_to_hyphen(self):
        for ch in self.DASHES:
            self.assertEqual(gen.normalize_typographic_dashes(f"a{ch}b"), "a-b")

    def test_clean_markdown_strips_typographic_dashes(self):
        em_dash = chr(0x2014)
        out = gen.clean_markdown(f"RTX 3060 (12 GB){em_dash}PCIe is Gen 3")
        for ch in self.DASHES:
            self.assertNotIn(ch, out)
        self.assertIn("(12 GB)-PCIe is Gen 3", out)

    def test_normalize_preserves_plain_text(self):
        self.assertEqual(
            gen.normalize_typographic_dashes("already-hyphenated 26B-A4B"),
            "already-hyphenated 26B-A4B",
        )


class TestFieldNotesItalics(unittest.TestCase):
    """Field-notes prose italicises whole sentences that mention quant names, so
    an inner identifier underscore must not cancel the emphasis and leak literal
    underscores onto the page."""

    def _render(self, md):
        return gen.render_field_notes_markdown(md)

    def test_italic_span_survives_an_identifier_underscore(self):
        out = self._render("_Last updated: 2026-08-01. Gemma 4 26B A4B at Q4_0 hit 18.35 tok/s._")
        self.assertIn("<em>Last updated: 2026-08-01. Gemma 4 26B A4B at Q4_0 hit 18.35 tok/s.</em>", out)
        self.assertNotIn("<p>_Last updated", out)

    def test_italic_span_survives_multiple_identifier_underscores(self):
        out = self._render("_Compared Q4_K_M against Q8_0 on the same box._")
        self.assertIn("<em>Compared Q4_K_M against Q8_0 on the same box.</em>", out)

    def test_plain_identifier_does_not_open_an_italic_span(self):
        out = self._render("Use Q4_0 or Q8_0 for the sparse model.")
        self.assertNotIn("<em>", out)
        self.assertIn("Q4_0 or Q8_0", out)

    def test_snake_case_word_is_left_alone(self):
        out = self._render("The helper is named load_community_configs today.")
        self.assertNotIn("<em>", out)
        self.assertIn("load_community_configs", out)

    def test_simple_italic_still_renders(self):
        out = self._render("_August 1 sweep:_ an Apple Silicon runtime cycle.")
        self.assertIn("<em>August 1 sweep:</em>", out)


class TestCategorizePost(unittest.TestCase):
    """Community cards are filtered by hardware category, so a post that only
    identifies its platform in prose (for example "a Mac engine") must still land
    in the Apple Silicon filter rather than falling through to "general"."""

    @staticmethod
    def _post(title="", summary="", tags=None, comments=None):
        return {
            "title": title,
            "summary": summary,
            "tags": tags or [],
            "comments": comments or [],
        }

    def test_mac_engine_prose_is_apple_silicon(self):
        post = self._post(
            title="I ported an engine to another model and it runs in 1.4 GB of RAM",
            summary="Was playing around with a Mac engine that runs Gemma 4 26B in ~2 GB.",
        )
        self.assertIn("apple-silicon", gen.categorize_post(post))

    def test_macos_only_question_is_apple_silicon(self):
        post = self._post(title="Gemma 4 12B Ollama models: MacOS only?")
        self.assertIn("apple-silicon", gen.categorize_post(post))

    def test_m_series_prose_is_apple_silicon(self):
        post = self._post(summary="Runs on M-series Macs with very low RAM.")
        self.assertIn("apple-silicon", gen.categorize_post(post))

    def test_machine_word_does_not_match_apple_silicon(self):
        """The "mac " keyword carries a trailing space precisely so that words
        like "machine" do not drag unrelated posts into the Apple filter."""
        post = self._post(
            title="Benchmarked on a dedicated machine",
            summary="A single machine with an RTX 3090 and no Apple hardware involved.",
        )
        self.assertNotIn("apple-silicon", gen.categorize_post(post))

    def test_uncategorized_post_falls_back_to_general(self):
        post = self._post(title="Thoughts on prompt style", summary="No hardware here.")
        self.assertEqual(gen.categorize_post(post), ["general"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
