#!/usr/bin/env python3
"""
Gemmaclaw Site Generator
Generates a multi-page GitHub Pages static site from benchmark results and project docs.
Pages: index (landing), setup, self-hosting, benchmarks, community, goals.
"""

import json
import os
import re
import sys
from pathlib import Path
from datetime import datetime

REPO_DIR = Path(__file__).resolve().parent.parent.parent
RESULTS_DIR = REPO_DIR / "benchmark-results"
SITE_DIR = REPO_DIR / "site"
COMMUNITY_CONFIGS_FILE = SITE_DIR / "data" / "gemma4-hardware-configs.json"
FIELD_NOTES_FILE = SITE_DIR / "data" / "field-notes.md"
# Workspace knowledge directory for Reddit post files (set via env or default)
WORKSPACE_DIR = Path(os.environ.get("WORKSPACE", str(REPO_DIR.parent.parent)))
POSTS_DIR = WORKSPACE_DIR / "knowledge" / "reddit" / "localllama" / "posts"


def load_benchmark_results():
    """Load all benchmark result JSON files."""
    results = []
    if not RESULTS_DIR.exists():
        return results
    for d in sorted(RESULTS_DIR.iterdir()):
        rfile = d / "results.json"
        if rfile.exists():
            try:
                with open(rfile) as f:
                    data = json.load(f)
                # Skip results with different schema (e.g. jake-agent pack results)
                if "model" not in data or "backend" not in data or "summary" not in data:
                    continue
                data["_dir"] = d.name
                results.append(data)
            except (json.JSONDecodeError, KeyError):
                pass
    return results


def best_results(results):
    """Return the best result per model (highest percentage), deduped by model+backend."""
    seen = {}
    for r in results:
        key = f"{r['model']}_{r['backend']}"
        if key not in seen or r["summary"]["percentage"] > seen[key]["summary"]["percentage"]:
            seen[key] = r
    return sorted(seen.values(), key=lambda x: -x["summary"]["percentage"])


def format_speed(tok_s):
    if tok_s is None or tok_s == 0:
        return "N/A"
    return f"{tok_s:.1f}"


def format_time(ms):
    if ms is None:
        return "N/A"
    s = ms / 1000
    if s < 60:
        return f"{s:.1f}s"
    m = s / 60
    return f"{m:.1f}m"


def generate_benchmark_table_rows(results):
    rows = []
    for r in results:
        s = r["summary"]
        hw = r.get("hardware", {})
        gpu = hw.get("gpu", "None detected")
        if gpu == "None detected":
            gpu = "CPU only"
        pct = s["percentage"]
        pct_class = "win" if pct >= 95 else ("" if pct >= 80 else "bad")
        speed = format_speed(s.get("medianTokensPerSecond"))
        rows.append(f"""<tr>
  <td><strong>{r['model']}</strong></td>
  <td>{r['backend']}</td>
  <td>{gpu}</td>
  <td class="num {pct_class}">{pct}%</td>
  <td class="num">{s['passedCount']}/{s['passedCount'] + s['failedCount']}</td>
  <td class="num">{speed} tok/s</td>
  <td class="num">{format_time(s.get('totalTimeMs'))}</td>
</tr>""")
    return "\n".join(rows)


def generate_task_detail_rows(tasks):
    rows = []
    for t in tasks:
        pct = t.get("percentage", 0)
        pct_class = "win" if pct >= 90 else ("" if pct >= 60 else "bad")
        speed = format_speed(t.get("tokensPerSecond"))
        failure = t.get("failureMode", "none")
        if failure == "none":
            failure = ""
        rows.append(f"""<tr>
  <td>{t['name']}</td>
  <td><span class="cat-badge">{t.get('category', '')}</span></td>
  <td class="num {pct_class}">{t['score']}/{t['maxScore']}</td>
  <td class="num">{speed} tok/s</td>
  <td class="num">{format_time(t.get('elapsedMs'))}</td>
  <td>{failure}</td>
</tr>""")
    return "\n".join(rows)


def generate_model_detail_sections(results):
    sections = []
    for r in results:
        model_id = re.sub(r"[^a-z0-9]+", "-", f"{r['model']}-{r['backend']}".lower())
        s = r["summary"]
        hw = r.get("hardware", {})
        tasks_html = generate_task_detail_rows(r.get("tasks", []))
        failure_modes = s.get("failureModes", {})
        fm_items = ", ".join(f"{k}: {v}" for k, v in failure_modes.items() if k != "none")
        if not fm_items:
            fm_items = "None"

        sections.append(f"""
<div class="model-detail" id="detail-{model_id}">
  <h3>{r['model']} ({r['backend']})</h3>
  <div class="detail-meta">
    <span>CPU: {hw.get('cpu', 'Unknown')}</span>
    <span>RAM: {hw.get('ram', 'Unknown')}</span>
    <span>GPU: {hw.get('gpu', 'None detected')}</span>
    <span>Score: {s['percentage']}% ({s['passedCount']}/{s['passedCount'] + s['failedCount']} passed)</span>
    <span>Median speed: {format_speed(s.get('medianTokensPerSecond'))} tok/s</span>
    <span>Total time: {format_time(s.get('totalTimeMs'))}</span>
    <span>Failure modes: {fm_items}</span>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Task</th><th>Category</th><th>Score</th><th>Speed</th><th>Time</th><th>Failure</th></tr></thead>
      <tbody>{tasks_html}</tbody>
    </table>
  </div>
</div>""")
    return "\n".join(sections)


def generate_hardware_guide_cards(results):
    """Generate searchable hardware config cards from benchmark data."""
    configs = {}
    for r in results:
        hw = r.get("hardware", {})
        s = r["summary"]
        key = f"{hw.get('cpu', 'Unknown')}|{hw.get('ram', 'Unknown')}|{hw.get('gpu', 'None')}"
        if key not in configs:
            configs[key] = {
                "cpu": hw.get("cpu", "Unknown"),
                "ram": hw.get("ram", "Unknown"),
                "gpu": hw.get("gpu", "None detected"),
                "models": [],
            }
        configs[key]["models"].append({
            "model": r["model"],
            "backend": r["backend"],
            "score": s["percentage"],
            "speed": s.get("medianTokensPerSecond", 0),
            "pass_rate": s.get("passRate", 0),
        })

    cards = []
    for cfg in configs.values():
        best = max(cfg["models"], key=lambda m: m["score"])
        model_rows = ""
        for m in sorted(cfg["models"], key=lambda x: -x["score"]):
            star = " recommended" if m == best else ""
            model_rows += f"""<div class="hw-model{star}">
  <span class="hw-model-name">{m['model']}</span>
  <span class="hw-model-backend">{m['backend']}</span>
  <span class="hw-model-score">{m['score']}%</span>
  <span class="hw-model-speed">{format_speed(m['speed'])} tok/s</span>
</div>\n"""

        gpu_display = cfg["gpu"] if cfg["gpu"] != "None detected" else "CPU only"
        search_text = f"{cfg['cpu']} {cfg['ram']} {gpu_display} {' '.join(m['model'] for m in cfg['models'])}".lower()
        cards.append(f"""<div class="hw-card" data-search="{search_text}">
  <div class="hw-card-header">
    <div class="hw-specs">
      <div class="hw-spec"><strong>CPU:</strong> {cfg['cpu']}</div>
      <div class="hw-spec"><strong>RAM:</strong> {cfg['ram']}</div>
      <div class="hw-spec"><strong>GPU:</strong> {gpu_display}</div>
    </div>
    <div class="hw-best">Best: {best['model']} ({best['score']}% at {format_speed(best['speed'])} tok/s)</div>
  </div>
  <div class="hw-models">{model_rows}</div>
</div>""")
    return "\n".join(cards)


