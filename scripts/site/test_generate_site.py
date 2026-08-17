#!/usr/bin/env python3
"""Regression tests for Gemmaclaw site-generator speed handling.

Guards the 2026-06-04 policy: the public site publishes ONLY measured generation
throughput (llama.cpp / provider timing). The old output-est / full-task
wall-clock fallback must never be rendered as model tok/s.

Pure stdlib (unittest) so it runs in CI without extra deps:
    python3 scripts/site/test_generate_site.py
"""
import importlib.util
import re
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


class TestQuantSearchNormalization(unittest.TestCase):
    """Q4_K_M is the quant this site recommends most and the one a reader is most
    likely to type, yet it was unreachable in the community search box.

    Reddit serves underscores pre-escaped, so summary text arrived as Q4\\_K\\_M.
    clean_markdown() read the two underscores as an emphasis pair, removed them
    and left the backslashes behind, indexing the unmatchable token q4\\k\\m.
    These tests pin both halves of the repair: the escaped form must clean up to
    the literal identifier, and index and query must agree on one canonical form.

    Hermetic: every case builds a synthetic post, so nothing here reads the live
    591-entry dataset or the network.
    """

    @staticmethod
    def _post(title="", summary="", tags=None, comments=None):
        return {
            "id": "test123",
            "title": title,
            "summary": summary,
            "tags": tags or [],
            "comments": comments or [],
            "categories": ["general"],
            "author": "tester",
            "date": "2026-08-02",
            "score": 10,
            "flair": "",
        }

    def _data_search(self, post):
        html = gen.generate_community_cards([post])
        match = re.search(r'<div class="cr-card" data-search="([^"]*)"', html)
        self.assertIsNotNone(match, "expected exactly one rendered community card")
        return match.group(1)

    def _matches(self, post, query):
        """True when a reader typing `query` would see this card, applying the
        same normalization the generated page applies to the input value."""
        return gen.normalize_search_text(query) in self._data_search(post)

    def test_escaped_q4_k_m_is_reachable(self):
        post = self._post(
            title="Quant comparison",
            summary="Evaluated bf16, Q4\\_K\\_M, and Q8\\_0 gguf variants with llama-cpp-python.",
        )
        indexed = self._data_search(post)
        self.assertNotIn("\\", indexed, "no markdown escape may survive into the index")
        for query in ("Q4_K_M", "q4_k_m", "Q4\\_K\\_M", "q4km", "K_M"):
            self.assertTrue(self._matches(post, query), f"query {query!r} must match")

    def test_escaped_q8_0_is_reachable(self):
        post = self._post(
            title="Quant comparison",
            summary="Evaluated bf16, Q4\\_K\\_M, and Q8\\_0 gguf variants with llama-cpp-python.",
        )
        for query in ("Q8_0", "q8_0", "Q8\\_0", "q80"):
            self.assertTrue(self._matches(post, query), f"query {query!r} must match")

    def test_clean_markdown_unescapes_quant_underscores(self):
        self.assertEqual(
            gen.clean_markdown("Ran Q4\\_K\\_M and Q8\\_0 today"),
            "Ran Q4_K_M and Q8_0 today",
        )

    def test_clean_markdown_keeps_intraword_underscores(self):
        self.assertEqual(gen.clean_markdown("Q4_K_M beat Q8_0"), "Q4_K_M beat Q8_0")
        self.assertEqual(
            gen.clean_markdown("call preserve_thinking here"),
            "call preserve_thinking here",
        )

    def test_clean_markdown_still_strips_real_emphasis(self):
        self.assertEqual(gen.clean_markdown("that was _really_ fast"), "that was really fast")
        self.assertEqual(gen.clean_markdown("that was __really__ fast"), "that was really fast")

    def test_clean_markdown_drops_an_unclosed_emphasis_delimiter(self):
        """Reddit summaries get truncated mid-span, so an opener often has no
        partner. It must not render as a literal stray underscore, and it must not
        take an identifier underscore with it on the way out."""
        self.assertEqual(
            gen.clean_markdown("_2026-05-07 edit: I do not recommend q4_0 KV cache"),
            "2026-05-07 edit: I do not recommend q4_0 KV cache",
        )

    def test_clean_markdown_keeps_a_trailing_handle_underscore(self):
        """Reddit handles routinely end in one or more underscores. Stripping the
        trailing run to tidy up stranded emphasis closers renames a real person, so
        the cleanup deliberately only fires on the opener shape."""
        self.assertEqual(
            gen.clean_markdown("sincerely thank u/jipok_ for helping out"),
            "sincerely thank u/jipok_ for helping out",
        )
        self.assertEqual(
            gen.clean_markdown("submitted by /u/mjsxi__ [link]"),
            "submitted by /u/mjsxi__ [link]",
        )

    def test_clean_markdown_keeps_a_leading_handle_underscore(self):
        """Reddit handles also routinely START with an underscore, and that shape is
        indistinguishable from a stranded emphasis opener: the slash before it is
        non-alphanumeric and a word follows it. Dropping it renames a real person,
        exactly the way eating a trailing underscore would."""
        self.assertEqual(
            gen.clean_markdown("a report from u/_maverick98 on a Mac"),
            "a report from u/_maverick98 on a Mac",
        )
        self.assertEqual(
            gen.clean_markdown("submitted by /u/_maverick98 [link]"),
            "submitted by /u/_maverick98 [link]",
        )

    def test_leading_handle_underscore_survives_the_reddit_escape(self):
        """Reddit serves the handle pre-escaped as u/\\_maverick98. The unescape must
        run first and the opener cleanup must then leave the bare underscore alone, so
        neither a literal backslash nor a renamed author reaches the page."""
        cleaned = gen.clean_markdown("a report from u/\\_maverick98 on a Mac")
        self.assertEqual(cleaned, "a report from u/_maverick98 on a Mac")
        self.assertNotIn("\\", cleaned, "no markdown escape may survive into display text")

    def test_leading_handle_underscore_does_not_leak_into_search(self):
        """The handle keeps its leading underscore for display, while the search index
        and the typed query both drop identifier punctuation, so it stays reachable."""
        post = self._post(title="Credit", summary="thanks u/_maverick98 for the audit")
        self.assertIn("maverick98", self._data_search(post))
        for query in ("maverick98", "_maverick98", "u/_maverick98"):
            self.assertTrue(self._matches(post, query), f"query {query!r} must match")

    def test_trailing_handle_underscore_does_not_leak_into_search(self):
        """The handle keeps its underscore for display, but the search index and the
        typed query both drop identifier punctuation, so it stays reachable."""
        post = self._post(title="Credit", summary="thanks u/jipok_ for the audit")
        self.assertIn("jipok", self._data_search(post))
        for query in ("jipok", "jipok_", "u/jipok_"):
            self.assertTrue(self._matches(post, query), f"query {query!r} must match")

    def test_adjacent_tokens_stay_searchable(self):
        post = self._post(
            title="Mixed token soak test",
            summary=(
                "Ran llama.cpp and llama-cpp-python on 26B-A4B with UD-Q4_K_XL, "
                "Q4_K_S, NVFP4 and MXFP4 at 128k context on a 5090 with 48 GB, "
                "served through vLLM."
            ),
        )
        for query in ("llama.cpp", "llama-cpp-python", "26B-A4B", "UD-Q4_K_XL",
                      "Q4_K_S", "NVFP4", "MXFP4", "5090", "48 GB", "128k", "vLLM"):
            self.assertTrue(self._matches(post, query), f"query {query!r} must match")

    def test_normalize_search_text_is_idempotent(self):
        once = gen.normalize_search_text("Q4\\_K\\_M / llama.cpp  26B-A4B")
        self.assertEqual(once, "q4km llamacpp 26ba4b")
        self.assertEqual(gen.normalize_search_text(once), once)

    def test_every_spelling_reduces_to_one_token(self):
        spellings = ["Q4_K_M", "q4_k_m", "Q4\\_K\\_M", "q4km", "Q4K_M", "q4-k-m"]
        self.assertEqual({gen.normalize_search_text(s) for s in spellings}, {"q4km"})


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


