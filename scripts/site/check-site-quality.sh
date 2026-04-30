#!/bin/bash
# check-site-quality.sh - Regression checks for generated multi-page site output.
# Fails if required pages are missing, raw Markdown artifacts, or broken community cards.
# Run after generate-site.py or as part of deploy-site-update.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SITE_DIR="$REPO_DIR/site"

FAILURES=0

# Verify all required pages exist
REQUIRED_PAGES="index.html setup.html self-hosting.html benchmarks.html community.html goals.html"
for page in $REQUIRED_PAGES; do
  if [ ! -f "$SITE_DIR/$page" ]; then
    echo "FAIL: $page does not exist. Run generate-site.py first."
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: $page exists"
  fi
done

if [ "$FAILURES" -gt 0 ]; then
  echo ""
  echo "FAILED: Missing required pages"
  exit 1
fi

check() {
  local desc="$1"
  local pattern="$2"
  local file="$3"
  local count
  count=$(grep -cP "$pattern" "$file" 2>/dev/null || true)
  if [ "$count" -gt 0 ]; then
    echo "FAIL: $desc in $(basename "$file") ($count occurrences)"
    FAILURES=$((FAILURES + 1))
  fi
}

echo ""
echo "=== Gemmaclaw Site Quality Checks ==="

# Check community.html for quality issues
COMMUNITY_HTML="$SITE_DIR/community.html"
if [ -f "$COMMUNITY_HTML" ]; then
  check "Raw Markdown headings in cards" '<li>\s*#\s+' "$COMMUNITY_HTML"
  check "Raw score lines in cards" '<li>\s*- Score:' "$COMMUNITY_HTML"
  check "Numbered Reddit user link dumps" '<li>\s*\d+\.\s+\[u/' "$COMMUNITY_HTML"
  echo "PASS: No raw Markdown artifacts in community cards"

  bare_urls=$(grep -oP '(?<=<p class="cr-summary">)[^<]*https?://[^<]*(?=</p>)' "$COMMUNITY_HTML" 2>/dev/null | wc -l || true)
  if [ "$bare_urls" -gt 0 ]; then
    echo "FAIL: Bare URLs in community card summaries ($bare_urls occurrences)"
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: No bare URLs in community card summaries"
  fi

  old_mentions=$(grep -c 'community-mentions' "$COMMUNITY_HTML" 2>/dev/null || true)
  if [ "$old_mentions" -gt 0 ]; then
    echo "FAIL: Old-style community-mentions found ($old_mentions)"
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: No old-style community-mentions markup"
  fi

  cr_cards=$(grep -c 'class="cr-card"' "$COMMUNITY_HTML" 2>/dev/null || true)
  if [ "$cr_cards" -eq 0 ]; then
    echo "WARN: No community report cards found (cr-card). Data may be missing."
  else
    echo "PASS: $cr_cards community report cards found"
  fi

  if [ "$cr_cards" -gt 0 ]; then
    filter_bar=$(grep -c 'cat-filter-bar' "$COMMUNITY_HTML" 2>/dev/null || true)
    if [ "$filter_bar" -eq 0 ]; then
      echo "FAIL: Community cards exist but no category filter bar"
      FAILURES=$((FAILURES + 1))
    else
      echo "PASS: Category filter bar present"
    fi
  fi
fi

# Verify key content sections in each page
echo ""
echo "--- Page content checks ---"

declare -A SECTION_CHECKS=(
  ["setup.html"]="setup"
  ["self-hosting.html"]="hosting"
  ["benchmarks.html"]="benchmarks"
  ["goals.html"]="goals"
)

for page in "${!SECTION_CHECKS[@]}"; do
  section="${SECTION_CHECKS[$page]}"
  if grep -q "id=\"$section\"" "$SITE_DIR/$page"; then
    echo "PASS: Section #$section present in $page"
  else
    echo "FAIL: Section #$section missing from $page"
    FAILURES=$((FAILURES + 1))
  fi
done

# All pages must have shared nav
echo ""
echo "--- Navigation checks ---"
for page in $REQUIRED_PAGES; do
  if grep -q 'class="topnav"' "$SITE_DIR/$page"; then
    echo "PASS: Navigation present in $page"
  else
    echo "FAIL: Navigation missing from $page"
    FAILURES=$((FAILURES + 1))
  fi
done

# Nav links should point to pages, not anchors
echo ""
echo "--- Cross-page link checks ---"
anchor_nav_total=0
for page in $REQUIRED_PAGES; do
  anchor_count=$(grep -oP 'class="nav-links"[^>]*>.*?</div>' "$SITE_DIR/$page" 2>/dev/null | grep -oP 'href="#[^"]*"' | wc -l || true)
  anchor_nav_total=$((anchor_nav_total + anchor_count))
done
if [ "$anchor_nav_total" -gt 0 ]; then
  echo "FAIL: Found $anchor_nav_total anchor-scroll nav links (should be page links)"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: No anchor-scroll nav links found"
fi

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "FAILED: $FAILURES check(s) failed"
  exit 1
else
  echo "ALL CHECKS PASSED"
fi