def html_escape(text):
    """Escape HTML special characters."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def clean_markdown(text):
    """Strip markdown syntax to plain text for display in HTML cards."""
    # Remove markdown links where the text is itself a URL: [url](url) -> empty
    text = re.sub(r'\[https?://[^\]]*\]\([^\)]+\)', '', text)
    # Convert remaining markdown links [text](url) to just text
    text = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', text)
    # Remove bare URLs (http/https) that aren't useful as display text
    text = re.sub(r'https?://\S+', '', text)
    # Remove markdown emphasis
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
    text = re.sub(r'\*([^*]+)\*', r'\1', text)
    text = re.sub(r'__([^_]+)__', r'\1', text)
    text = re.sub(r'_([^_]+)_', r'\1', text)
    # Remove markdown escape backslashes
    text = re.sub(r'\\([_*#\[\]()])', r'\1', text)
    # Remove markdown headings
    text = re.sub(r'^#+\s+', '', text, flags=re.MULTILINE)
    # Remove markdown list markers
    text = re.sub(r'^\s*[-*+]\s+', '', text, flags=re.MULTILINE)
    # Remove stray brackets from incomplete/truncated markdown links
    text = re.sub(r'\[\s*\]', '', text)
    text = re.sub(r'\[\s*$', '', text)  # trailing orphan open bracket
    text = re.sub(r'^\s*\]', '', text)  # leading orphan close bracket
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text


# Hardware category definitions for classifying community posts
HARDWARE_CATEGORIES = {
    "apple-silicon": {
        "label": "Apple Silicon",
        "keywords": ["apple silicon", "m1", "m2", "m3", "m4", "m5", "macbook", "mac mini",
                      "mac studio", "mac pro", "metal", "unified memory", "mbp", "m4 max",
                      "m4 pro", "m5 max", "m5 pro", "m3 max", "m3 pro", "mlx"],
        "icon": "apple",
    },
    "high-gpu": {
        "label": "High-end GPU (24+ GB)",
        "keywords": ["rtx 3090", "rtx 4090", "rtx 5090", "a100", "a6000", "h100",
                      "48gb", "24gb vram", "80gb", "3090", "4090", "5090", "a100",
                      "titan", "dual gpu", "multi gpu", "sli", "nvlink"],
        "icon": "gpu-high",
    },
    "mid-gpu": {
        "label": "Mid-range GPU (8-16 GB)",
        "keywords": ["rtx 3060", "rtx 3070", "rtx 4060", "rtx 4070", "rtx 5060",
                      "rtx 5070", "rx 7900", "rx 7800", "8gb vram", "12gb vram",
                      "16gb vram", "3060", "3070", "4060", "4070", "5060", "5070"],
        "icon": "gpu-mid",
    },
    "cpu-only": {
        "label": "CPU / Raspberry Pi",
        "keywords": ["cpu only", "cpu-only", "no gpu", "raspberry pi", "gemma.cpp",
                      "arm", "aarch64", "pi 5", "cpu inference", "cpu only"],
        "icon": "cpu",
    },
    "laptop": {
        "label": "Laptops",
        "keywords": ["laptop", "notebook", "portable", "strix halo", "framework",
                      "thinkpad", "zenbook", "surface", "dell xps", "legion"],
        "icon": "laptop",
    },
    "quantization": {
        "label": "Quantization & Backends",
        "keywords": ["gguf", "gptq", "awq", "exl2", "quant", "quantiz", "4-bit",
                      "8-bit", "q4_k", "q8_0", "iq4", "fp16", "bf16", "nvfp4",
                      "llama.cpp", "ollama", "lm studio", "vllm", "tgi",
                      "exllamav2", "koboldcpp", "text-generation"],
        "icon": "quant",
    },
}


def parse_reddit_post(post_id):
    """Parse a Reddit post markdown file into structured data."""
    md_path = POSTS_DIR / f"{post_id}.md"
    if not md_path.exists():
        return None

    try:
        text = md_path.read_text(encoding="utf-8")
    except Exception:
        return None

    post = {"id": post_id, "title": "", "score": 0, "comments_count": 0,
            "author": "", "date": "", "summary": "", "flair": "",
            "comments": [], "tags": []}

    lines = text.split("\n")
    in_summary = False
    in_takeaways = False
    in_tags = False
    current_comment = None

    for line in lines:
        stripped = line.strip()

        # Title (first h1)
        if stripped.startswith("# ") and not post["title"]:
            post["title"] = stripped[2:].strip()
            continue

        # Metadata lines
        if stripped.startswith("- Score: "):
            try:
                post["score"] = int(stripped.split("- Score: ")[1].strip())
            except (ValueError, IndexError):
                pass
            continue
        if stripped.startswith("- Comments: "):
            try:
                post["comments_count"] = int(stripped.split("- Comments: ")[1].strip())
            except (ValueError, IndexError):
                pass
            continue
        if stripped.startswith("- Author: "):
            post["author"] = stripped.split("- Author: ")[1].strip()
            continue
        if stripped.startswith("- Date: "):
            post["date"] = stripped.split("- Date: ")[1].strip()[:10]
            continue
        if stripped.startswith("- Flair: "):
            post["flair"] = stripped.split("- Flair: ")[1].strip()
            continue

        # Section headers
        if stripped == "## Short summary":
            in_summary = True
            in_takeaways = False
            in_tags = False
            continue
        if stripped == "## Key takeaways from comments":
            in_summary = False
            in_takeaways = True
            in_tags = False
            if current_comment:
                post["comments"].append(current_comment)
                current_comment = None
            continue
        if stripped == "## Tags":
            in_summary = False
            in_takeaways = False
            in_tags = True
            if current_comment:
                post["comments"].append(current_comment)
                current_comment = None
            continue
        if stripped.startswith("## ") and stripped not in ("## Short summary", "## Key takeaways from comments", "## Tags"):
            in_summary = False
            in_takeaways = False
            in_tags = False
            if current_comment:
                post["comments"].append(current_comment)
                current_comment = None
            continue

        # Parse summary text
        if in_summary and stripped:
            if post["summary"]:
                post["summary"] += " " + stripped
            else:
                post["summary"] = stripped

        # Parse comment takeaways
        if in_takeaways:
            # Numbered comment line: "1. [u/username (score N)](url)"
            match = re.match(r'^\d+\.\s+\[u/(\S+)\s+\(score\s+(\d+)\)\]\((https?://[^\)]+)\)', stripped)
            if match:
                if current_comment:
                    post["comments"].append(current_comment)
                current_comment = {
                    "user": match.group(1),
                    "score": int(match.group(2)),
                    "url": match.group(3),
                    "text": "",
                }
                continue
            # Continuation of comment text (indented lines after the numbered line)
            if current_comment and stripped:
                if current_comment["text"]:
                    current_comment["text"] += " " + stripped
                else:
                    current_comment["text"] = stripped

        # Parse tags
        if in_tags and stripped.startswith("- "):
            post["tags"].append(stripped[2:].strip().lower())

    if current_comment:
        post["comments"].append(current_comment)

    return post


def categorize_post(post):
    """Classify a post into hardware categories based on title, summary, tags, and comments."""
    search_text = " ".join([
        post.get("title", ""),
        post.get("summary", ""),
        " ".join(post.get("tags", [])),
        " ".join(c.get("text", "") for c in post.get("comments", [])[:3]),
    ]).lower()

    categories = []
    for cat_id, cat_def in HARDWARE_CATEGORIES.items():
        if any(kw in search_text for kw in cat_def["keywords"]):
            categories.append(cat_id)

    return categories if categories else ["general"]


def load_community_configs():
    """Load community posts from JSON index and parse from Reddit markdown files."""
    if not COMMUNITY_CONFIGS_FILE.exists():
        return []

    try:
        with open(COMMUNITY_CONFIGS_FILE) as f:
            data = json.load(f)
    except (json.JSONDecodeError, KeyError):
        return []

    posts = []
    for entry in data:
        post_id = entry.get("post", "")
        if not post_id:
            continue

        parsed = parse_reddit_post(post_id)
        if not parsed or not parsed["title"]:
            continue

        parsed["categories"] = categorize_post(parsed)
        posts.append(parsed)

    # Sort by score descending
    posts.sort(key=lambda p: -p["score"])
    return posts


def generate_community_cards(posts):
    """Generate structured community report cards from parsed Reddit posts."""
    if not posts:
        return ""

    # Build category filter tabs
    cat_counts = {}
    for p in posts:
        for c in p["categories"]:
            cat_counts[c] = cat_counts.get(c, 0) + 1

    tabs = ['<button class="cat-filter-btn active" data-cat="all">All</button>']
    for cat_id, cat_def in HARDWARE_CATEGORIES.items():
        if cat_id in cat_counts:
            tabs.append(
                f'<button class="cat-filter-btn" data-cat="{cat_id}">'
                f'{html_escape(cat_def["label"])} ({cat_counts[cat_id]})</button>'
            )
    if "general" in cat_counts:
        tabs.append(
            f'<button class="cat-filter-btn" data-cat="general">'
            f'Other ({cat_counts["general"]})</button>'
        )

    filter_bar = f'<div class="cat-filter-bar">{"".join(tabs)}</div>'

    # Build cards
    cards = []
    for post in posts:
        post_id = post["id"]
        title = html_escape(post["title"][:120])
        score = post["score"]
        clean_summary = clean_markdown(post["summary"])
        if not clean_summary:
            # Fall back to first comment text if summary is just URLs
            first_text = next((c["text"] for c in post.get("comments", []) if c.get("text")), "")
            clean_summary = clean_markdown(first_text) if first_text else ""
        summary = html_escape(clean_summary[:250])
        if len(clean_summary) > 250:
            summary += "..."
        author = html_escape(post["author"])
        date_str = post["date"]
        flair = html_escape(post["flair"]) if post["flair"] else ""
        reddit_url = f"https://reddit.com/r/LocalLLaMA/comments/{post_id}"
        cats = " ".join(post["categories"])

        # Build search text from all meaningful fields (cleaned)
        search_text = html_escape(clean_markdown(
            f"{post['title']} {post['summary']} "
            f"{' '.join(post.get('tags', []))} "
            f"{' '.join(c.get('text', '')[:100] for c in post.get('comments', [])[:3])}"
        )).lower()[:500]

        # Build top comments (max 3, only those with actual text)
        comment_html = ""
        useful_comments = [c for c in post.get("comments", []) if c.get("text")][:3]
        if useful_comments:
            comment_items = []
            for c in useful_comments:
                clean_text = clean_markdown(c["text"])
                c_text = html_escape(clean_text[:200])
                if len(clean_text) > 200:
                    c_text += "..."
                c_user = html_escape(c["user"])
                c_score = c["score"]
                comment_items.append(
                    f'<div class="cr-comment">'
                    f'<span class="cr-comment-meta">u/{c_user} (+{c_score})</span>'
                    f'<span class="cr-comment-text">{c_text}</span>'
                    f'</div>'
                )
            comment_html = f'<div class="cr-comments">{"".join(comment_items)}</div>'

        # Score badge color
        score_class = "cr-score-high" if score >= 200 else ("cr-score-mid" if score >= 50 else "")

        # Flair badge
        flair_html = f'<span class="cr-flair">{flair}</span>' if flair else ""

        # Category badges
        cat_badges = ""
        for cat in post["categories"]:
            label = HARDWARE_CATEGORIES.get(cat, {}).get("label", cat.replace("-", " ").title())
            cat_badges += f'<span class="cr-cat-badge">{html_escape(label)}</span>'

        cards.append(f"""<div class="cr-card" data-search="{search_text}" data-cats="{cats}">
  <div class="cr-card-header">
    <div class="cr-title-row">
      <h4 class="cr-title"><a href="{reddit_url}" target="_blank" rel="noopener">{title}</a></h4>
      <span class="cr-score {score_class}">+{score}</span>
    </div>
    <div class="cr-meta">
      <span class="cr-author">{author}</span>
      <span class="cr-date">{date_str}</span>
      {flair_html}
      {cat_badges}
    </div>
  </div>
  <p class="cr-summary">{summary}</p>
  {comment_html}
  <a href="{reddit_url}" class="cr-source" target="_blank" rel="noopener">View full discussion on r/LocalLLaMA</a>
