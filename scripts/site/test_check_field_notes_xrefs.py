#!/usr/bin/env python3
"""Tests for the Field Notes cross-reference guard (check-field-notes-xrefs.py).

Pure stdlib.
    python3 scripts/site/test_check_field_notes_xrefs.py
"""
import importlib.util
import re
import unittest
from pathlib import Path

GUARD_PATH = Path(__file__).resolve().parent / "check-field-notes-xrefs.py"


def _load():
    spec = importlib.util.spec_from_file_location("field_notes_xrefs_under_test", GUARD_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


guard = _load()
EM = "\u2014"
EN = "\u2013"

# Newest first, as the real file is: two hyphen headings above two em-dash ones.
SAMPLE = (
    "## Field Notes - 2026-10-06\n\n"
    "- The May 25 and May 27 sections carried the comparison thread "
    "[1tmbola](https://reddit.com/r/localllama/comments/1tmbola).\n\n"
    "## Field Notes - 2026-07-11\n\n"
    "An M5 Max MLX run [1urjg9o](https://reddit.com/r/localllama/comments/1urjg9o).\n\n"
    "## Field Notes " + EM + " 2026-05-27\n\n"
    "The thread [1tmbola](https://reddit.com/r/LocalLLaMA/comments/1tmbola) kept growing.\n\n"
    "## Field Notes " + EM + " 2026-05-25\n\n"
    "Gemma for RP, Qwen for everything else ([source](https://reddit.com/r/LocalLLaMA/comments/1tmbola)).\n"
)


def _with_newest(sentence):
    """SAMPLE with the 2026-10-06 bullet replaced by `sentence`."""
    head, rest = SAMPLE.split("## Field Notes - 2026-07-11", 1)
    return "## Field Notes - 2026-10-06\n\n- " + sentence + "\n\n## Field Notes - 2026-07-11" + rest


class TestSplitSections(unittest.TestCase):
    def test_every_dash_style_starts_a_section(self):
        text = (
            "## Field Notes - 2026-07-11\nA\n"
            "## Field Notes " + EN + " 2026-07-10\nB\n"
            "## Field Notes " + EM + " 2026-07-09\nC\n"
        )
        sections = guard.split_sections(text)
        self.assertEqual([d for d, _ in sections], ["2026-07-11", "2026-07-10", "2026-07-09"])
        self.assertEqual([b.strip() for _, b in sections], ["A", "B", "C"])

    def test_hyphen_only_split_merges_older_sections_into_july_11(self):
        # Negative control: the split that caused the 2026-10-06 defect. With
        # it, the em-dash May sections land inside the 2026-07-11 chunk, so
        # 1tmbola appears to be "in the July 11 section".
        hyphen_only = re.compile(r"^## Field Notes - (\d{4}-\d{2}-\d{2})\s*$", re.M)
        heads = list(hyphen_only.finditer(SAMPLE))
        july_chunk = SAMPLE[heads[1].end():]
        self.assertEqual(len(heads), 2)
        self.assertIn("1tmbola", july_chunk)
        sections = dict(guard.split_sections(SAMPLE))
        self.assertEqual(len(sections), 4)
        self.assertNotIn("1tmbola", sections["2026-07-11"])

    def test_unparseable_heading_is_refused(self):
        with self.assertRaises(guard.FieldNotesError):
            guard.split_sections("## Field Notes: 2026-07-11\nA\n")

    def test_duplicate_date_is_refused(self):
        with self.assertRaises(guard.FieldNotesError):
            guard.split_sections("## Field Notes - 2026-07-11\nA\n## Field Notes " + EM + " 2026-07-11\nB\n")

    def test_section_bodies_contain_no_field_notes_heading(self):
        text = guard.FIELD_NOTES.read_text(encoding="utf-8")
        for date, body in guard.split_sections(text):
            self.assertNotRegex(body, r"(?m)^## Field Notes", date)


class TestParseDateList(unittest.TestCase):
    def test_lists_and_shared_months(self):
        self.assertEqual(guard.parse_date_list("May 25 and May 27", "2026-10-06"), ["2026-05-25", "2026-05-27"])
        self.assertEqual(guard.parse_date_list("May 25 and 27", "2026-10-06"), ["2026-05-25", "2026-05-27"])
        self.assertEqual(
            guard.parse_date_list("2026-06-12, 2026-09-01, 2026-09-03 and 2026-09-11", "2026-09-15"),
            ["2026-06-12", "2026-09-01", "2026-09-03", "2026-09-11"],
        )
        self.assertEqual(guard.parse_date_list("**July 8**", "2026-09-24"), ["2026-07-08"])

    def test_month_day_after_the_citing_date_belongs_to_the_previous_year(self):
        self.assertEqual(guard.parse_date_list("December 30", "2027-01-02"), ["2026-12-30"])


class TestCheck(unittest.TestCase):
    def test_sample_is_clean(self):
        self.assertEqual(guard.check(SAMPLE), [])

    def test_the_shipped_2026_10_06_sentence_is_flagged(self):
        bad = _with_newest(
            "The July 11 section carried the May 24 comparison thread "
            "[1tmbola](https://reddit.com/r/localllama/comments/1tmbola)."
        )
        problems = guard.check(bad)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("2026-07-11", problems[0])
        self.assertIn("2026-05-25", problems[0])

    def test_one_correct_target_in_a_list_is_enough(self):
        ok = _with_newest("The May 25 and July 11 sections both mention 1tmbola.")
        self.assertEqual(guard.check(ok), [])

    def test_free_form_references_are_checked(self):
        for sentence in (
            "This page has carried 1tmbola since July 11.",
            "1tmbola, covered by this page on July 11.",
            "1tmbola, carried with caveats, the earliest of them on July 11, 2026.",
            "1tmbola, cited since its **July 11** section.",
        ):
            with self.subTest(sentence=sentence):
                self.assertEqual(len(guard.check(_with_newest(sentence))), 1, sentence)

    def test_missing_and_later_sections_are_flagged(self):
        missing = guard.check(_with_newest("The June 3 section said nothing."))
        self.assertEqual(len(missing), 1)
        self.assertIn("does not exist", missing[0])
        text = SAMPLE.replace("Gemma for RP", "The July 11 section later disagreed. Gemma for RP")
        later = guard.check(text)
        self.assertEqual(len(later), 1)
        self.assertIn("later section", later[0])

    def test_a_post_date_is_not_a_section_reference(self):
        ok = _with_newest(
            "[1tmbola](https://reddit.com/r/localllama/comments/1tmbola) "
            "(May 24, 2026, u/MarcCDB, posted on July 11 in a repost)."
        )
        self.assertEqual(guard.check(ok), [])

    def test_a_sentence_citing_only_new_posts_is_not_judged(self):
        ok = _with_newest("The July 11 section is unrelated to 1zzzzzz, which is new.")
        self.assertEqual(guard.check(ok), [])

    def test_bare_numbers_are_not_post_ids(self):
        self.assertEqual(guard.POST_ID_RE.findall("a 1080000 token run and 1tmbola"), ["1tmbola"])


class TestRepositoryFieldNotes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = guard.FIELD_NOTES.read_text(encoding="utf-8")
        cls.sections = dict(guard.split_sections(cls.text))

    def test_every_cross_reference_resolves(self):
        self.assertEqual(guard.check(self.text), [])

    def test_2026_10_06_names_the_sections_that_carry_1tmbola(self):
        body = self.sections["2026-10-06"]
        self.assertNotIn("The July 11 section carried", body)
        self.assertIn("The May 25 and May 27 sections carried the May 24 comparison thread", body)
        self.assertNotIn("1tmbola", self.sections["2026-07-11"])
        self.assertIn("Gemma for RP, Qwen for everything else", self.sections["2026-05-25"])
        self.assertIn("for non-coding Gemma is better", self.sections["2026-05-25"])
        self.assertIn("1tmbola", self.sections["2026-05-27"])

    def test_restoring_the_old_sentence_fails_the_guard(self):
        # Mutation control on the real file, not only the sample.
        reverted = self.text.replace(
            "The May 25 and May 27 sections carried the May 24 comparison thread",
            "The July 11 section carried the May 24 comparison thread",
        )
        self.assertNotEqual(reverted, self.text)
        problems = guard.check(reverted)
        self.assertEqual(len(problems), 1, problems)
        self.assertTrue(problems[0].startswith("2026-10-06:"))

    def test_main_exit_codes(self):
        self.assertEqual(guard.main(["x"]), 0)


if __name__ == "__main__":
    unittest.main()
