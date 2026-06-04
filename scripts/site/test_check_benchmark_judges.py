#!/usr/bin/env python3
"""Tests for the public-benchmark judge/speed guard (check-benchmark-judges.py).

Proves the guard FAILS LOUDLY on a disallowed authoritative judge (e.g. GPT-4.1
via OpenAI API, Gemini CLI) and on a non-measured published generation TPS, and
PASSES on a clean cc-acp run. Pure stdlib.
    python3 scripts/site/test_check_benchmark_judges.py
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

GUARD_PATH = Path(__file__).resolve().parent / "check-benchmark-judges.py"


def _load():
    spec = importlib.util.spec_from_file_location("judge_guard_under_test", GUARD_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


guard = _load()


def _write_eval(edir, name, judge, top_level=False):
    edir.mkdir(parents=True, exist_ok=True)
    if top_level:
        body = dict(judge)
    else:
        body = {"taskId": name, "llmJudge": judge}
    (edir / f"{name}.json").write_text(json.dumps(body))


def _write_meta(rdir, gpu):
    rdir.mkdir(parents=True, exist_ok=True)
    (rdir / "metadata.json").write_text(json.dumps({"hardware": {"gpu": gpu}}))


class GuardDetection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.evald = self.root / "evaluations"
        self.runsd = self.root / "runs"

    def tearDown(self):
        self.tmp.cleanup()

    def test_disallowed_openai_judge_is_violation(self):
        _write_eval(self.evald / "run-a", "task1",
                    {"provider": "openai", "model": "gpt-4.1", "authoritative": True})
        v, w, n = guard.scan({"run-a"}, self.evald, self.runsd)
        self.assertEqual(n, 1)
        self.assertTrue(any("openai" in x and "DISALLOWED" in x for x in v), v)

    def test_gemini_cli_judge_is_violation(self):
        _write_eval(self.evald / "run-b", "task1",
                    {"provider": "gemini-cli", "model": "gemini-2.5-pro", "authoritative": True})
        v, _, _ = guard.scan({"run-b"}, self.evald, self.runsd)
        self.assertTrue(any("gemini-cli" in x for x in v), v)

    def test_cc_acp_judge_passes(self):
        _write_eval(self.evald / "run-c", "task1",
                    {"provider": "cc-acp", "model": "claude-opus-4-8", "authoritative": True})
        v, _, _ = guard.scan({"run-c"}, self.evald, self.runsd)
        self.assertEqual(v, [])

    def test_top_level_judge_layout_detected(self):
        # functiongemma-style: judge fields at the eval top level.
        _write_eval(self.evald / "run-d", "task1",
                    {"judgeProvider": "openai", "judgeModel": "gpt-4.1", "authoritative": True},
                    top_level=True)
        v, _, _ = guard.scan({"run-d"}, self.evald, self.runsd)
        self.assertTrue(any("openai" in x for x in v), v)

    def test_non_authoritative_disallowed_judge_is_ok(self):
        # Historical/exploratory non-authoritative judgments are allowed.
        _write_eval(self.evald / "run-e", "task1",
                    {"provider": "openai", "model": "gpt-4.1", "authoritative": False})
        v, _, _ = guard.scan({"run-e"}, self.evald, self.runsd)
        self.assertEqual(v, [])

    def test_non_measured_tps_is_violation(self):
        _write_eval(self.evald / "run-f", "task1",
                    {"provider": "cc-acp", "authoritative": True})
        _write_meta(self.runsd / "run-f",
                    {"generationTokensPerSecond": 1.3, "generationTokensPerSecondSource": "effective-output"})
        v, _, _ = guard.scan({"run-f"}, self.evald, self.runsd)
        self.assertTrue(any("non-measured source" in x for x in v), v)

    def test_measured_tps_passes(self):
        _write_eval(self.evald / "run-g", "task1",
                    {"provider": "cc-acp", "authoritative": True})
        _write_meta(self.runsd / "run-g",
                    {"generationTokensPerSecond": 70.6, "generationTokensPerSecondSource": "measured-llamacpp"})
        v, _, _ = guard.scan({"run-g"}, self.evald, self.runsd)
        self.assertEqual(v, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
