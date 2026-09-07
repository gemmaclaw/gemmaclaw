#!/usr/bin/env python3
"""Regression tests for the site-data copy step's dash sanitizer.

Guards the defect fixed on 2026-09-07: the copy step read the knowledge JSON as
text and called str.translate() on it, but the extractor writes that file with
ensure_ascii=True, so every typographic dash is stored as a \\uXXXX escape and no
dash code point exists in the file text for translate() to match. The step logged
"dash-sanitized" while changing nothing, for the whole life of the script.

The fixture below is written with json.dump(..., ensure_ascii=True) precisely so
it reproduces that on-disk shape. A test that wrote literal dashes would pass
against the broken script and prove nothing.

Pure stdlib (unittest), matching test_generate_site.py:
    python3 scripts/site/test_copy_community_data.py
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MOD_PATH = Path(__file__).resolve().parent / "copy-community-data.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("copy_community_data_under_test", MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


copier = _load_module()

# The same ten code points the site generator normalizes.
DASH_CHARS = {chr(cp) for cp in copier.DASH_CODEPOINTS}

# Built from code points rather than typed literally, so this test file itself
# stays clean under scripts/check-no-typographic-dashes.sh, which scans literal
# characters on added lines.
EM_DASH = chr(0x2014)
EN_DASH = chr(0x2013)
MINUS_SIGN = chr(0x2212)


def _walk_strings(node):
    """Yield every string in a decoded JSON structure, keys included."""
    if isinstance(node, str):
        yield node
    elif isinstance(node, list):
        for item in node:
            yield from _walk_strings(item)
    elif isinstance(node, dict):
        for key, value in node.items():
            yield from _walk_strings(key)
            yield from _walk_strings(value)


def _dashes_in(node):
    return {ch for s in _walk_strings(node) for ch in s if ch in DASH_CHARS}


class DecodedDashSanitizerTest(unittest.TestCase):
    """The copy step must sanitize what json.load() decodes, not the file text."""

    def _fixture(self, tmpdir):
        """A source file shaped exactly like the real extractor's output.

        gemma4-extract.sh emits one row per line inside a bracketed array, with
        ensure_ascii on, so every typographic dash reaches disk as a \\uXXXX
        escape. Both halves matter: the escape is what the old text-level
        translate() could not see, and the one-row-per-line shape is the layout
        the committed site copy is formatted from.
        """
        data = [
            {
                "post": "1abcdef",
                "file": "1abcdef.md",
                "hardware_mentions": [
                    # em dash, en dash and minus sign, as the acceptance requires.
                    "3090 %s 24GB VRAM, runs 26B at q4" % EM_DASH,
                    "budget build %s two P40s" % EN_DASH,
                    "delta was %s2 tok/s after the update" % MINUS_SIGN,
                ],
            },
            {"post": "2bcdefg", "file": "2bcdefg.md", "hardware_mentions": ["- Score: 20"]},
        ]
        src = Path(tmpdir) / "gemma4-hardware-configs.json"
        rows = ",\n".join("  " + json.dumps(row, ensure_ascii=True) for row in data)
        src.write_text("[\n" + rows + "\n]\n", encoding="utf-8")
        return src

    def test_fixture_stores_escapes_not_literal_dashes(self):
        """Pins the premise the whole defect rests on.

        If this ever fails the extractor stopped writing ensure_ascii=True, and
        the rest of this file is testing a shape that no longer reaches the copy
        step.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            raw = self._fixture(tmpdir).read_text(encoding="utf-8")
            self.assertEqual(raw.count(EM_DASH), 0, "fixture should hold no literal em dash")
            self.assertIn("\\u2014", raw, "fixture should hold the escaped form")
            self.assertIn("\\u2013", raw)
            self.assertIn("\\u2212", raw)

    def test_copy_strips_every_dash_from_the_decoded_output(self):
        """The assertion that goes red against the pre-2026-09-07 script."""
        with tempfile.TemporaryDirectory() as tmpdir:
            src = self._fixture(tmpdir)
            dst = Path(tmpdir) / "out.json"
            copier.copy_community_data(src, dst)

            with open(dst, encoding="utf-8") as f:
                loaded = json.load(f)

            self.assertEqual(
                _dashes_in(loaded), set(),
                "decoded output still carries typographic dashes",
            )
            # The escaped form must be gone from the file text too, which is what
            # the old text-level translate() left behind.
            raw = dst.read_text(encoding="utf-8")
            for cp in copier.DASH_CODEPOINTS:
                self.assertNotIn("\\u%04x" % cp, raw.lower())

    def test_readable_text_survives_the_substitution(self):
        """A dash becomes a hyphen; no word is dropped."""
        with tempfile.TemporaryDirectory() as tmpdir:
            src = self._fixture(tmpdir)
            dst = Path(tmpdir) / "out.json"
            copier.copy_community_data(src, dst)
            with open(dst, encoding="utf-8") as f:
                mentions = json.load(f)[0]["hardware_mentions"]

            self.assertEqual(mentions[0], "3090 - 24GB VRAM, runs 26B at q4")
            self.assertEqual(mentions[1], "budget build - two P40s")
            self.assertEqual(mentions[2], "delta was -2 tok/s after the update")

    def test_non_string_scalars_are_preserved(self):
        """Scores and flags must not be stringified by the walk."""
        with tempfile.TemporaryDirectory() as tmpdir:
            src = Path(tmpdir) / "in.json"
            dst = Path(tmpdir) / "out.json"
            with open(src, "w", encoding="utf-8") as f:
                json.dump(
                    [{"post": "x", "score": 42, "ok": True, "none": None, "f": 1.5}],
                    f, indent=2, ensure_ascii=True,
                )
            copier.copy_community_data(src, dst)
            with open(dst, encoding="utf-8") as f:
                row = json.load(f)[0]
            self.assertEqual(row["score"], 42)
            self.assertIs(row["ok"], True)
            self.assertIsNone(row["none"])
            self.assertEqual(row["f"], 1.5)

    def test_output_layout_matches_the_committed_format(self):
        """One row per line, ensure_ascii on, trailing newline.

        The repo formatter honours the input's own line break after a brace, so
        the serialization the copy step chooses decides how oxfmt lays the file
        out. Writing the extractor's one-row-per-line shape is what lets oxfmt
        collapse the short rows the way the committed site copy already is;
        indent=2 would pin all 704 rows open and turn a 164-line dash diff into a
        1390-line reflow.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            src = self._fixture(tmpdir)
            dst = Path(tmpdir) / "out.json"
            copier.copy_community_data(src, dst)
            raw = dst.read_text(encoding="utf-8")
            lines = raw.splitlines()
            self.assertEqual(lines[0], "[", "array should open on its own line")
            self.assertEqual(lines[-1], "]", "array should close on its own line")
            # One row per line: 2 fixture rows plus the two bracket lines.
            self.assertEqual(len(lines), 4, "expected one row per line")
            for line in lines[1:-1]:
                self.assertTrue(line.startswith('  {"post": '), line[:40])
            self.assertTrue(raw.endswith("\n"), "expected a trailing newline")
            # ensure_ascii stays on: every non-ASCII byte stays escaped.
            self.assertTrue(raw.isascii(), "output should be pure ASCII")

    def test_serialize_normalizes_an_expanded_source(self):
        """The shape is chosen by the copy step, not inherited from the source.

        Guards against a future revert to a pass-through writer: an indent=2
        input must still come out one row per line.
        """
        expanded = json.dumps([{"post": "x", "hardware_mentions": ["a"]}], indent=2)
        out = copier.serialize(json.loads(expanded))
        self.assertEqual(
            out, '[\n  {"post": "x", "hardware_mentions": ["a"]}\n]\n',
        )
        self.assertEqual(copier.serialize([]), "[]\n")

    def test_sanitize_covers_dict_keys(self):
        out = copier.sanitize({"a%sb" % EM_DASH: ["c%sd" % EN_DASH]})
        self.assertEqual(out, {"a-b": ["c-d"]})


if __name__ == "__main__":
    unittest.main(verbosity=2)