</div>""")

    return filter_bar + '\n<div id="community-cards">' + "\n".join(cards) + '</div>'


def render_field_notes_markdown(md_text):
    """Render the curated field-notes Markdown into an HTML fragment.

    Supports the small Markdown subset used in site/data/field-notes.md:
    headings (## / ###), paragraphs, italics (*x*), bold (**x**),
    inline links [text](url), bullet lists, and emphasized last-updated lines.
    Output is plain HTML wrapped in a <div class="field-notes">.
    """
    lines = md_text.splitlines()
    html_parts = []
    in_list = False
    para_buf = []

    def flush_para():
        if para_buf:
            text = " ".join(para_buf).strip()
            if text:
                html_parts.append(f"<p>{render_inline(text)}</p>")
            para_buf.clear()

    def close_list():
        nonlocal in_list
        if in_list:
            html_parts.append("</ul>")
            in_list = False

    def render_inline(text):
        # Inline links [text](url)
        def link_sub(m):
            label, url = m.group(1), m.group(2)
            return (f'<a href="{html_escape(url)}" target="_blank" '
                    f'rel="noopener">{html_escape(label)}</a>')
        # Escape first, then re-apply markdown so links/emphasis work safely.
        escaped = html_escape(text)
        # Convert escaped brackets back so the regex matches our markdown links.
        escaped = escaped.replace("&lt;", "<").replace("&gt;", ">")
        escaped = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link_sub, escaped)
        # Bold then italic (order matters so ** wins over *).
        escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
        escaped = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", escaped)
        # Underscore italic, but not inside identifiers like Q5_K_M.
        escaped = re.sub(
            r"(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])",
            r"<em>\1</em>",
            escaped,
        )
        return escaped

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            flush_para()
            close_list()
            continue
        if line.startswith("### "):
            flush_para()
            close_list()
            html_parts.append(f"<h3>{render_inline(line[4:].strip())}</h3>")
            continue
        if line.startswith("## "):
            flush_para()
            close_list()
            html_parts.append(f"<h2>{render_inline(line[3:].strip())}</h2>")
            continue
        if line.lstrip().startswith("- "):
            flush_para()
            if not in_list:
                html_parts.append('<ul class="setup-list">')
                in_list = True
            item = line.lstrip()[2:].strip()
            html_parts.append(f"<li>{render_inline(item)}</li>")
            continue
        para_buf.append(line.strip())

    flush_para()
    close_list()
    return '<div class="field-notes">' + "\n".join(html_parts) + "</div>"


def load_field_notes():
    """Return rendered HTML for the curated field-notes section, or empty string."""
    if not FIELD_NOTES_FILE.exists():
        return ""
    try:
        md_text = FIELD_NOTES_FILE.read_text()
    except OSError:
        return ""
    if not md_text.strip():
        return ""
    return render_field_notes_markdown(md_text)



# --- Multi-page layout ---

NAV_ITEMS = [
    ("Setup", "setup.html", False),
    ("Self-Hosting", "self-hosting.html", False),
    ("Benchmarks", "benchmarks.html", False),
    ("Community", "community.html", False),
    ("Goals", "goals.html", False),
    ("GitHub", "https://github.com/gemmaclaw/gemmaclaw", True),
]


def page_template(title, body_content, active_page="", extra_scripts=""):
    page_title = f"Gemmaclaw - {title}" if title else "Gemmaclaw"
    nav_links = []
    for label, href, is_external in NAV_ITEMS:
        active_class = ' class="active"' if href == active_page else ""
        target = ' target="_blank" rel="noopener"' if is_external else ""
        nav_links.append(f'<a href="{href}"{active_class}{target}>{label}</a>')
    nav_html = "\n        ".join(nav_links)
    script_tag = f'<script>{extra_scripts}</script>' if extra_scripts else ''
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{page_title}</title>
  <meta name="description" content="Out-of-the-box best Gemma setup for your hardware. Benchmark results, setup guides, and self-hosting configurations.">
  <style>
{CSS}
  </style>
</head>
<body>
  <nav class="topnav">
    <div class="nav-inner">
      <a href="index.html" class="logo">Gemmaclaw</a>
      <div class="nav-links">
        {nav_html}
      </div>
    </div>
  </nav>
  <div class="wrap">
    {body_content}
  </div>
  <footer>
    <p>Built on <a href="https://github.com/openclaw/openclaw" class="inline">OpenClaw</a>. Volunteer-driven, Gemma-first.</p>
    <p class="footer-sub">Not an official Google product.</p>
  </footer>
  {script_tag}
</body>
</html>"""


def generate_index_page():
    body = """<!-- Hero -->
    <div class="hero">
      <h1><span>Gemmaclaw</span></h1>
      <p class="tagline">One command to a working Gemma assistant, regardless of what hardware you have. Auto-detect, provision, and benchmark.</p>
      <div class="links">
        <a href="setup.html" class="btn-primary">Get Started</a>
        <a href="benchmarks.html" class="btn-secondary">See Benchmarks</a>
        <a href="https://github.com/gemmaclaw/gemmaclaw" class="btn-secondary">GitHub</a>
      </div>
    </div>
    <div class="page-cards">
      <a href="setup.html" class="page-card"><div class="page-card-icon">&#9881;</div><h3>Setup Guide</h3><p>Auto-detect your hardware, provision backends, and start a local Gemma assistant in one command.</p></a>
      <a href="self-hosting.html" class="page-card"><div class="page-card-icon">&#9729;</div><h3>Self-Hosting</h3><p>Find the best Gemma configuration for your hardware. Search by GPU, CPU, or RAM.</p></a>
      <a href="benchmarks.html" class="page-card"><div class="page-card-icon">&#9889;</div><h3>Benchmarks</h3><p>All models tested on the same task suite: instruction following, reasoning, coding, and more.</p></a>
      <a href="community.html" class="page-card"><div class="page-card-icon">&#128101;</div><h3>Community</h3><p>Real-world hardware reports from r/LocalLLaMA, curated field notes, and community discoveries.</p></a>
      <a href="goals.html" class="page-card"><div class="page-card-icon">&#127919;</div><h3>Goals & Roadmap</h3><p>Three-phase plan: Evidence, Productization, Community Loop. See where we are and what's next.</p></a>
    </div>"""
    return page_template("", body)


def generate_setup_page():
    body = """<div class="breadcrumb"><a href="index.html">Home</a> / Setup Guide</div>
    <section id="setup">
      <h2>Setup Guide</h2>
      <p>Gemmaclaw detects your hardware, picks the best Gemma model and backend, provisions everything, and starts a local assistant. No manual model shopping.</p>
      <h3>Prerequisites</h3>
      <ul class="setup-list">
        <li>Node.js 22+</li>
        <li>Docker (recommended, for sandboxed tool execution)</li>
        <li>For gemma.cpp: cmake, g++ (or clang++), git, HuggingFace token</li>
      </ul>
      <p>No pre-installed Ollama, llama.cpp, or gemma.cpp required. Gemmaclaw manages everything.</p>
      <h3>Quick Start</h3>
      <div class="code-block"><pre><code>git clone https://github.com/gemmaclaw/gemmaclaw.git
cd gemmaclaw
corepack enable &amp;&amp; pnpm install
pnpm build
npm install -g .

# Auto-detect hardware + provision + start
gemmaclaw setup

# Restart later
gemmaclaw chat</code></pre></div>
      <h3>What Happens</h3>
      <ol class="setup-steps">
        <li><strong>Hardware detection:</strong> probes GPU (vendor, VRAM, Metal), CPU (arch, cores), and RAM</li>
        <li><strong>Tier classification:</strong> slots your machine into a hardware tier</li>
        <li><strong>Profile selection:</strong> maps tier to a tested Gemma 4 model, avoiding known issues</li>
        <li><strong>Provisioning:</strong> downloads Ollama, pulls the model, runs smoke test</li>
        <li><strong>Configuration:</strong> writes gateway config with local Ollama provider</li>
        <li><strong>Sandboxing:</strong> when Docker is available, tool execution is containerized</li>
        <li><strong>Verification:</strong> smoke test confirms the model responds</li>
      </ol>
      <h3>Commands</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Command</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>gemmaclaw setup</code></td><td>Auto-detect, provision, configure, and start</td></tr>
          <tr><td><code>gemmaclaw setup --no-container</code></td><td>Same but disable Docker sandbox</td></tr>
          <tr><td><code>gemmaclaw setup --advanced</code></td><td>Interactive wizard for manual selection</td></tr>
          <tr><td><code>gemmaclaw chat</code></td><td>Open browser-based chat UI</td></tr>
          <tr><td><code>gemmaclaw tui</code></td><td>Terminal chat interface</td></tr>
          <tr><td><code>gemmaclaw benchmark</code></td><td>Run the benchmark suite</td></tr>
          <tr><td><code>gemmaclaw benchmark submit</code></td><td>Anonymize and submit results via PR</td></tr>
          <tr><td><code>gemmaclaw provision</code></td><td>Manually provision a specific backend</td></tr>
          <tr><td><code>gemmaclaw doctor</code></td><td>Health checks and quick fixes</td></tr>
        </tbody>
      </table></div>
      <h3>Troubleshooting</h3>
      <ul class="setup-list">
        <li><strong>Ollama download fails:</strong> check network. Binary comes from GitHub releases.</li>
        <li><strong>llama.cpp server won't start:</strong> verify model at <code>~/.gemmaclaw/models/llama-cpp/</code>. Re-run provision.</li>
        <li><strong>gemma.cpp build fails:</strong> ensure cmake and g++ are installed.</li>
        <li><strong>"Healthcheck failed":</strong> backend did not respond in time. Check system resources.</li>
        <li><strong>Port in use:</strong> use <code>--port N</code> or advanced setup.</li>
      </ul>
    </section>"""
    return page_template("Setup Guide", body, active_page="setup.html")

def generate_self_hosting_page(hw_cards):
    body = f"""<div class="breadcrumb"><a href="index.html">Home</a> / Self-Hosting Guide</div>
    <section id="hosting">
      <h2>Gemma4 Self-Hosting Guide</h2>
      <p>Find the best Gemma configuration for your hardware. Search by GPU, CPU, or RAM to see what works, how fast, and what quality to expect.</p>
      <div class="search-bar"><input type="text" id="hw-search" placeholder="Search by hardware (e.g. RTX 3090, M4 Max, 32GB, CPU only...)" autocomplete="off"></div>
      <div id="hw-cards">{hw_cards}</div>
      <div class="hosting-notes">
        <h3>Backend Comparison</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Backend</th><th>Best For</th><th>GPU Support</th><th>Notes</th></tr></thead>
          <tbody>
            <tr><td><strong>Ollama</strong></td><td>Most users, GPU setups</td><td>CUDA, Metal, ROCm</td><td>Easiest setup, automatic model management</td></tr>
            <tr><td><strong>llama.cpp</strong></td><td>Flexible quantization</td><td>CUDA, Metal, Vulkan</td><td>More quant options, manual model files</td></tr>
            <tr><td><strong>gemma.cpp</strong></td><td>CPU-first setups</td><td>CPU only (for now)</td><td>Google-native, Gemma 2/3 only currently</td></tr>
          </tbody>
        </table></div>
        <h3>Hardware Tiers</h3>
        <ul class="setup-list">
          <li><strong>High-end GPU (24+ GB VRAM):</strong> Run Gemma 4 31B Dense or 26B MoE at full precision. RTX 3090/4090, A100, etc.</li>
          <li><strong>Mid-range GPU (8-16 GB VRAM):</strong> Gemma 4 26B MoE with quantization, or Gemma 4 E4B unquantized.</li>
          <li><strong>Apple Silicon (32+ GB unified):</strong> Gemma 4 26B MoE via Ollama Metal. 48+ GB can try 31B Dense.</li>
          <li><strong>CPU only (16+ GB RAM):</strong> Gemma 4 E4B or Gemma 3 4B via Ollama. Viable for interactive use at 140+ tok/s.</li>
          <li><strong>CPU only (8-16 GB RAM):</strong> Gemma 3 4B or Gemma 2 via gemma.cpp. Smaller but functional.</li>
        </ul>
      </div>
    </section>"""
    scripts = """
    const searchInput = document.getElementById('hw-search');
    const hwCards = document.querySelectorAll('#hw-cards .hw-card');
    if (searchInput) {{ searchInput.addEventListener('input', function() {{
      const q = this.value.toLowerCase().trim();
      hwCards.forEach(card => {{ card.style.display = (!q || (card.getAttribute('data-search') || '').includes(q)) ? '' : 'none'; }});
    }}); }}
"""
    return page_template("Self-Hosting Guide", body, active_page="self-hosting.html", extra_scripts=scripts)

def generate_benchmarks_page(benchmark_rows, model_details):
    body = f"""<div class="breadcrumb"><a href="index.html">Home</a> / Benchmark Results</div>
    <section id="benchmarks">
      <h2>Benchmark Results</h2>
      <p>All models tested on the same task suite: instruction following, reasoning, data extraction, safety, and coding. Click a row for detailed per-task breakdown.</p>
      <div class="table-wrap"><table id="benchmark-table">
        <thead><tr><th>Model</th><th>Backend</th><th>GPU</th><th>Quality</th><th>Pass Rate</th><th>Speed</th><th>Total Time</th></tr></thead>
        <tbody>{benchmark_rows}</tbody>
      </table></div>
      <div id="model-details">{model_details}</div>
    </section>"""
    scripts = """
    document.querySelectorAll('#benchmark-table tbody tr').forEach(row => {{
      row.style.cursor = 'pointer';
      row.addEventListener('click', function() {{
        const model = this.querySelector('td strong')?.textContent || '';
        const backend = this.querySelectorAll('td')[1]?.textContent || '';
        const id = (model + '-' + backend).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const detail = document.getElementById('detail-' + id);
        if (detail) {{
          const isVisible = detail.style.display !== 'none';
          document.querySelectorAll('.model-detail').forEach(d => d.style.display = 'none');
          detail.style.display = isVisible ? 'none' : 'block';
          if (!isVisible) detail.scrollIntoView({{ behavior: 'smooth', block: 'start' }});
        }}
      }});
    }});
    document.querySelectorAll('.model-detail').forEach(d => d.style.display = 'none');
"""
    return page_template("Benchmark Results", body, active_page="benchmarks.html", extra_scripts=scripts)

def generate_community_page(community_cards, community_count, field_notes_html):
    field_notes_section = f'<section id="field-notes" class="field-notes-section"><h2>Field Notes</h2><p>A weekly synthesis of what the r/LocalLLaMA community is reporting about Gemma 4 in real use.</p>{field_notes_html}</section>' if field_notes_html else ""
    community_section = ""
    if community_count:
        community_section = f"""<div class="community-section" id="community">
      <h3>Community Reports ({community_count} from r/LocalLLaMA)</h3>
      <p>Real-world hardware experiences from the community. Filter by hardware category or search. These are user reports, not official benchmarks.</p>
      <div class="search-bar"><input type="text" id="community-search" placeholder="Search community reports..." autocomplete="off"></div>
      {community_cards}
    </div>"""
    body = f"""<div class="breadcrumb"><a href="index.html">Home</a> / Community</div>
    <section id="community-page">
      <h2>Community & Hardware Reports</h2>
      <p>Real-world experiences running Gemma models, curated from the community. Browse hardware reports, read the weekly field notes, or search for your setup.</p>
      {field_notes_section}
      {community_section}
    </section>"""
    scripts = """
    const searchInput = document.getElementById('community-search');
    const crCards = document.querySelectorAll('#community-cards .cr-card');
    let activeCat = 'all';
    function applyFilters() {{
      const q = (searchInput ? searchInput.value : '').toLowerCase().trim();
      crCards.forEach(card => {{
        const text = card.getAttribute('data-search') || '';
        const cats = card.getAttribute('data-cats') || '';
        card.style.display = ((!q || text.includes(q)) && (activeCat === 'all' || cats.split(' ').includes(activeCat))) ? '' : 'none';
      }});
      const container = document.getElementById('community-cards');
      if (container) {{
        const visible = container.querySelectorAll('.cr-card:not([style*="display: none"])');
        let noResults = container.querySelector('.no-results');
        if (visible.length === 0) {{
          if (!noResults) {{ noResults = document.createElement('p'); noResults.className = 'no-results'; noResults.textContent = 'No reports match your filters.'; container.appendChild(noResults); }}
          noResults.style.display = '';
        }} else if (noResults) {{ noResults.style.display = 'none'; }}
      }}
    }}
    if (searchInput) {{ searchInput.addEventListener('input', applyFilters); }}
    document.querySelectorAll('.cat-filter-btn').forEach(btn => {{
      btn.addEventListener('click', function() {{
        document.querySelectorAll('.cat-filter-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        activeCat = this.getAttribute('data-cat');
        applyFilters();
      }});
    }});
""" if community_count else ""
    return page_template("Community", body, active_page="community.html", extra_scripts=scripts)

def generate_goals_page():
    body = """<div class="breadcrumb"><a href="index.html">Home</a> / Goals & Roadmap</div>
    <section id="goals">
      <h2>Goals and Progress</h2>
      <div class="phase-card active">
        <div class="phase-badge">Phase 1: Evidence</div>
        <h3>Benchmark Harness</h3>
        <p>Benchmark Gemma models across hardware tiers, backends, and quantizations. Document what actually works, how fast, and at what quality. No opinions without data.</p>
        <ul class="setup-list">
          <li>Single-command benchmark runner with hardware auto-detection</li>
          <li>Containerized test environment with realistic agent toolset</li>
          <li>Structured result artifacts (JSON, markdown, HTML dashboard)</li>
          <li>One-command <code>gemmaclaw benchmark submit</code> to contribute results via PR</li>
        </ul>
        <div class="phase-status">Status: Live. <code>gemmaclaw benchmark</code> works end-to-end.</div>
      </div>
      <div class="phase-card active">
        <div class="phase-badge">Phase 2: Productization</div>
        <h3>Auto-Detection and Profiles</h3>
        <p>Build the auto-detection and profile-selection tooling. Ship a <code>gemmaclaw doctor</code> command and tested profiles that work out of the box.</p>
        <ul class="setup-list">
          <li>Hardware detection (GPU, CPU, RAM, Apple Silicon Metal)</li>
          <li>Tier classification and profile selection</li>
          <li>Known-issue tracking with automatic fallbacks</li>
          <li><code>gemmaclaw setup</code> wizard with auto and advanced modes</li>
        </ul>
        <div class="phase-status">Status: Live. <code>gemmaclaw setup</code> auto-detects and provisions.</div>
      </div>
      <div class="phase-card">
        <div class="phase-badge">Phase 3: Community Loop</div>
        <h3>Open Profile Registry</h3>
        <p>Open the profile registry to contributions. Users report what works on their hardware, profiles get refined, coverage grows.</p>
        <ul class="setup-list">
          <li>Community benchmark submission flow (via PR)</li>
          <li>Configuration matrix aggregation on this site</li>
          <li>Gap detection: highlight untested hardware combos</li>
          <li>Failure archetype classification for Gemma post-training feedback</li>
        </ul>
        <div class="phase-status">Status: In progress. Submission flow works, site aggregation building.</div>
      </div>
      <h3>Non-GPU Support</h3>
      <p>CPU-only is a first-class path, not a fallback afterthought. Gemma 2 and Gemma 3 run on CPU via gemma.cpp. As CPU backends add Gemma 4 support, Gemmaclaw will incorporate those profiles automatically. The goal is that someone with a laptop and no discrete GPU gets a useful local Gemma assistant.</p>
      <h3>Volunteer Project</h3>
      <p>Gemmaclaw is composed of volunteers, including Google engineers and open source community members. It is not an official Google repository. Contributions and hardware reports are welcome. See the <a href="https://github.com/gemmaclaw/gemmaclaw/blob/main/CONTRIBUTING.md" class="inline">contributing guide</a>.</p>
    </section>"""
    return page_template("Goals & Roadmap", body, active_page="goals.html")


def generate_site():
    results = load_benchmark_results()
    best = best_results(results)
    benchmark_rows = generate_benchmark_table_rows(best)
    model_details = generate_model_detail_sections(best)
    hw_cards = generate_hardware_guide_cards(results)
    community_configs = load_community_configs()
    community_cards = generate_community_cards(community_configs)
    community_count = len(community_configs)
    field_notes_html = load_field_notes()
    SITE_DIR.mkdir(exist_ok=True)
    pages = {
        "index.html": generate_index_page(),
        "setup.html": generate_setup_page(),
        "self-hosting.html": generate_self_hosting_page(hw_cards),
        "benchmarks.html": generate_benchmarks_page(benchmark_rows, model_details),
        "community.html": generate_community_page(community_cards, community_count, field_notes_html),
        "goals.html": generate_goals_page(),
    }
    for filename, html in pages.items():
        with open(SITE_DIR / filename, "w") as f:
            f.write(html)
    print(f"Site generated at {SITE_DIR}/")
    print(f"  {len(pages)} pages generated: {', '.join(pages.keys())}")
    print(f"  {len(results)} benchmark results loaded")
    print(f"  {len(best)} unique model/backend combos")
    print(f"  {community_count} community hardware reports loaded")


CSS = """

    :root {
      --bg: #ffffff;
      --bg-elev: #f6f8fa;
      --bg-elev-2: #eef1f5;
      --border: #d0d7de;
      --fg: #1f2328;
      --fg-soft: #424a53;
      --muted: #656d76;
      --accent: #4285f4;
      --accent-soft: #dbe8fc;
      --good: #1a7f37;
      --warn: #9a6700;
      --bad: #cf222e;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    /* Nav */
    .topnav {
      position: sticky; top: 0; z-index: 100;
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
    }
    .nav-inner {
      max-width: 960px; margin: 0 auto;
      display: flex; align-items: center; justify-content: space-between;
      gap: 1rem;
      padding: 0.75rem 1.5rem;
    }
    .logo {
      font-size: 1.1rem; font-weight: 700; color: var(--accent);
      text-decoration: none; flex-shrink: 0;
    }
    .nav-links {
      display: flex; gap: 1.5rem;
      overflow-x: auto; -webkit-overflow-scrolling: touch;
      scrollbar-width: none; -ms-overflow-style: none;
      min-width: 0;
    }
    .nav-links::-webkit-scrollbar { display: none; }
    .nav-links a {
      color: var(--muted); text-decoration: none; font-size: 0.9rem; font-weight: 500;
      transition: color 0.15s; white-space: nowrap; flex-shrink: 0;
      padding: 0.25rem 0; border-bottom: 2px solid transparent;
    }
    .nav-links a:hover { color: var(--fg); }
    .nav-links a.active { color: var(--accent); border-bottom-color: var(--accent); }

    .wrap { max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }

    /* Hero */
    .hero { text-align: center; padding: 3rem 0 3rem; }
    h1 { font-size: 3rem; font-weight: 700; letter-spacing: -0.02em; }
    h1 span { color: var(--accent); }
    .tagline { font-size: 1.15rem; color: var(--muted); max-width: 600px; margin: 1rem auto 2rem; }
    .links { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }
    .links a {
      display: inline-flex; align-items: center; gap: 0.5rem;
      padding: 0.7rem 1.4rem; border-radius: 8px;
      text-decoration: none; font-weight: 500; font-size: 0.95rem;
      transition: opacity 0.15s, transform 0.15s;
    }
    .links a:hover { opacity: 0.9; transform: translateY(-1px); }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-secondary { border: 1px solid var(--border); color: var(--fg); background: var(--bg-elev); }

    /* Capabilities */
    .capabilities {
      margin-top: 3rem;
      padding-top: 2rem;
      border-top: 1px solid var(--border);
    }
    .capabilities h2 {
      text-align: center;
      font-size: 1.6rem; font-weight: 600;
      margin-bottom: 0.5rem; letter-spacing: -0.01em;
    }
    .cap-intro {
      text-align: center;
      max-width: 640px; margin: 0 auto 2rem;
      font-size: 1rem; color: var(--fg-soft);
    }
    .cap-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 1rem;
    }
    .cap-card {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem;
      transition: border-color 0.15s, transform 0.15s;
    }
    .cap-card:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
    }
    .cap-icon {
      font-size: 1.5rem;
      margin-bottom: 0.5rem;
    }
    .cap-card h3 {
      font-size: 1rem; font-weight: 600;
      margin: 0 0 0.4rem; color: var(--fg);
    }
    .cap-card p {
      font-size: 0.88rem; color: var(--fg-soft);
      margin: 0; line-height: 1.5;
    }
    .cap-examples {
      margin-top: 2rem;
    }
    .cap-examples h3 {
      font-size: 1.15rem; font-weight: 600;
      margin: 0 0 1rem; color: var(--fg);
    }
    .example-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 0.75rem;
    }
    .example-item {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem 1.25rem;
      font-size: 0.9rem; color: var(--fg-soft);
      line-height: 1.5;
    }
    .example-item strong {
      color: var(--fg);
    }
    .cap-footer {
      text-align: center;
      margin-top: 1.5rem;
      font-size: 0.95rem; color: var(--muted);
      max-width: 640px;
      margin-left: auto; margin-right: auto;
    }

    /* Sections */
    section { margin-top: 1rem; scroll-margin-top: 4rem; }
    h2 { font-size: 1.6rem; font-weight: 600; margin-bottom: 1rem; letter-spacing: -0.01em; }
    h3 { font-size: 1.1rem; font-weight: 600; margin: 1.5rem 0 0.75rem; color: var(--fg-soft); }
    p { color: var(--fg-soft); margin-bottom: 1rem; }
    a.inline { color: var(--accent); text-decoration: none; }
    a.inline:hover { text-decoration: underline; }

    /* Field Notes (curated weekly synthesis) */
    .field-notes {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem 1.75rem;
      margin: 0;
    }
    .field-notes h2 {
      font-size: 1.5rem; font-weight: 600;
      margin: 0 0 0.5rem;
      letter-spacing: -0.01em;
    }
    .field-notes h3 {
      font-size: 1.05rem; font-weight: 600;
      margin: 1.5rem 0 0.5rem;
      color: var(--fg);
    }
    .field-notes p { color: var(--fg-soft); margin: 0 0 0.75rem; }
    .field-notes p em { color: var(--muted); }
    .field-notes ul {
      list-style: none; margin: 0 0 1rem; padding: 0;
    }
    .field-notes li {
      padding: 0.4rem 0 0.4rem 1.25rem;
      position: relative;
      color: var(--fg-soft);
    }
    .field-notes li::before {
      content: '';
      position: absolute; left: 0; top: 0.75rem;
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--accent);
    }
    .field-notes li strong { color: var(--fg); }
    .field-notes a {
      color: var(--accent); text-decoration: none;
    }
    .field-notes a:hover { text-decoration: underline; }
    @media (max-width: 640px) {
      .field-notes { padding: 1rem 1.1rem; }
      .field-notes h2 { font-size: 1.3rem; }
    }

    /* Lists */
    .setup-list { list-style: none; margin: 0 0 1rem; }
    .setup-list li {
      padding: 0.5rem 0 0.5rem 1.25rem;
      position: relative;
      color: var(--fg-soft);
    }
    .setup-list li::before {
      content: '';
      position: absolute; left: 0; top: 0.85rem;
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--accent);
    }
    .setup-list li strong { color: var(--fg); }

    .setup-steps { list-style: none; counter-reset: step; margin: 0 0 1rem; }
    .setup-steps li {
      padding: 0.5rem 0 0.5rem 2rem;
      position: relative;
      color: var(--fg-soft);
      counter-increment: step;
    }
    .setup-steps li::before {
      content: counter(step);
      position: absolute; left: 0; top: 0.45rem;
      width: 22px; height: 22px; border-radius: 50%;
      background: var(--accent-soft); color: var(--accent);
      font-size: 0.75rem; font-weight: 600;
      display: flex; align-items: center; justify-content: center;
    }
    .setup-steps li strong { color: var(--fg); }

    /* CLI command cards */
    .cli-cmd-card {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      margin: 1.25rem 0;
    }
    .cli-cmd-card h4 {
      font-size: 1.05rem; font-weight: 600;
      margin: 0 0 0.5rem; color: var(--fg);
    }
    .cli-cmd-card h4 code {
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 0.95rem; color: var(--accent);
      background: none; padding: 0;
    }
    .cli-cmd-card > p {
      font-size: 0.92rem; margin-bottom: 0.75rem;
    }
    .cli-cmd-card .table-wrap { margin: 0.75rem 0; }
    .cli-cmd-card .code-block { margin: 0.75rem 0 0; }

    /* Code */
    .code-block {
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: 10px; padding: 1.25rem; margin: 1rem 0;
      overflow-x: auto;
    }
    .code-block pre { margin: 0; }
    .code-block code {
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 0.88rem; color: var(--fg-soft); line-height: 1.7;
    }

    /* Tables */
    .table-wrap {
      overflow-x: auto; border-radius: 10px;
      border: 1px solid var(--border); margin: 1rem 0;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.93rem; }
    th, td { text-align: left; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }
    th {
      background: var(--bg-elev); font-weight: 600; color: var(--fg);
      font-size: 0.85rem; letter-spacing: 0.02em; white-space: nowrap;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--bg-elev-2); }
    td.num { font-variant-numeric: tabular-nums; }
    td.win { color: var(--good); font-weight: 600; }
    td.bad { color: var(--muted); }
    td code {
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 0.85rem; background: var(--bg-elev-2);
      padding: 0.15rem 0.4rem; border-radius: 4px;
    }

    /* Search */
    .search-bar {
      margin: 1.5rem 0;
    }
    .search-bar input {
      width: 100%; padding: 0.85rem 1.25rem;
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: 10px; color: var(--fg); font-size: 0.95rem;
      outline: none; transition: border-color 0.15s;
    }
    .search-bar input::placeholder { color: var(--muted); }
    .search-bar input:focus { border-color: var(--accent); }

    /* Hardware cards */
    .hw-card {
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem;
      transition: border-color 0.15s;
    }
    .hw-card:hover { border-color: var(--accent); }
    .hw-card-header { margin-bottom: 0.75rem; }
    .hw-specs { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; margin-bottom: 0.5rem; }
    .hw-spec { font-size: 0.9rem; color: var(--fg-soft); }
    .hw-spec strong { color: var(--fg); }
    .hw-best {
      font-size: 0.88rem; color: var(--good); font-weight: 500;
      padding: 0.35rem 0.75rem; background: rgba(63, 185, 80, 0.1);
      border-radius: 6px; display: inline-block;
    }
    .hw-models { display: flex; flex-direction: column; gap: 0.5rem; }
    .hw-model {
      display: flex; align-items: center; gap: 1rem;
      padding: 0.5rem 0.75rem; border-radius: 8px;
      background: var(--bg-elev-2); font-size: 0.88rem;
    }
    .hw-model.recommended {
      border: 1px solid rgba(63, 185, 80, 0.3);
      background: rgba(63, 185, 80, 0.05);
    }
    .hw-model-name { font-weight: 600; color: var(--fg); min-width: 140px; }
    .hw-model-backend { color: var(--muted); min-width: 80px; }
    .hw-model-score { color: var(--good); font-weight: 500; min-width: 50px; }
    .hw-model-speed { color: var(--fg-soft); }

    /* Category badges */
    .cat-badge {
      font-size: 0.75rem; padding: 0.2rem 0.5rem;
      background: var(--bg-elev-2); border-radius: 4px;
      color: var(--muted); white-space: nowrap;
    }

    /* Model detail sections */
    .model-detail {
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: 12px; padding: 1.5rem; margin: 1rem 0;
    }
    .model-detail h3 { margin-top: 0; color: var(--fg); }
    .detail-meta {
      display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem;
      margin-bottom: 1rem; font-size: 0.88rem; color: var(--muted);
    }

    /* Phase cards */
    .phase-card {
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem;
    }
    .phase-card.active { border-left: 3px solid var(--good); }
    .phase-badge {
      font-size: 0.75rem; font-weight: 600; letter-spacing: 0.05em;
      text-transform: uppercase; color: var(--accent); margin-bottom: 0.5rem;
    }
    .phase-card.active .phase-badge { color: var(--good); }
    .phase-card h3 { margin-top: 0.25rem; }
    .phase-status {
      margin-top: 0.75rem; font-size: 0.88rem; color: var(--muted);
      padding: 0.5rem 0.75rem; background: var(--bg-elev-2);
      border-radius: 6px;
    }
    .phase-status code {
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 0.82rem; color: var(--fg-soft);
    }

    .hosting-notes { margin-top: 2rem; }

    /* Community reports */
    .community-section { margin-top: 2rem; }

    /* Category filter bar */
    .cat-filter-bar {
      display: flex; flex-wrap: wrap; gap: 0.5rem;
      margin: 1rem 0 1.5rem; padding: 0;
    }
    .cat-filter-btn {
      background: var(--bg-elev); border: 1px solid var(--border);
      color: var(--muted); font-size: 0.82rem; font-weight: 500;
      padding: 0.4rem 0.9rem; border-radius: 20px;
      cursor: pointer; transition: all 0.15s; white-space: nowrap;
    }
    .cat-filter-btn:hover { border-color: var(--accent); color: var(--fg-soft); }
    .cat-filter-btn.active {
      background: var(--accent); border-color: var(--accent);
      color: #fff; font-weight: 600;
    }

    /* Community report cards */
    .cr-card {
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: 12px; padding: 1.25rem; margin-bottom: 0.75rem;
      transition: border-color 0.15s;
    }
    .cr-card:hover { border-color: var(--accent); }
    .cr-card-header { margin-bottom: 0.5rem; }
    .cr-title-row {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 0.75rem;
    }
    .cr-title {
      font-size: 1rem; font-weight: 600; color: var(--fg);
      margin: 0; line-height: 1.4;
    }
    .cr-title a { color: var(--fg); text-decoration: none; }
    .cr-title a:hover { color: var(--accent); }
    .cr-score {
      flex-shrink: 0; font-size: 0.82rem; font-weight: 600;
      color: var(--muted); background: var(--bg-elev-2);
      padding: 0.2rem 0.6rem; border-radius: 6px;
      white-space: nowrap;
    }
    .cr-score-high { color: var(--good); background: rgba(63, 185, 80, 0.1); }
    .cr-score-mid { color: var(--warn); background: rgba(210, 153, 34, 0.1); }
    .cr-meta {
      display: flex; flex-wrap: wrap; gap: 0.4rem 0.8rem;
      margin-top: 0.35rem; font-size: 0.8rem; color: var(--muted);
    }
    .cr-flair {
      background: var(--bg-elev-2); padding: 0.1rem 0.45rem;
      border-radius: 4px; font-size: 0.75rem;
    }
    .cr-cat-badge {
      background: var(--accent-soft); color: var(--accent);
      padding: 0.1rem 0.45rem; border-radius: 4px;
      font-size: 0.72rem; font-weight: 500;
    }
    .cr-summary {
      font-size: 0.9rem; color: var(--fg-soft); margin: 0.5rem 0;
      line-height: 1.5;
    }
    .cr-comments {
      margin: 0.5rem 0; padding: 0.5rem 0;
      border-top: 1px solid var(--border);
    }
    .cr-comment {
      display: flex; flex-direction: column; gap: 0.15rem;
      padding: 0.35rem 0; font-size: 0.85rem;
    }
    .cr-comment + .cr-comment { border-top: 1px solid rgba(48, 54, 61, 0.5); padding-top: 0.45rem; }
    .cr-comment-meta {
      color: var(--muted); font-size: 0.78rem; font-weight: 500;
    }
    .cr-comment-text { color: var(--fg-soft); line-height: 1.45; }
    .cr-source {
      font-size: 0.82rem; color: var(--accent); text-decoration: none;
      display: inline-block; margin-top: 0.35rem;
    }
    .cr-source:hover { text-decoration: underline; }
    .no-results {
      text-align: center; color: var(--muted); padding: 2rem 1rem;
      font-size: 0.95rem;
    }

    /* Footer */
    footer {
      margin-top: 4rem; padding-top: 2rem;
      border-top: 1px solid var(--border);
      color: var(--muted); font-size: 0.85rem; text-align: center;
    }
    footer a { color: var(--accent); text-decoration: none; }
    .footer-sub { margin-top: 0.5rem; font-size: 0.78rem; }


    .breadcrumb { font-size: 0.85rem; color: var(--muted); margin-bottom: 1.5rem; }
    .breadcrumb a { color: var(--accent); text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    .page-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; margin-top: 2rem; }
    .page-card { display: block; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; text-decoration: none; color: var(--fg); transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s; }
    .page-card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(66,133,244,0.1); }
    .page-card-icon { font-size: 1.75rem; margin-bottom: 0.75rem; }
    .page-card h3 { font-size: 1.1rem; font-weight: 600; margin: 0 0 0.5rem; color: var(--fg); }
    .page-card p { font-size: 0.9rem; color: var(--fg-soft); margin: 0; line-height: 1.5; }
    .field-notes-section { margin-bottom: 2rem; }

    /* Responsive */
    @media (max-width: 640px) {
      h1 { font-size: 2rem; }
      .tagline { font-size: 1rem; }
      .nav-inner { padding: 0.5rem 1rem; }
      .nav-links { gap: 0.75rem; }
      .nav-links a { font-size: 0.84rem; padding: 0.35rem 0; }
      .wrap { padding: 1.5rem 1rem 3rem; }
      .page-cards { grid-template-columns: 1fr; }
      .hw-specs { flex-direction: column; gap: 0.25rem; }
      .hw-model { flex-wrap: wrap; gap: 0.5rem; }
      .cat-filter-bar { gap: 0.35rem; }
      .cat-filter-btn { font-size: 0.75rem; padding: 0.35rem 0.7rem; }
      .cr-title { font-size: 0.92rem; }
      .cr-card { padding: 1rem; }
      .cr-comment-text { font-size: 0.82rem; }
      .cap-grid { grid-template-columns: 1fr; }
      .example-list { grid-template-columns: 1fr; }
      .cap-intro { font-size: 0.92rem; }
      .cli-cmd-card { padding: 1rem; }
      .cli-cmd-card h4 { font-size: 0.95rem; }
    }
"""


if __name__ == "__main__":
    generate_site()