class TestFieldNotesEscapedEmphasis(unittest.TestCase):
    """oxfmt formats site/data/field-notes.md from the pre-commit hook and escapes
    a word-boundary underscore itself, so a Reddit handle like u/_maverick98 is
    rewritten to u/\\_maverick98 on the way into the commit. The renderer has to
    honour that escape, or the backslash lands in reader-visible prose and the
    committed HTML can never be reproduced from the Markdown that generated it."""

    def _render(self, md):
        return gen.render_field_notes_markdown(md)

    def test_leading_underscore_handle_keeps_its_underscore_and_drops_the_backslash(self):
        out = self._render("A report from u/\\_maverick98 on a MacBook Pro M4.")
        self.assertIn("u/_maverick98", out)
        self.assertNotIn("\\", out)

    def test_trailing_underscore_handle_drops_the_backslash(self):
        out = self._render("A community thread (u/opoot\\_, no numbers given).")
        self.assertIn("u/opoot_", out)
        self.assertNotIn("\\", out)

    def test_escaped_underscore_does_not_open_an_italic_span(self):
        out = self._render("The \\_old non-QAT build and the \\_new one both ran.")
        self.assertNotIn("<em>", out)
        self.assertIn("_old", out)
        self.assertIn("_new", out)

    def test_escaped_asterisk_renders_literally(self):
        out = self._render("The flag is \\*not\\* a wildcard here.")
        self.assertNotIn("<em>", out)
        self.assertIn("*not*", out)

    def test_windows_path_backslashes_are_left_alone(self):
        out = self._render("The build lives at D:\\a\\llama-cpp-binaries and is unrelated.")
        self.assertIn("D:\\a\\llama-cpp-binaries", out)

    def test_escaped_dot_is_left_alone(self):
        out = self._render('Pass --override-tensor-draft "token_embd\\.weight=CUDA0" to fix it.')
        self.assertIn("token_embd\\.weight", out)

    def test_real_emphasis_still_renders_beside_an_escaped_underscore(self):
        out = self._render("_August 12 sweep:_ a report from u/\\_maverick98.")
        self.assertIn("<em>August 12 sweep:</em>", out)
        self.assertIn("u/_maverick98", out)


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


