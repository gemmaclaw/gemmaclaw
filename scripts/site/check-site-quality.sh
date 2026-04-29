#!/bin/bash
# check-site-quality.sh - Regression checks for generated site output.
# Fails if raw Markdown artifacts, link dumps, or broken community cards are detected.
# Run after generate-site.py or as part of deploy-site-update.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SITE_HTML="$REPO_DIR/site/index.html"

if [ ! -f "$SITE_HTML" ]; then
  echo "FAIL: site/index.html does not exist. Run generate-site.py first."
  exit 1
fi

FAILURES=0

check() {
  local desc="$1"
  local pattern="$2"
  local count
  count=$(grep -cP "$pattern" "$SITE_HTML" 2>/dev/null || true)
  if [ "$count" -gt 0 ]; then
    echo "FAIL: $desc ($count occurrences)"
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: $desc"
  fi
}

echo "=== Gemmaclaw Site Quality Checks ==="

# 1. No raw Markdown headings in community card areas
check "No raw Markdown headings in cards" '<li>\s*#\s+'

# 2. No raw "- Score: N" lines in card content
check "No raw score lines in cards" '<li>\s*- Score:'

# 3. No numbered Reddit user/link dumps
check "No numbered Reddit user link dumps" '<li>\s*\d+\.\s+\[u/'

# 4. No bare Reddit URLs in visible card text (outside href/data attributes)
# Check for bare URLs in <p> and <li> tags (not in href= or data-search=)
bare_urls=$(grep -oP '(?<=<p class="cr-summary">)[^<]*https?://[^<]*(?=</p>)' "$SITE_HTML" 2>/dev/null | wc -l || true)
if [ "$bare_urls" -gt 0 ]; then
  echo "FAIL: Bare URLs in community card summaries ($bare_urls occurrences)"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: No bare URLs in community card summaries"
fi

# 5. No old-style community-mentions (raw <ul class="community-mentions">)
old_mentions=$(grep -c 'community-mentions' "$SITE_HTML" 2>/dev/null || true)
if [ "$old_mentions" -gt 0 ]; then
  echo "FAIL: Old-style community-mentions found ($old_mentions)"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: No old-style community-mentions markup"
fi

# 6. Community cards should have structured cr-card elements
cr_cards=$(grep -c 'class="cr-card"' "$SITE_HTML" 2>/dev/null || true)
if [ "$cr_cards" -eq 0 ]; then
  echo "WARN: No community report cards found (cr-card). Data may be missing."
else
  echo "PASS: $cr_cards community report cards found"
fi

# 7. Category filter bar should exist if community cards exist
if [ "$cr_cards" -gt 0 ]; then
  filter_bar=$(grep -c 'cat-filter-bar' "$SITE_HTML" 2>/dev/null || true)
  if [ "$filter_bar" -eq 0 ]; then
    echo "FAIL: Community cards exist but no category filter bar"
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: Category filter bar present"
  fi
fi

# 8. Core site sections must exist
for section in "setup" "hosting" "benchmarks" "goals"; do
  if grep -q "id=\"$section\"" "$SITE_HTML"; then
    echo "PASS: Section #$section present"
  else
    echo "FAIL: Section #$section missing"
    FAILURES=$((FAILURES + 1))
  fi
done

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "FAILED: $FAILURES check(s) failed"
  exit 1
else
  echo "ALL CHECKS PASSED"
fi
