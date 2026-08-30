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
import tempfile
import unittest
from pathlib import Path

GEN_PATH = Path(__file__).resolve().parent / "generate-site.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("gen_site_under_test", GEN_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gen = _load_module()

# The index-count assertions below enrich each post from workspace-only Reddit
# markdown under gen.POSTS_DIR. That directory ships with the OpenClaw workspace,
# not with the gemmaclaw repo, so in a bare checkout / CI the enrichment yields an
# empty index. Skip there rather than fail: the boundary unit tests above already
# guard the categoriser logic in CI; the count guard is for the workspace/sweep env.
_WORKSPACE_POSTS_AVAILABLE = gen.POSTS_DIR.exists()


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


class TestBodyTextIsSearchable(unittest.TestCase):
    """The community search index used to cover only the title, the Short summary,
    the tags and the top three comments. Short summary is an upstream truncation
    of the post body that stops mid-sentence, so a report's quant name, backend
    or download instruction routinely lived only in the body and was unreachable.

    The worked example is 1vvtu9z, the 2026-08-24 cycle's only Gemma-specific
    report. Its field note quotes "fp16 to Q4_K_M weights for llama.cpp or
    ollama", and every one of those terms sits past the truncation point, in the
    body, on a post with zero comments. Searching Q4_K_M, fp16, ollama or
    llama.cpp returned the card's neighbours and not the card itself.

    Hermetic apart from the two cases that say otherwise in their own docstring.
    """

    @staticmethod
    def _post(title="", summary="", body="", tags=None, comments=None):
        return {
            "id": "1vvtu9z",
            "title": title,
            "summary": summary,
            "body": body,
            "tags": tags or [],
            "comments": comments or [],
            "categories": ["general"],
            "author": "tester",
            "date": "2026-08-23",
            "score": 20,
            "flair": "",
        }

    def _matches(self, post, query):
        return gen.normalize_search_text(query) in gen.build_card_search_text(post)

    def test_quant_and_backend_past_the_summary_truncation_are_reachable(self):
        """Mirrors 1vvtu9z: the summary is cut off before the sentence that names
        the quant and the runtimes, and the post has no comments to fall back to."""
        post = self._post(
            title="I fine tuned Gemma 4 12B for a 2.7x improvement on tool calling",
            summary="Gemma 12B is obviously a very well trained model, I always thought the fine tuning...",
            body=(
                "Gemma 12B is obviously a very well trained model, I always thought the fine tuning "
                "they did on it wasn't really cut out for agentic coding. I have fp16 -> Q4\\_K\\_M "
                "weights uploaded and ready for use with llama.cpp or ollama"
            ),
        )
        for query in ("Q4_K_M", "q4km", "fp16", "ollama", "llama.cpp", "llamacpp"):
            self.assertTrue(self._matches(post, query), f"query {query!r} must match")

    def test_body_is_indexed_when_there_is_no_summary_and_no_comments(self):
        post = self._post(title="Untitled", body="Served with vLLM at 128k context on an MI60.")
        for query in ("vLLM", "128k", "MI60"):
            self.assertTrue(self._matches(post, query), f"query {query!r} must match")

    def test_a_summary_that_is_not_a_body_prefix_is_still_indexed(self):
        """Link posts carry a summary the body never repeats. Dropping the copy is
        only ever safe when the body already holds every one of its characters."""
        post = self._post(summary="Benchmarked on a Strix Halo", body="Numbers are in the linked gist.")
        self.assertTrue(self._matches(post, "Strix Halo"))
        self.assertTrue(self._matches(post, "linked gist"))

    def test_a_truncated_summary_copy_is_not_indexed_twice(self):
        body = "Ran Gemma 4 26B A4B at Q8_0 overnight and it held 18.35 tok/s the whole time."
        post = self._post(summary="Ran Gemma 4 26B A4B at Q8_0 overnight and it held...", body=body)
        indexed = gen.build_card_search_text(post)
        self.assertEqual(indexed.count("overnight"), 1, "the copied sentence must appear once")
        self.assertTrue(self._matches(post, "Q8_0"))
        self.assertTrue(self._matches(post, "18.35"))

    def test_model_pair_shorthand_indexes_the_second_variant(self):
        post = self._post(
            body=(
                "All 4 models tested (Qwen 3.5 2B and 4B, and Gemma 4 E2B and E4B) "
                "showed clear sycophancy directions in some layers."
            ),
        )
        for query in ("Qwen 3.5 4B", "Gemma 4 E4B", "Gemma 4 E2B"):
            self.assertTrue(self._matches(post, query), f"query {query!r} must match")

    def test_model_pair_or_shorthand_indexes_the_second_variant(self):
        post = self._post(
            body=(
                "For multiple models it would be 35B and Gemma 4 26B or 12B "
                "on the Strix Halo box."
            ),
        )
        for query in ("Gemma 4 26B", "Gemma 4 12B"):
            self.assertTrue(self._matches(post, query), f"query {query!r} must match")

    def test_bare_nvidia_card_number_indexes_the_rtx_alias(self):
        post = self._post(
            body=(
                "I ran Gemma 4 12B evaluation over 165 GPU hours on a single 5090 "
                "with full HarmBench traces."
            ),
        )
        for query in ("5090", "RTX 5090", "rtx5090"):
            self.assertTrue(self._matches(post, query), f"query {query!r} must match")

    def test_summary_duplicates_body_needs_both_halves(self):
        self.assertFalse(gen.summary_duplicates_body("anything", ""))
        self.assertFalse(gen.summary_duplicates_body("", "anything"))
        self.assertFalse(gen.summary_duplicates_body("...", "anything"))
        self.assertFalse(gen.summary_duplicates_body("a different sentence", "the body"))
        self.assertTrue(gen.summary_duplicates_body("the body sta...", "the body starts here"))

    def test_index_is_deterministic(self):
        post = self._post(title="T", summary="S", body="B", tags=["gemma"])
        self.assertEqual(gen.build_card_search_text(post), gen.build_card_search_text(post))

    def test_service_named_only_in_a_url_is_reachable(self):
        """Mirrors 1vyzopv, the 2026-08-28 cycle. The whole post is about two
        leaderboards disagreeing, and it names the first one only as a bare URL.
        clean_markdown() strips bare URLs, so before url_host_search_aliases()
        the card was unreachable by the one term that identifies its subject."""
        post = self._post(
            title="Gemma4 31B vs Qwen3.8 27B - why the huge difference in benchmarks?",
            body=("But this is truly baffling: AA says Qwen 3.8 27B is better by miles: "
                  "https://artificialanalysis.ai/models/comparisons/qwen3-8-27b-vs-gemma-4-31b "
                  "While Arena says Gemma 4 31B is almost 20 places ahead"),
        )
        self.assertTrue(self._matches(post, "artificialanalysis.ai"))
        self.assertTrue(self._matches(post, "artificialanalysis"))

    def test_url_host_aliases_drop_www_and_are_sorted_and_deduplicated(self):
        text = "see https://www.Example.COM/a and https://example.com/b and http://sub.example.org/c"
        self.assertEqual(
            gen.url_host_search_aliases(text),
            "example example.com sub.example sub.example.org",
        )

    def test_url_host_aliases_ignore_hostless_and_bare_schemes(self):
        self.assertEqual(gen.url_host_search_aliases("http://localhost/x"), "")
        self.assertEqual(gen.url_host_search_aliases("no links here at all"), "")

    def test_url_host_aliases_do_not_leak_the_path(self):
        """Only the host is indexed: a long tracking path must not enter the index."""
        indexed = gen.url_host_search_aliases("https://arena.ai/leaderboard/text/overall")
        self.assertIn("arena.ai", indexed)
        self.assertNotIn("leaderboard", indexed)

    def test_index_is_capped(self):
        post = self._post(body="tok " * 5000)
        self.assertLessEqual(len(gen.build_card_search_text(post)), gen.COMMUNITY_SEARCH_INDEX_LIMIT)

    def test_no_markdown_escape_survives_into_the_body_index(self):
        post = self._post(body="uploaded Q4\\_K\\_M and Q8\\_0 gguf files")
        self.assertNotIn("\\", gen.build_card_search_text(post))

    def test_parser_reads_a_body_section(self):
        """The body block used to fall through the generic '## ' branch and be
        discarded, which is why nothing downstream could index it. The other
        sections must keep parsing into their own fields."""
        raw = (
            "# A title\n\n- Score: 20\n- Author: u/tester\n- Date: 2026-08-23T01:30:21.000Z\n\n"
            "## Short summary\n\nTruncated prefix of the body...\n\n"
            "## Key takeaways from comments\n\n(No comments captured)\n\n"
            "## Tags\n\n- quantization\n\n"
            "## Post text (excerpt)\n\nfp16 -> Q4\\_K\\_M weights for llama.cpp or ollama\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            posts_dir = Path(tmp)
            (posts_dir / "1vvtu9z.md").write_text(raw, encoding="utf-8")
            original = gen.POSTS_DIR
            gen.POSTS_DIR = posts_dir
            try:
                post = gen.parse_reddit_post("1vvtu9z")
            finally:
                gen.POSTS_DIR = original
        self.assertIsNotNone(post, "expected the archived post to parse")
        self.assertIn("Q4\\_K\\_M", post["body"])
        self.assertIn("ollama", post["body"])
        self.assertNotIn("## Tags", post["body"])
        self.assertNotIn("No comments captured", post["body"])
        self.assertEqual(post["summary"], "Truncated prefix of the body...")
        self.assertEqual(post["tags"], ["quantization"])
        self.assertTrue(gen.build_card_search_text(post).endswith("ollama"))


@unittest.skipUnless(
    _WORKSPACE_POSTS_AVAILABLE,
    "requires workspace Reddit post markdown (gen.POSTS_DIR); absent in a bare "
    "repo checkout / CI, where load_community_configs() cannot enrich the index",
)
class TestSearchIndexOverTheRealIndex(unittest.TestCase):
    """The cap only earns its place if it clears the whole corpus. A synthetic
    case cannot tell you that, because the defect being fixed is precisely a cap
    that bit every real post while every unit test stayed green."""

    def test_the_cap_clears_every_archived_post(self):
        posts = gen.load_community_configs()
        self.assertGreater(len(posts), 0, "expected the live community index to load")
        longest = max(len(gen.build_card_search_text(p)) for p in posts)
        self.assertLess(longest, gen.COMMUNITY_SEARCH_INDEX_LIMIT,
                        "no archived post may be truncated by the search-index cap")

    def test_the_worked_example_is_reachable_by_its_quant_and_backend(self):
        """1vvtu9z is the report this whole change exists for: its field note
        publishes fp16, Q4_K_M, llama.cpp and ollama, and none of them reached
        the card while only the truncated Short summary was indexed."""
        post = next((p for p in gen.load_community_configs() if p["id"] == "1vvtu9z"), None)
        self.assertIsNotNone(post, "expected 1vvtu9z in the live community index")
        indexed = gen.build_card_search_text(post)
        for query in ("Q4_K_M", "q4km", "fp16", "ollama", "llama.cpp"):
            self.assertIn(gen.normalize_search_text(query), indexed, f"query {query!r} must match")


class TestPostIdLookup(unittest.TestCase):
    """Cite-then-find: every Field Notes claim cites a Reddit id, and a reader who
    pastes that id into the community search box should land on the card.

    The id is carried on its own data-id attribute and compared for EQUALITY
    rather than folded into data-search, because ids are 7 base36 characters and
    a substring index makes short queries collide: 'm4' would match 1vkm42m and
    'q8' would match 1vr2oq8, neither of which mentions either term.
    """

    def _card(self, post_id="1vvtu9z"):
        post = {
            "id": post_id, "title": "A report", "summary": "", "body": "",
            "tags": [], "comments": [], "categories": ["general"],
            "author": "tester", "date": "2026-08-23", "score": 20, "flair": "",
        }
        return gen.generate_community_cards([post])

    def test_card_carries_its_reddit_id(self):
        self.assertIn('data-id="1vvtu9z"', self._card())

    def test_id_is_not_folded_into_the_substring_index(self):
        for post_id, colliding_query in (("1vkm42m", "m4"), ("1vr2oq8", "q8"), ("1u4bne8", "4b")):
            card = self._card(post_id)
            indexed = re.search(r'data-search="([^"]*)"', card).group(1)
            self.assertNotIn(colliding_query, indexed,
                             f"{post_id} must not answer a {colliding_query!r} search on its id alone")

    def test_every_card_is_emitted_with_exactly_one_id(self):
        posts = [
            {"id": pid, "title": "A report", "summary": "", "body": "", "tags": [],
             "comments": [], "categories": ["general"], "author": "tester",
             "date": "2026-08-23", "score": 20, "flair": ""}
            for pid in ("1vvtu9z", "1vwhj0l", "1vw9lp9")
        ]
        html = gen.generate_community_cards(posts)
        self.assertEqual(re.findall(r'data-id="([^"]*)"', html), [p["id"] for p in posts])


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


class TestShortAlphabeticTokenBoundaries(unittest.TestCase):
    """Same defect as the chip tokens, in alphabetic form. "sli" is a substring of
    "slightly" and "slip", and r/LocalLLaMA writes "slightly better" constantly, so
    the High-end GPU chip collected eight posts that never mention SLI. "arm" is a
    substring of "warmup", "armed", "army", "pycharm" and "harmbench", which is how
    half of CPU / Raspberry Pi filled up."""

    @staticmethod
    def _post(title="", summary="", tags=None, comments=None):
        return {
            "title": title,
            "summary": summary,
            "tags": tags or [],
            "comments": comments or [],
        }

    def test_slightly_is_not_a_high_end_gpu_signal(self):
        post = self._post(summary="Gemma 4 31B is slightly better than Qwen at refactoring.")
        self.assertNotIn("high-gpu", gen.categorize_post(post))

    def test_freudian_slip_is_not_a_high_end_gpu_signal(self):
        post = self._post(summary="EDIT: Qwen 3.8 not Opus 4.8, freudian slip lol")
        self.assertNotIn("high-gpu", gen.categorize_post(post))

    def test_real_sli_mention_is_still_high_end_gpu(self):
        for text in ["Two cards in SLI.", "sli-bridged cards", "(SLI)"]:
            with self.subTest(text=text):
                self.assertIn("high-gpu", gen.categorize_post(self._post(summary=text)))

    def test_warmup_and_army_and_pycharm_are_not_cpu_only(self):
        for text in [
            "about 19 to 20 generated tok/s after warmup",
            "commonly called the swiss army knife of on-device AI",
            "a personal webproject in python, using pycharm",
            "weight analysis, KL divergence, harmbench safety",
            "submitted by /u/jleonsarmiento",
        ]:
            with self.subTest(text=text):
                self.assertNotIn("cpu-only", gen.categorize_post(self._post(summary=text)))

    def test_real_arm_mention_is_still_cpu_only(self):
        for text in [
            "faster CPU decode than llama.cpp on x86 and arm!",
            "their proprietary ARM SoC, making them a paperweight",
            "measured on x86 (sapphire rapids) and arm (gb10)",
        ]:
            with self.subTest(text=text):
                self.assertIn("cpu-only", gen.categorize_post(self._post(summary=text)))

    def test_numeric_gpu_tokens_deliberately_keep_substring_matching(self):
        """"4x3090" and "5060ti" are genuine mentions written without a boundary,
        so those keywords must NOT be promoted alongside sli and arm."""
        self.assertTrue(gen.keyword_matches("3090", "best models in 3x3090 (72gb vram)"))
        self.assertTrue(gen.keyword_matches("5060", "dual 5060ti16's"))
        self.assertNotIn("3090", gen.BOUNDARY_KEYWORDS)
        self.assertNotIn("5060", gen.BOUNDARY_KEYWORDS)

    def test_keyword_matches_boundary_rule_for_the_new_tokens(self):
        self.assertFalse(gen.keyword_matches("sli", "slightly"))
        self.assertTrue(gen.keyword_matches("sli", "in sli mode"))
        self.assertFalse(gen.keyword_matches("arm", "warmup"))
        self.assertTrue(gen.keyword_matches("arm", "on arm hardware"))

    def test_xeon_is_not_a_cpu_only_signal(self):
        """"on cpu" is the phrase people actually write, but as a bare substring it
        also sits inside "xeon cpu", which is why it needs the boundary rule."""
        post = self._post(summary="an x79 motherboard with a basic xeon cpu and 16gb of ddr3 for about $100")
        self.assertNotIn("cpu-only", gen.categorize_post(post))

    def test_real_on_cpu_mention_is_cpu_only(self):
        for text in [
            "Agent on CPU, which to pick?",
            "i was getting 6-7tg/s on cpu. gpu with vulkan",
            "qwen 3.5 9b gave me 7 t/s on cpu on iphone 15pm",
        ]:
            with self.subTest(text=text):
                self.assertIn("cpu-only", gen.categorize_post(self._post(summary=text)))


class TestBareCapacityTokensAreNotAlwaysVram(unittest.TestCase):
    """A capacity token names a GPU only when nothing right after it says otherwise.
    Over the 660-entry index "48gb" occurs nine times and only two are VRAM; the
    other seven are DDR4 or DDR5 sticks or Apple unified memory, so High-end GPU was
    collecting CPU and Mac builds. Unlike sli and arm this is not a substring bleed,
    the token really is "48gb" in both senses, so the discriminator is the following
    noun rather than a word boundary."""

    @staticmethod
    def _post(title="", summary="", tags=None, comments=None):
        return {
            "title": title,
            "summary": summary,
            "tags": tags or [],
            "comments": comments or [],
        }

    def test_system_ram_capacity_is_not_a_high_end_gpu_signal(self):
        for text in [
            "os: kubuntu 26.04, cpu: ryzen 5 3600, ram: 48gb ddr4",
            "finally get to put my 96GB DDR5 (dual 48GB DDR5-6000CL30) to good use",
            "this is my hardware: ryzen 9 5950x 48gb ddr4 3600 some nvme disk",
            "a box with 48GB of RAM and no discrete card",
        ]:
            with self.subTest(text=text):
                self.assertNotIn("high-gpu", gen.categorize_post(self._post(summary=text)))

    def test_unified_memory_capacity_is_not_a_high_end_gpu_signal(self):
        post = self._post(summary="5.0t/s with 5gb of memory usage on m5 pro with 48gb unified memory")
        self.assertNotIn("high-gpu", gen.categorize_post(post))

    def test_real_vram_capacity_is_still_high_end_gpu(self):
        for text in [
            "48GB VRAM users, what are your daily drivers?",
            "262k context on 48GB - fixed chat template",
            "the setup was simple. one h100 80gb, vllm 0.19.1",
        ]:
            with self.subTest(text=text):
                self.assertIn("high-gpu", gen.categorize_post(self._post(summary=text)))

    def test_disqualifier_is_scoped_to_one_occurrence_not_the_document(self):
        """A rig post that lists its RAM and its GPU must still match on the GPU."""
        post = self._post(summary="r7 5700x, 48gb ddr4, and a 48GB VRAM card")
        self.assertIn("high-gpu", gen.categorize_post(post))

    def test_vram_is_not_swallowed_by_the_whole_word_ram_disqualifier(self):
        self.assertTrue(gen.keyword_matches("48gb", "48gb vram"))
        self.assertFalse(gen.keyword_matches("48gb", "48gb ram"))

    def test_triple_gpu_is_a_high_end_gpu_signal(self):
        """Added alongside the capacity rule: without it the 48gb fix would drop
        a genuine "triple gpu with 31gb vram combined" build off the chip."""
        post = self._post(summary="benchmarks using single system running triple gpu with 31gb vram combined")
        self.assertIn("high-gpu", gen.categorize_post(post))


@unittest.skipUnless(
    _WORKSPACE_POSTS_AVAILABLE,
    "requires workspace Reddit post markdown (gen.POSTS_DIR); absent in a bare "
    "repo checkout / CI, where load_community_configs() cannot enrich the index",
)
class TestShortAlphabeticTokenIndexCounts(unittest.TestCase):
    """Count assertions over the real index, because the unit cases above cannot
    tell you whether the boundary rule cleared exactly the bad matches or also
    swallowed the genuine SLI and ARM posts."""

    # Re-derived for the 673-entry index of 2026-08-25. high-gpu moved 67 -> 68:
    # the cycle's 1vxfd18 matches on "rtx 3090" and "3090", and that match is
    # genuine, because the author is planning a 128k-context workflow on a single
    # 24 GB RTX 3090. It is a question rather than a measurement, so the Field
    # Notes section reports the count change without attributing any throughput
    # to Gemma. Prior derivation, for the 669-entry index of 2026-08-24: high-gpu
    # moved 66 -> 67 on 1vwhj0l, which matches "3090" in a GLM-4.5-Air
    # announcement rather than a Gemma benchmark. Before that, for the 660-entry
    # index of 2026-08-19: the capacity-token rule left high-gpu at 66 (1vbw2pm
    # lost a spurious DDR match, 1u5ul4k gained a genuine "triple gpu" one).
    # August 27, 2026 adds 1vy1q1l, a single-RTX-5090 Gemma 4 12B evaluation
    # workload. It is still not a serving benchmark, but it is a genuine
    # high-end GPU card and the Field Notes section cites the 68 -> 69 move.
    HIGH_GPU_EXPECTED = 69
    # Unchanged at 14 since that same 2026-08-19 index: no post in the cycles
    # since then mentions CPU-only or Pi-class inference. It moved 10 -> 14 when
    # "on cpu" added 1vq2fk7, 1ttyzpi and 1t0k6fj, with 1vrojhv the fourth.
    CPU_ONLY_EXPECTED = 14

    def test_category_counts_over_the_real_index(self):
        configs = gen.load_community_configs()
        if not configs:
            self.skipTest("community index enrichment produced no posts (workspace data unavailable)")
        for cat, expected in (
            ("high-gpu", self.HIGH_GPU_EXPECTED),
            ("cpu-only", self.CPU_ONLY_EXPECTED),
        ):
            with self.subTest(category=cat):
                count = sum(1 for c in configs if cat in c.get("categories", []))
                self.assertEqual(
                    count,
                    expected,
                    f"{cat} post count moved; if the index grew, re-derive this "
                    "number and update the Field Notes prose that cites it",
                )

    def test_slightly_posts_left_the_high_end_gpu_chip(self):
        """1vr2oq8 matched on "freudian slip" and 1tw0lua, 1ura4d0, 1u941oi and
        1v6d2ou on "slightly" or "slight". None of the five names a GPU."""
        configs = {c.get("id"): c for c in gen.load_community_configs()}
        for post_id in ("1vr2oq8", "1tw0lua", "1ura4d0", "1u941oi", "1v6d2ou"):
            with self.subTest(post=post_id):
                self.assertIn(post_id, configs, f"{post_id} missing from the index")
                self.assertNotIn("high-gpu", configs[post_id].get("categories", []))

    def test_genuine_arm_posts_stayed_on_the_cpu_chip(self):
        """1upynpt measures CPU decode on x86 and arm, 1ta7ce9 discusses an ARM
        SoC. Both must survive the boundary rule."""
        configs = {c.get("id"): c for c in gen.load_community_configs()}
        for post_id in ("1upynpt", "1ta7ce9"):
            with self.subTest(post=post_id):
                self.assertIn(post_id, configs, f"{post_id} missing from the index")
                self.assertIn("cpu-only", configs[post_id].get("categories", []))


@unittest.skipUnless(
    _WORKSPACE_POSTS_AVAILABLE,
    "requires workspace Reddit post markdown (gen.POSTS_DIR); absent in a bare "
    "repo checkout / CI, where load_community_configs() cannot enrich the index",
)
class TestAppleSiliconIndexCount(unittest.TestCase):
    """A count assertion over the real index, because the unit cases above cannot
    tell you whether the boundary rule actually cleared the 21 bad matches or
    silently swallowed genuine Apple posts too."""

    # Re-derived for the 673-entry index of 2026-08-25, where it moved 74 -> 75.
    # The one new entry is 1vwwa62, which matches on "mac mini" and "mac ", and
    # both matches are genuine: the author runs Gemma 4 12B QAT on a 16 GB Mac
    # mini. No 2026-08-25 entry matched Apple Silicon spuriously.
    APPLE_SILICON_EXPECTED = 75

    def test_apple_silicon_count_over_the_real_index(self):
        configs = gen.load_community_configs()
        if not configs:
            self.skipTest("community index enrichment produced no posts (workspace data unavailable)")
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