class TestShortChipTokenBoundaries(unittest.TestCase):
    """"m1" through "m5" are two characters long, so a plain substring test drags
    any word that happens to contain them into the Apple Silicon filter. An AM3
    motherboard socket, an SM120 part number and the handle am17an all did exactly
    that, and 21 of the 95 apple-silicon posts matched on nothing else."""

    @staticmethod
    def _post(title="", summary="", tags=None, comments=None):
        return {
            "title": title,
            "summary": summary,
            "tags": tags or [],
            "comments": comments or [],
        }

    def test_am3_socket_is_not_apple_silicon(self):
        post = self._post(
            title="Did I throw money in the mud?",
            summary="Two RTX 5060 Ti cards on an old AM3 board. No Apple hardware anywhere.",
        )
        self.assertNotIn("apple-silicon", gen.categorize_post(post))

    def test_sm120_part_number_is_not_apple_silicon(self):
        post = self._post(summary="Built the kernels for sm120 and it finally compiled.")
        self.assertNotIn("apple-silicon", gen.categorize_post(post))

    def test_github_handle_containing_m1_is_not_apple_silicon(self):
        post = self._post(summary="Thanks to am17an for landing the patch upstream.")
        self.assertNotIn("apple-silicon", gen.categorize_post(post))

    def test_m3_max_is_still_apple_silicon(self):
        post = self._post(summary="Running it on an M3 Max with 64 GB.")
        self.assertIn("apple-silicon", gen.categorize_post(post))

    def test_bare_chip_token_on_a_boundary_is_still_apple_silicon(self):
        """The boundary is non-alphanumeric, not whitespace, so a hyphenated or
        parenthesised chip name still matches."""
        for text in ["I use an M1 daily.", "on the M4-Pro", "(M2) 24 GB", "M5,"]:
            with self.subTest(text=text):
                self.assertIn("apple-silicon", gen.categorize_post(self._post(summary=text)))

    def test_macbook_pro_is_still_apple_silicon(self):
        post = self._post(summary="MacBook Pro, 36 GB unified memory.")
        self.assertIn("apple-silicon", gen.categorize_post(post))

    def test_no_hardware_signal_still_falls_back_to_general(self):
        post = self._post(title="How do you write system prompts?", summary="Curious.")
        self.assertEqual(gen.categorize_post(post), ["general"])

    def test_keyword_matches_leaves_long_keywords_as_substrings(self):
        """Only the short chip tokens get boundary treatment; every other keyword
        keeps its substring behaviour so no existing categorisation moves."""
        self.assertTrue(gen.keyword_matches("quant", "unsloth quantizations"))
        self.assertTrue(gen.keyword_matches("3090", "rtx3090"))
        self.assertFalse(gen.keyword_matches("m3", "am3"))
        self.assertTrue(gen.keyword_matches("m3", "m3"))


