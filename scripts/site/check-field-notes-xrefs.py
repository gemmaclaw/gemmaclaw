#!/usr/bin/env python3
"""Cross-reference guard for site/data/field-notes.md.

Field Notes sections regularly point back at earlier sections by date ("the
June 12 section of this page already reported that pair", "covered by this
page on July 8"). A wrong date sends a reader to a section that never said the
thing. The 2026-10-06 section shipped "The July 11 section carried the May 24
comparison thread 1tmbola" when the thread is in the May 25 and May 27
sections, and the same mistake had been repeated in more than twenty earlier
sections.

The cause was mechanical. Headings from 2026-07-11 onward are written
"## Field Notes - <date>", while the older ones put an em dash where the hyphen is.
Splitting on the hyphen form alone folds every older section into the
2026-07-11 chunk, so anything found in that chunk looked as if it were in the
July 11 section. This guard splits on every dash style and refuses a heading it
cannot parse, so that a third style cannot cause the same merge silently.

Checks:
  * every "## Field Notes" heading parses, and no date appears twice;
  * every dated reference names a section that exists and is older than the
    section that cites it;
  * a reference is supported when the sentence holding it cites a post that
    an earlier section covers: at least one such post must appear in a
    referenced section.

The third check cannot judge a reference whose sentence cites no post ("the
September 8 section derived the 5.2 to 78 band"). Those still need reading by
hand. Run:
    python3 scripts/site/check-field-notes-xrefs.py [path]
Exit 0 when clean, 1 when any reference fails.
"""
import datetime
import re
import sys
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent.parent
FIELD_NOTES = REPO_DIR / "site" / "data" / "field-notes.md"

# Hyphen-minus, the Unicode hyphen and dash block (U+2010 to U+2015, which
# covers the en and em dash) all appear, or could, between "Field Notes" and
# the date.
HEADING_RE = re.compile(r"^## Field Notes\s+[-\u2010-\u2015]\s+(\d{4}-\d{2}-\d{2})\s*$", re.M)
ANY_FIELD_NOTES_HEADING_RE = re.compile(r"^## Field Notes\b.*$", re.M)

MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]
_MONTH_ALT = "|".join(MONTHS)
_DATE = r"\**(?:(?:%s)\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2})\**" % _MONTH_ALT
_DATE_LIST = r"%s(?:(?:,\s*and\s+|,\s*|\s+and\s+)%s)*" % (_DATE, _DATE)
_PAGE_VERB = (
    r"(?:carried|carries|carry|carrying|covered|recorded|cited|published|"
    r"reported|warned|noted|filed|asked|logged|flagged)"
)

# Each form captures the date list in group 1.
REFERENCE_FORMS = [
    # "the June 12 section", "the August 25 and August 28 sections",
    # "its **July 8** section", "the 2026-05-17 section's own statement"
    re.compile(r"(?<![\w-])(%s)\s+sections?\b" % _DATE_LIST),
    # "this page has carried since July 8", "this page published on September 11"
    re.compile(
        r"\b[Tt]his (?:page|tracker)\b(?:\s+\w+){0,3}?\s+%s\b[^.;]{0,40}?\b(?:on|since)\s+(%s)"
        % (_PAGE_VERB, _DATE_LIST)
    ),
    # "covered by this page on July 8"
    re.compile(r"\bby this (?:page|tracker) (?:on|since)\s+(%s)" % _DATE_LIST),
    # "six earlier sections of this page attach to it, the earliest of them on June 7, 2026"
    re.compile(r"\bearliest of them on\s+(%s)" % _DATE_LIST),
]

# A linked post, or a bare post id in prose ("1tmbola", "1u355x2"). A bare id
# must carry a letter, so a plain number such as 1080000 is never read as one.
POST_ID_RE = re.compile(
    r"(?:reddit\.com/r/\w+/comments/|(?<![\w/.-]))(1(?=[a-z0-9]{6}(?![\w]))(?=[0-9]*[a-z])[a-z0-9]{6})(?![\w])"
)
SENTENCE_BREAK_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z*\[(_])")

# Reviewed references the sentence-level rule flags although they are right.
# Key: (citing section, matched reference text, post id the rule tripped on).
KNOWN_SUPPORTED = {
    # The sentence compares 1t0kxdw and 1wnot97, then separately says the
    # expert-offload route the September 21 section was built around spends
    # system RAM. The reference is to that route, which the September 21
    # section covers; it makes no claim that 1t0kxdw is there.
    ("2026-09-23", "September 21 section", "1t0kxdw"),
}


class FieldNotesError(ValueError):
    pass


