#!/usr/bin/env python3
"""Copy the community hardware-config index into site/data/, sanitizing dashes.

Split out of the inline Python block in deploy-site-update.sh so the sanitizer is
callable from a test with a fixture instead of only from the cron path, which
first insists on a clean main checkout and a rebase against origin.

WHY THIS WORKS ON THE DECODED FORM. The extractor
(skills/reddit/scripts/gemma4-extract.sh) writes the knowledge JSON with
json.dump(..., ensure_ascii=True), so an em dash in a Reddit excerpt reaches disk
as the six ASCII characters backslash, u, 2, 0, 1, 4. The previous version of
this step read the file as TEXT and called str.translate() on it. translate()
maps decoded code points, and the file text holds no such code point, so every
dash passed through untouched and the step's "sanitized" log line was false for
the whole life of the script. Loading the JSON first is what puts the real
character in front of the translate table.

    python3 scripts/site/copy-community-data.py <src> <dst>
"""
import json
import sys

# Typographic dash code points -> ASCII hyphen. Listed numerically (not as literal
# characters) so this script itself stays free of typographic dashes. Kept in step
# with _TYPOGRAPHIC_DASH_CODEPOINTS in generate-site.py.
DASH_CODEPOINTS = (
    0x2010, 0x2011, 0x2012, 0x2013, 0x2014,
    0x2015, 0x2043, 0x2E3A, 0x2E3B, 0x2212,
)
DASH_MAP = {cp: "-" for cp in DASH_CODEPOINTS}


def sanitize(node):
    """Recursively map typographic dashes to hyphens in every string in `node`.

    Dict keys are walked as well as values: the schema uses fixed ASCII keys
    today, but a dash arriving in a key would otherwise be the one string the
    sweep missed.
    """
    if isinstance(node, str):
        return node.translate(DASH_MAP)
    if isinstance(node, list):
        return [sanitize(item) for item in node]
    if isinstance(node, dict):
        return {sanitize(k): sanitize(v) for k, v in node.items()}
    return node


def serialize(data):
    """Render `data` in the extractor's one-row-per-line shape.

    WHY NOT indent=2. The repo formatter (oxfmt) decides per object whether to
    collapse it onto one line, and like prettier it honours the input's own line
    break after the brace: an object the author already expanded stays expanded.
    The extractor writes this file one row per line, so oxfmt collapses the short
    rows, and that is the layout committed at site/data today (204 collapsed and
    500 expanded across 704 rows). Handing oxfmt a fully expanded indent=2 file
    instead pins all 704 rows open. Measured against the committed file using its
    own rows with dashes sanitized on both sides, so only the layout varies: one
    row per line differs by 164 lines (the dash rows themselves), indent=2 by
    1390. Keeping the source's shape is what makes this fix a dash-only diff.
    """
    if not isinstance(data, list):
        return json.dumps(data) + "\n"
    if not data:
        return "[]\n"
    return "[\n" + ",\n".join("  " + json.dumps(row) for row in data) + "\n]\n"


def copy_community_data(src, dst):
    """Load `src`, sanitize decoded strings, write `dst`. Returns the data."""
    with open(src, encoding="utf-8") as f:
        data = json.load(f)
    data = sanitize(data)
    # ensure_ascii stays at its default True, matching the extractor, so the file
    # on disk is pure ASCII and no consumer has to guess an encoding.
    with open(dst, "w", encoding="utf-8") as f:
        f.write(serialize(data))
    return data


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: copy-community-data.py <src> <dst>", file=sys.stderr)
        sys.exit(2)
    copy_community_data(sys.argv[1], sys.argv[2])