class TestAppleSiliconIndexCount(unittest.TestCase):
    """A count assertion over the real index, because the unit cases above cannot
    tell you whether the boundary rule actually cleared the 21 bad matches or
    silently swallowed genuine Apple posts too."""

    APPLE_SILICON_EXPECTED = 74

    def test_apple_silicon_count_over_the_real_index(self):
        configs = gen.load_community_configs()
        self.assertGreater(len(configs), 0, "community index failed to load")
        count = sum(1 for c in configs if "apple-silicon" in c.get("categories", []))
        self.assertEqual(
            count,
            self.APPLE_SILICON_EXPECTED,
            "apple-silicon post count moved; if the index grew, re-derive this "
            "number and update the Field Notes prose that cites it",
        )

    def test_known_non_apple_posts_are_not_apple_silicon(self):
        """1vq2fk7 is two Nvidia cards on an AM3 board, 1syjflw matched on the
        sm120 part number and 1tif9vv on the handle am17an. All three used to sit
        under the Apple Silicon chip."""
        configs = {c.get("id"): c for c in gen.load_community_configs()}
        for post_id in ("1vq2fk7", "1syjflw", "1tif9vv"):
            with self.subTest(post=post_id):
                self.assertIn(post_id, configs, f"{post_id} missing from the index")
                self.assertNotIn("apple-silicon", configs[post_id].get("categories", []))