def split_sections(md_text):
    """Return an ordered list of (date, body) for every Field Notes section.

    Raises FieldNotesError on a heading that does not parse or a repeated date,
    because either one silently merges or shadows a section.
    """
    parsed = {m.start() for m in HEADING_RE.finditer(md_text)}
    for m in ANY_FIELD_NOTES_HEADING_RE.finditer(md_text):
        if m.start() not in parsed:
            raise FieldNotesError("unparseable Field Notes heading: %r" % m.group(0))
    heads = list(HEADING_RE.finditer(md_text))
    sections = []
    seen = set()
    for i, m in enumerate(heads):
        date = m.group(1)
        if date in seen:
            raise FieldNotesError("duplicate Field Notes section date: %s" % date)
        seen.add(date)
        end = heads[i + 1].start() if i + 1 < len(heads) else len(md_text)
        sections.append((date, md_text[m.end():end]))
    return sections


def parse_date_list(text, citing_date):
    """Resolve "May 25 and May 27" or "2026-06-12, 2026-09-01" to ISO dates.

    A bare day ("May 25 and 27") inherits the previous month. A month-day with
    no year takes the citing section's year, stepping back a year only when
    that would put it more than half a year after the citing section ("December
    30" cited in January). A nearer future date is left alone so that the
    later-section check can report it.
    """
    citing = datetime.date.fromisoformat(citing_date)
    out = []
    month = None
    year = None
    token_re = re.compile(
        r"(%s)\s+(\d{1,2})(?:,\s*(\d{4}))?|(\d{4})-(\d{2})-(\d{2})|\b(\d{1,2})\b" % _MONTH_ALT
    )
    for tok in token_re.finditer(text.replace("*", "")):
        if tok.group(1):
            month = MONTHS.index(tok.group(1)) + 1
            day = int(tok.group(2))
            if tok.group(3):
                year = int(tok.group(3))
            else:
                year = citing.year
                if (datetime.date(year, month, day) - citing).days > 183:
                    year -= 1
        elif tok.group(4):
            year, month, day = int(tok.group(4)), int(tok.group(5)), int(tok.group(6))
        elif tok.group(7) and month:
            day = int(tok.group(7))
        else:
            continue
        out.append(datetime.date(year, month, day).isoformat())
    return out


def _sentence_bounds(line, start, end):
    lo = 0
    hi = len(line)
    for b in SENTENCE_BREAK_RE.finditer(line):
        if b.end() <= start:
            lo = b.end()
        elif b.start() >= end:
            hi = b.start()
            break
    return lo, hi


def find_references(sections):
    """Yield dicts describing every dated section reference."""
    for date, body in sections:
        for line in body.split("\n"):
            seen_spans = set()
            for form in REFERENCE_FORMS:
                for m in form.finditer(line):
                    raw = m.group(1)
                    if not re.search(r"%s|\d{4}-" % _MONTH_ALT, raw):
                        continue
                    span = (m.start(1), m.end(1))
                    if span in seen_spans:
                        continue
                    seen_spans.add(span)
                    targets = [d for d in parse_date_list(raw, date) if d != date]
                    if not targets:
                        continue
                    lo, hi = _sentence_bounds(line, m.start(), m.end())
                    yield {
                        "section": date,
                        "text": m.group(0),
                        "targets": targets,
                        "sentence": line[lo:hi],
                    }


def check(md_text):
    """Return a list of human-readable problems; empty means clean."""
    sections = split_sections(md_text)
    bodies = dict(sections)
    order = [d for d, _ in sections]
    problems = []
    for ref in find_references(sections):
        citing = ref["section"]
        for target in ref["targets"]:
            if target not in bodies:
                problems.append(
                    "%s: %r names a section that does not exist (%s)" % (citing, ref["text"], target)
                )
            elif target > citing:
                problems.append(
                    "%s: %r names a later section (%s)" % (citing, ref["text"], target)
                )
        targets = [t for t in ref["targets"] if t in bodies and t < citing]
        if not targets:
            continue
        earlier = [d for d in order if d < citing]
        cited = sorted(set(POST_ID_RE.findall(ref["sentence"])))
        covered_earlier = [i for i in cited if any(i in bodies[d] for d in earlier)]
        if not covered_earlier:
            continue
        if any(i in bodies[t] for i in covered_earlier for t in targets):
            continue
        if any((citing, ref["text"].strip("* "), i) in KNOWN_SUPPORTED for i in covered_earlier):
            continue
        where = {
            i: [d for d in earlier if i in bodies[d]] for i in covered_earlier
        }
        problems.append(
            "%s: %r cites %s, none of which the referenced section(s) %s carry; "
            "earlier sections that do: %s"
            % (citing, ref["text"], ", ".join(covered_earlier), ", ".join(targets),
               "; ".join("%s in %s" % (i, ", ".join(ds)) for i, ds in where.items()))
        )
    return problems


def main(argv):
    path = Path(argv[1]) if len(argv) > 1 else FIELD_NOTES
    try:
        problems = check(path.read_text(encoding="utf-8"))
    except FieldNotesError as exc:
        print("FAIL: %s" % exc)
        return 1
    if problems:
        for p in problems:
            print("FAIL: %s" % p)
        print("FAILED: %d Field Notes cross-reference problem(s) in %s" % (len(problems), path))
        return 1
    print("PASS: Field Notes section cross-references resolve (%s)" % path.name)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