class TestUpstreamEntityUnescaping(unittest.TestCase):
    """Reddit serves some characters PRE-ESCAPED inside the archived markdown, so
    the submission footer of post 1vfeick arrives as the literal sequence
    "&#32; submitted by &#32; /u/jacek2023 [link] &#32; [comments]".

    html_escape() escaped that ampersand a second time, the browser received
    "&amp;#32;", and the card painted the characters "&#32;" mid-sentence. Same
    ordering defect as the pre-escaped-underscore search bug: normalize what
    upstream escaped BEFORE applying our own transformation.
    """

    def test_numeric_space_entity_becomes_whitespace_not_literal_text(self):
        raw = "&#32; submitted by &#32; /u/jacek2023 [link] &#32; [comments]"
        cleaned = gen.clean_markdown(raw)
        self.assertNotIn("&#32;", cleaned)
        self.assertNotIn("#32", cleaned)
        self.assertEqual(cleaned, "submitted by /u/jacek2023 [link] [comments]")

    def test_rendered_card_summary_carries_no_double_escaped_entity(self):
        """End of the real pipeline: clean_markdown() then html_escape() is what
        writes the card body, and neither "&amp;#32;" nor "&#32;" may survive."""
        rendered = gen.html_escape(gen.clean_markdown(
            "&#32; submitted by &#32; /u/jacek2023 [link] &#32; [comments]"
        ))
        self.assertNotIn("&amp;#32;", rendered)
        self.assertNotIn("#32", rendered)
        self.assertEqual(rendered, "submitted by /u/jacek2023 [link] [comments]")

    def test_named_entities_render_as_their_character(self):
        """A comment body carrying "&lt;turn|&gt;" must reach the page as the
        angle-bracketed token, escaped exactly once."""
        rendered = gen.html_escape(gen.clean_markdown("harmony leaks &lt;turn|&gt; markers"))
        self.assertNotIn("&amp;lt;", rendered)
        self.assertNotIn("&amp;gt;", rendered)
        self.assertEqual(rendered, "harmony leaks &lt;turn|&gt; markers")

    def test_escaped_ampersand_ships_as_one_amp_entity(self):
        rendered = gen.html_escape(gen.clean_markdown("v1.0.13 &amp; v1.0.14 updates"))
        self.assertNotIn("&amp;amp;", rendered)
        self.assertEqual(rendered, "v1.0.13 &amp; v1.0.14 updates")

    def test_title_path_unescapes_too(self):
        """Titles skip clean_markdown(), so they carry their own decode."""
        title = gen.html_escape(gen.normalize_typographic_dashes(
            gen.unescape_upstream_entities("Setup &amp; Working Config")
        ))
        self.assertNotIn("&amp;amp;", title)
        self.assertEqual(title, "Setup &amp; Working Config")

    def test_decoded_dash_entity_still_reaches_the_dash_normalizer(self):
        """Ordering guard: the decode must run BEFORE normalize_typographic_dashes,
        or "&mdash;" would smuggle a real em dash past the no-dashes gate."""
        out = gen.clean_markdown("24 GB &mdash; enough for the 26B")
        for cp in (0x2012, 0x2013, 0x2014, 0x2015, 0x2E3A, 0x2E3B, 0x2212):
            self.assertNotIn(chr(cp), out)
        self.assertEqual(out, "24 GB - enough for the 26B")

    def test_bare_ampersand_prose_is_left_alone(self):
        """Only well-formed semicolon-terminated entities decode. A stray "&times"
        or "&copy" in ordinary prose must not be rewritten into a symbol."""
        self.assertEqual(
            gen.unescape_upstream_entities("2 &times 3090s, R&D budget, AT&T"),
            "2 &times 3090s, R&D budget, AT&T",
        )

    def test_unknown_entity_name_is_preserved(self):
        self.assertEqual(gen.unescape_upstream_entities("&notarealentity;"), "&notarealentity;")

    def test_unescape_is_idempotent_on_plain_text(self):
        plain = "Q4_K_M on a 3090 at 26 tok/s"
        self.assertEqual(gen.unescape_upstream_entities(plain), plain)


class TestFieldNotesLinkDoubleEscape(unittest.TestCase):
    """Second, DISTINCT escaping defect with the same reader-visible symptom.

    render_inline() escapes the whole line, then link_sub() escaped the captured
    label a second time, so a Sources entry whose Reddit title carries a plain
    ASCII quote shipped as "&amp;quot;" and painted the characters &quot; on the
    community page. Unlike the entity defect above, nothing upstream is
    pre-escaped here: the generator escapes its own output twice.
    """

    def test_quoted_link_label_is_escaped_exactly_once(self):
        out = gen.render_field_notes_markdown(
            '- [My local AI developed an "attitude"](https://reddit.com/r/localllama/comments/1v7kf8o) (Jul 27)'
        )
        self.assertNotIn("&amp;quot;", out)
        self.assertIn("developed an &quot;attitude&quot;</a>", out)

    def test_ampersand_link_label_is_escaped_exactly_once(self):
        out = gen.render_field_notes_markdown(
            "- [Qwen & Gemma on deadlock situation](https://reddit.com/r/localllama/comments/1uoppuz)"
        )
        self.assertNotIn("&amp;amp;", out)
        self.assertIn("Qwen &amp; Gemma on deadlock situation</a>", out)

    def test_url_query_string_is_not_double_escaped(self):
        out = gen.render_field_notes_markdown("- [docs](https://example.com/a?x=1&y=2)")
        self.assertIn('href="https://example.com/a?x=1&amp;y=2"', out)
        self.assertNotIn("&amp;amp;", out)

    def test_angle_brackets_in_a_label_stay_escaped(self):
        """The caller decodes &lt;/&gt; so this regex can see the markdown, so the
        link builder has to put them back or raw markup would reach the page."""
        out = gen.render_field_notes_markdown("- [a <b> tag](https://example.com)")
        self.assertIn("a &lt;b&gt; tag</a>", out)
        self.assertNotIn("<b>", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
