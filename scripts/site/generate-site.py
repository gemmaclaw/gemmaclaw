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
    """Return the best result per model, preferring runs that captured model output (for the
    conversation viewer), then highest percentage, then most recent timestamp."""
    def has_output(r):
        tasks = r.get("tasks", [])
        return any(bool(t.get("output")) for t in tasks)
    def rank(r):
        return (1 if has_output(r) else 0, r["summary"]["percentage"], r.get("timestamp", ""))
    seen = {}
    for r in results:
        key = f"{r['model']}_{r['backend']}"
        if key not in seen or rank(r) > rank(seen[key]):
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


SIZE_CLASSES = {
    "Small (4B)": {
        "models": ["gemma3:4b", "gemma4-e4b", "gemma4:e4b"],
        "hw_rec": "Runs on 8GB RAM laptops or any machine with 4GB+ VRAM. Fast inference, good for quick tasks.",
        "icon": "&#128187;",
    },
    "Medium (27B MoE)": {
        "models": ["gemma4-26b-moe", "gemma4:26b-moe", "gemma4-27b"],
        "hw_rec": "Needs 16GB+ RAM or a GPU with 12GB+ VRAM. MoE architecture activates only part of the model per token, so it runs faster than its size suggests.",
        "icon": "&#9889;",
    },
    "Large (31B Dense)": {
        "models": ["gemma4-31b-dense", "gemma4:31b-dense"],
        "hw_rec": "Needs 24GB+ VRAM (e.g. RTX 3090/4090) or 64GB+ RAM for CPU inference. Highest quality but slowest.",
        "icon": "&#128296;",
    },
}


def classify_model_size(model_name):
    name_lower = model_name.lower().replace(":", "-").replace("__", "-")
    for cls_name, cls_info in SIZE_CLASSES.items():
        for pattern in cls_info["models"]:
            if pattern.lower().replace(":", "-") in name_lower:
                return cls_name
    if "4b" in name_lower or "e4b" in name_lower:
        return "Small (4B)"
    if "26b" in name_lower or "27b" in name_lower or "moe" in name_lower:
        return "Medium (27B MoE)"
    if "31b" in name_lower or "dense" in name_lower:
        return "Large (31B Dense)"
    return "Other"


def generate_size_class_sections(results):
    grouped = {}
    for r in results:
        cls = classify_model_size(r["model"])
        if cls not in grouped:
            grouped[cls] = []
        grouped[cls].append(r)

    sections = []
    for cls_name in list(SIZE_CLASSES.keys()) + ["Other"]:
        if cls_name not in grouped:
            continue
        cls_results = sorted(grouped[cls_name], key=lambda x: -x["summary"]["percentage"])
        cls_info = SIZE_CLASSES.get(cls_name, {"hw_rec": "", "icon": "&#128300;"})

        model_rows = []
        for r in cls_results:
            s = r["summary"]
            hw = r.get("hardware", {})
            gpu = hw.get("gpu", "None detected")
            if gpu == "None detected":
                gpu = "CPU only"
            pct = s["percentage"]
            pct_class = "win" if pct >= 95 else ("" if pct >= 80 else "bad")
            speed = format_speed(s.get("medianTokensPerSecond"))
            quant = ""
            model_name = r["model"]
            if "q5km" in model_name.lower() or "q5_k_m" in model_name.lower():
                quant = '<span class="quant-badge">Q5_K_M</span>'
            elif "q6k" in model_name.lower() or "q6_k" in model_name.lower():
                quant = '<span class="quant-badge">Q6_K</span>'
            model_rows.append(f"""<tr>
  <td><strong>{model_name}</strong> {quant}</td>
  <td>{r['backend']}</td>
  <td>{gpu}</td>
  <td class="num {pct_class}">{pct}%</td>
  <td class="num">{s['passedCount']}/{s['passedCount'] + s['failedCount']}</td>
  <td class="num">{speed} tok/s</td>
  <td class="num">{format_time(s.get('totalTimeMs'))}</td>
</tr>""")

        rows_html = "\n".join(model_rows)
        sections.append(f"""
<div class="size-class-group">
  <h3>{cls_info.get('icon', '')} {cls_name}</h3>
  <p class="hw-recommendation">{cls_info.get('hw_rec', '')}</p>
  <div class="table-wrap"><table class="benchmark-table">
    <thead><tr><th>Model</th><th>Backend</th><th>GPU</th><th>Quality</th><th>Pass Rate</th><th>Speed</th><th>Total Time</th></tr></thead>
    <tbody>{rows_html}</tbody>
  </table></div>
</div>""")

    return "\n".join(sections)


def generate_task_explanations(results):
    if not results:
        return ""
    tasks = results[0].get("tasks", [])
    if not tasks:
        return ""

    categories = {}
    for t in tasks:
        cat = t.get("category", "other")
        if cat not in categories:
            categories[cat] = []
        categories[cat].append(t)

    cat_labels = {
        "instruction_following": ("Instruction Following", "Can the model follow specific output format and content constraints?"),
        "reasoning": ("Reasoning", "Can the model perform logical and mathematical reasoning?"),
        "extraction": ("Data Extraction", "Can the model extract and restructure information from text?"),
        "safety": ("Safety", "Does the model refuse harmful requests and resist prompt injection?"),
        "coding": ("Coding", "Can the model write, debug, and optimize code?"),
    }

    sections = []
    for cat, cat_tasks in categories.items():
        label, desc = cat_labels.get(cat, (cat.replace("_", " ").title(), ""))
        task_items = []
        for t in cat_tasks:
            description = t.get("description", "")
            prompt_preview = t.get("prompt", "")[:120]
            if len(t.get("prompt", "")) > 120:
                prompt_preview += "..."
            prompt_preview = html_escape(prompt_preview).replace("\n", " ")
            diff_badge = f'<span class="diff-badge diff-{t.get("difficulty", "medium")}">{t.get("difficulty", "medium")}</span>'
            task_items.append(f"""<div class="task-explanation">
  <div class="task-header"><strong>{t['name']}</strong> {diff_badge}</div>
  <p class="task-desc">{html_escape(description)}</p>
  <p class="task-prompt"><em>Example:</em> <code>{prompt_preview}</code></p>
</div>""")

        items_html = "\n".join(task_items)
        sections.append(f"""<div class="task-category">
  <h4>{label}</h4>
  <p class="cat-desc">{desc}</p>
  {items_html}
</div>""")

    return "\n".join(sections)


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


def generate_task_detail_rows(tasks, model_id=""):
    rows = []
    for idx, t in enumerate(tasks):
        pct = t.get("percentage", 0)
        pct_class = "win" if pct >= 90 else ("" if pct >= 60 else "bad")
        speed = format_speed(t.get("tokensPerSecond"))
        failure = t.get("failureMode", "none")
        if failure == "none":
            failure = ""
        passed = t.get("passed", False)
        status_icon = "&#10003;" if passed else "&#10007;"
        status_class = "pass" if passed else "fail"
        difficulty = t.get("difficulty", "medium")
        method = t.get("method", "")
        prompt_tokens = t.get("promptTokens", 0)
        completion_tokens = t.get("completionTokens", 0)
        description = t.get("description", "")
        prompt_text = t.get("prompt", "")
        output_text = t.get("output", "")
        judge_text = t.get("details", "")
        score_pct = t.get("percentage", 0)
        judge_class = "judge-good" if score_pct >= 90 else ("judge-mid" if score_pct >= 60 else "judge-bad")

        if not output_text:
            output_block = '<div class="conv-empty">Model response was not captured for this run. Re-run the benchmark to capture full conversations.</div>'
        else:
            output_block = f'<pre class="conv-block">{html_escape(output_text)}</pre>'

        if not judge_text:
            judge_block = '<div class="conv-empty">No judge evaluation recorded.</div>'
        else:
            judge_block = f'<div class="conv-judge {judge_class}">{html_escape(judge_text)}</div>'

        row_id = f"task-{model_id}-{idx}" if model_id else f"task-{idx}"

        rows.append(f"""<tr class="task-row" data-target="{row_id}">
  <td><span class="row-toggle">&#9656;</span> <span class="task-status {status_class}">{status_icon}</span> {t['name']}</td>
  <td><span class="cat-badge">{t.get('category', '')}</span></td>
  <td class="num {pct_class}">{t['score']}/{t['maxScore']}</td>
  <td class="num">{speed} tok/s</td>
  <td class="num">{format_time(t.get('elapsedMs'))}</td>
  <td>{failure}</td>
</tr>
<tr class="task-detail" id="{row_id}" style="display:none">
  <td colspan="6">
    <div class="conv-meta">
      <span><strong>Difficulty:</strong> <span class="diff-badge diff-{difficulty}">{difficulty}</span></span>
      <span><strong>Scoring:</strong> {method or 'n/a'}</span>
      <span><strong>Tokens:</strong> {prompt_tokens} prompt &rarr; {completion_tokens} completion</span>
    </div>
    <p class="conv-desc">{html_escape(description)}</p>
    <div class="conv-section"><div class="conv-label">PROMPT</div><pre class="conv-block conv-prompt">{html_escape(prompt_text)}</pre></div>
    <div class="conv-section"><div class="conv-label">MODEL RESPONSE</div>{output_block}</div>
    <div class="conv-section"><div class="conv-label">JUDGE EVALUATION ({t['score']}/{t['maxScore']})</div>{judge_block}</div>
  </td>
</tr>""")
    return "\n".join(rows)


def generate_model_detail_sections(results):
    sections = []
    for r in results:
        model_id = re.sub(r"[^a-z0-9]+", "-", f"{r['model']}-{r['backend']}".lower())
        s = r["summary"]
        hw = r.get("hardware", {})
        tasks_html = generate_task_detail_rows(r.get("tasks", []), model_id=model_id)
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
    ("Run Benchmarks", "benchmarking.html", False),
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
      <p>Get a Gemma-powered AI agent running in minutes. Three paths depending on your setup: cloud API (fastest), Google Cloud Vertex AI (enterprise), or local hardware (private, no data leaves your machine).</p>

      <h3>Contents</h3>
      <ul class="setup-list">
        <li><a href="#install" class="inline">Install Gemmaclaw</a></li>
        <li><a href="#path-gemini" class="inline">Path 1: Gemini API</a> (fastest, no local hardware)</li>
        <li><a href="#path-vertex" class="inline">Path 2: Vertex AI</a> (enterprise, GCP integration)</li>
        <li><a href="#path-local" class="inline">Path 3: Local</a> (private, auto-detects your GPU)</li>
        <li><a href="#after-setup" class="inline">After Setup</a> (create agents, chat, message)</li>
        <li><a href="#cli-reference" class="inline">CLI Reference</a></li>
        <li><a href="#troubleshooting" class="inline">Troubleshooting</a></li>
      </ul>

      <h3 id="install">Install Gemmaclaw</h3>
      <div class="code-block"><pre><code>git clone https://github.com/gemmaclaw/gemmaclaw.git
cd gemmaclaw
corepack enable &amp;&amp; pnpm install
pnpm build
npm install -g .</code></pre></div>
      <p>Requires Node.js 22+. Docker is recommended for sandboxed tool execution but not required.</p>
      <p><strong>Shared files:</strong> When Docker sandbox is enabled, <code>~/.gemmaclaw/shared/</code> on your machine is automatically mounted at <code>/shared</code> inside the container. Drop files there for the agent to use, or find agent output there after a task completes. Created automatically on first run.</p>

      <h3 id="path-gemini">Path 1: Gemini API (Cloud, fastest)</h3>
      <p>Use Google's hosted Gemini API. No local GPU needed, no model downloads. Get an API key from <a href="https://aistudio.google.com/apikey" class="inline">Google AI Studio</a> (free tier available).</p>

      <div class="code-block"><pre><code># Set your API key, then run setup
export GEMINI_API_KEY=YOUR_KEY
gemmaclaw setup

# Or run setup interactively (will prompt you to choose a provider and enter your key)
gemmaclaw setup --wizard</code></pre></div>

      <p>Available models: gemma-3-1b-it, gemma-3-4b-it, gemma-3-12b-it, gemma-3-27b-it. The setup wizard recommends the best model for your use case.</p>

      <h3 id="path-vertex">Path 2: Vertex AI (Cloud, enterprise)</h3>
      <p>For GCP-integrated deployments. Uses your gcloud credentials or a service account. Requires a GCP project with the Vertex AI API enabled.</p>

      <div class="code-block"><pre><code># Prerequisites
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID

# Interactive setup (prompts for project, region, model)
gemmaclaw setup --vertex

# Non-interactive with flags
gemmaclaw setup --vertex \\
  --vertex-project my-gcp-project \\
  --vertex-region us-central1 \\
  --vertex-model gemma-3-27b-it

# With a service account key
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
gemmaclaw setup --vertex --vertex-project my-project</code></pre></div>

      <p>For Docker, mount your gcloud credentials:</p>
      <div class="code-block"><pre><code>docker run -v ~/.config/gcloud:/root/.config/gcloud gemmaclaw setup --vertex</code></pre></div>

      <div class="table-wrap"><table>
        <thead><tr><th>Flag</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>--vertex</code></td><td>Enable Vertex AI setup (required)</td></tr>
          <tr><td><code>--vertex-project &lt;id&gt;</code></td><td>GCP project ID (auto-detected from gcloud if not set)</td></tr>
          <tr><td><code>--vertex-region &lt;region&gt;</code></td><td>GCP region (default: us-central1)</td></tr>
          <tr><td><code>--vertex-model &lt;model&gt;</code></td><td>Gemma model (e.g. gemma-3-27b-it)</td></tr>
        </tbody>
      </table></div>

      <h3 id="path-local">Path 3: Local (Private, auto-detect hardware)</h3>
      <p>Run Gemma entirely on your machine. No data leaves your network. Gemmaclaw detects your GPU and RAM, picks the best model, downloads and provisions everything automatically.</p>

      <div class="code-block"><pre><code># Auto-detect everything (recommended)
gemmaclaw setup

# Advanced: choose backend and model manually
gemmaclaw setup --advanced

# CI/scripted: non-interactive with defaults
gemmaclaw setup --non-interactive --accept-risk --no-container</code></pre></div>

      <p><strong>What happens:</strong></p>
      <ol class="setup-steps">
        <li><strong>Hardware detection:</strong> probes GPU (NVIDIA CUDA, Apple Metal), CPU, and RAM</li>
        <li><strong>Tier classification:</strong> maps your hardware to the best Gemma 4 model</li>
        <li><strong>Provisioning:</strong> installs Ollama (or llama.cpp), pulls the model, runs smoke test</li>
        <li><strong>Configuration:</strong> writes config with the selected provider and model</li>
        <li><strong>Verification:</strong> confirms the model responds correctly</li>
      </ol>

      <p><strong>Supported backends:</strong></p>
      <div class="table-wrap"><table>
        <thead><tr><th>Backend</th><th>Best for</th><th>GPU</th></tr></thead>
        <tbody>
          <tr><td>Ollama</td><td>Most users. Managed model server, easy model switching.</td><td>NVIDIA, Apple Silicon</td></tr>
          <tr><td>llama.cpp</td><td>Advanced users. Raw GGUF, lower overhead, custom quants.</td><td>NVIDIA, CPU-only</td></tr>
          <tr><td>gemma.cpp</td><td>Gemma 2/3 on CPU. Requires cmake + build tools.</td><td>CPU-only</td></tr>
        </tbody>
      </table></div>

      <div class="table-wrap"><table>
        <thead><tr><th>Flag</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>--advanced</code></td><td>Interactive wizard for manual backend/model/port selection</td></tr>
          <tr><td><code>--no-container</code></td><td>Run gateway directly on the host (skip Docker sandbox)</td></tr>
          <tr><td><code>--non-interactive</code></td><td>Run without prompts (uses safe defaults)</td></tr>
          <tr><td><code>--accept-risk</code></td><td>Required with <code>--non-interactive</code></td></tr>
          <tr><td><code>--workspace &lt;dir&gt;</code></td><td>Agent workspace directory</td></tr>
        </tbody>
      </table></div>

      <h3 id="after-setup">After Setup</h3>
      <div class="code-block"><pre><code># Create a named agent instance
gemmaclaw create work

# Open chat UI in your browser
gemmaclaw chat

# One-shot message from the command line
gemmaclaw message --agent work "summarize today's news"

# Terminal UI (for SSH sessions)
gemmaclaw tui</code></pre></div>
      <h3 id="cli-reference">CLI Reference</h3>
      <p>Global options available on all commands:</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Option</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>--profile &lt;name&gt;</code></td><td>Use a named profile (isolates state under <code>~/.openclaw-&lt;name&gt;</code>)</td></tr>
          <tr><td><code>--dev</code></td><td>Dev profile: isolate state under <code>~/.openclaw-dev</code>, use port 19001</td></tr>
          <tr><td><code>--log-level &lt;level&gt;</code></td><td>Log level: silent, fatal, error, warn, info, debug, trace</td></tr>
          <tr><td><code>--no-color</code></td><td>Disable ANSI colors</td></tr>
          <tr><td><code>-V, --version</code></td><td>Print version and commit hash</td></tr>
        </tbody>
      </table></div>

      <div class="cli-cmd-card">
        <h4 id="cmd-setup"><code>gemmaclaw setup</code></h4>
        <p>Initialize local config, auto-detect hardware, provision a Gemma backend, and start the assistant. Recommended first command for new installs.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Option</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>--advanced</code></td><td>Interactive wizard for manual backend/model/port selection</td></tr>
            <tr><td><code>--no-container</code></td><td>Run gateway directly on the host (skip Docker sandbox)</td></tr>
            <tr><td><code>--non-interactive</code></td><td>Run without prompts (uses safe defaults)</td></tr>
            <tr><td><code>--accept-risk</code></td><td>Required with <code>--non-interactive</code>; acknowledges local agent system-access risk</td></tr>
            <tr><td><code>--wizard</code></td><td>Run interactive workspace config onboarding</td></tr>
            <tr><td><code>--workspace &lt;dir&gt;</code></td><td>Agent workspace directory (default: <code>~/.openclaw/workspace</code>)</td></tr>
            <tr><td><code>--workspace-only</code></td><td>Only initialize workspace config, skip Gemma provisioning</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code># Auto-detect everything (recommended)
gemmaclaw setup

# Manual backend/model selection
gemmaclaw setup --advanced

# CI/scripted environments
gemmaclaw setup --non-interactive --accept-risk --no-container</code></pre></div>
      </div>

      <div class="cli-cmd-card">
        <h4 id="cmd-create"><code>gemmaclaw create</code></h4>
        <p>Create a new named Gemmaclaw instance (agent). Each instance gets its own workspace, sessions, and configuration. Provision a backend with <code>gemmaclaw setup</code> first.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Option</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>[name]</code></td><td>Agent name/id (positional or via <code>--name</code>)</td></tr>
            <tr><td><code>--workspace &lt;dir&gt;</code></td><td>Workspace directory for this instance</td></tr>
            <tr><td><code>--model &lt;id&gt;</code></td><td>Model id (e.g. <code>ollama/gemma3:4b</code>)</td></tr>
            <tr><td><code>--non-interactive</code></td><td>Disable prompts (requires name)</td></tr>
            <tr><td><code>--json</code></td><td>Output JSON summary</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code># Interactive create
gemmaclaw create work

# Non-interactive with model
gemmaclaw create dev --model ollama/gemma3:4b --workspace ~/.openclaw/workspace/dev

# Scripted/CI
gemmaclaw create play --non-interactive</code></pre></div>
      </div>

      <div class="cli-cmd-card">
        <h4 id="cmd-list"><code>gemmaclaw list</code></h4>
        <p>List all configured Gemmaclaw instances. Alias for <code>gemmaclaw agents list</code>.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Option</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>--json</code></td><td>Output JSON instead of text</td></tr>
            <tr><td><code>--bindings</code></td><td>Include routing bindings</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code>gemmaclaw list
gemmaclaw list --json</code></pre></div>
      </div>

      <div class="cli-cmd-card">
        <h4 id="cmd-chat"><code>gemmaclaw chat</code></h4>
        <p>Start the gateway and open the web chat UI in your default browser. When multiple agents are configured, pass <code>--agent</code> or pick one interactively.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Option</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>--agent &lt;id&gt;</code></td><td>Target agent id (skips interactive picker)</td></tr>
            <tr><td><code>--no-open</code></td><td>Start gateway but don't auto-open the browser</td></tr>
            <tr><td><code>--port &lt;port&gt;</code></td><td>Gateway port (default: auto-detected from config)</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code>gemmaclaw chat
gemmaclaw chat --agent work
gemmaclaw chat --no-open --port 3001</code></pre></div>
      </div>

      <div class="cli-cmd-card">
        <h4 id="cmd-message"><code>gemmaclaw message</code></h4>
        <p>Send a one-shot message to a Gemmaclaw agent and print the response. Supports positional text, <code>--text</code> flag, or piped stdin. Useful for scripting and automation.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Option</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>--agent &lt;id&gt;</code></td><td>Target agent id (required if multiple agents configured)</td></tr>
            <tr><td><code>--text &lt;text&gt;</code></td><td>Message body (alternative to positional or stdin)</td></tr>
            <tr><td><code>--json</code></td><td>Output result as JSON</td></tr>
            <tr><td><code>--thinking &lt;level&gt;</code></td><td>Thinking level: off, minimal, low, medium, high</td></tr>
            <tr><td><code>--timeout &lt;seconds&gt;</code></td><td>Override agent command timeout</td></tr>
            <tr><td><code>--local</code></td><td>Run the embedded agent locally</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code># One-shot message
gemmaclaw message --agent dev "summarize today's news"

# Pipe from stdin
echo "what is 2+2?" | gemmaclaw message --agent dev

# JSON output
gemmaclaw message --agent dev --text "hi" --json</code></pre></div>
      </div>

      <div class="cli-cmd-card">
        <h4 id="cmd-tui"><code>gemmaclaw tui</code></h4>
        <p>Terminal-based chat UI. Useful for SSH sessions or when you prefer the terminal.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Option</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>--message &lt;text&gt;</code></td><td>Send an initial message after connecting</td></tr>
            <tr><td><code>--session &lt;key&gt;</code></td><td>Session key (default: "main")</td></tr>
            <tr><td><code>--local</code></td><td>Run against the local embedded agent runtime</td></tr>
            <tr><td><code>--url &lt;url&gt;</code></td><td>Gateway WebSocket URL (for remote gateways)</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code>gemmaclaw tui
gemmaclaw tui --message "summarize my last meeting"
gemmaclaw tui --url ws://192.168.1.50:3001</code></pre></div>
      </div>

      <div class="cli-cmd-card">
        <h4 id="cmd-gateway"><code>gemmaclaw gateway</code></h4>
        <p>Run, manage, and inspect the WebSocket gateway that handles communication between the model, chat channels, and the web UI.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Subcommand</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>run</code></td><td>Run the gateway in the foreground</td></tr>
            <tr><td><code>start / stop / restart</code></td><td>Manage the gateway system service</td></tr>
            <tr><td><code>status</code></td><td>Show service status and connectivity info</td></tr>
            <tr><td><code>health</code></td><td>Fetch health from the running gateway</td></tr>
            <tr><td><code>install / uninstall</code></td><td>Install or remove the system service</td></tr>
            <tr><td><code>discover</code></td><td>Find gateways on the local network</td></tr>
            <tr><td><code>diagnostics</code></td><td>Export support diagnostics bundle</td></tr>
          </tbody>
        </table></div>
        <p>Key options for <code>gateway run</code>:</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Option</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>--port &lt;port&gt;</code></td><td>Port for the gateway WebSocket</td></tr>
            <tr><td><code>--bind &lt;mode&gt;</code></td><td>Bind mode: loopback, lan, tailnet, auto, custom</td></tr>
            <tr><td><code>--auth &lt;mode&gt;</code></td><td>Auth: none, token, password, trusted-proxy</td></tr>
            <tr><td><code>--verbose</code></td><td>Verbose logging to stdout/stderr</td></tr>
            <tr><td><code>--tailscale &lt;mode&gt;</code></td><td>Tailscale exposure: off, serve, funnel</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code>gemmaclaw gateway run --verbose
gemmaclaw gateway install &amp;&amp; gemmaclaw gateway start
gemmaclaw gateway status</code></pre></div>
      </div>

      <div class="cli-cmd-card">
        <h4 id="cmd-models"><code>gemmaclaw models</code></h4>
        <p>Discover, scan, and configure models. Manage which model your assistant uses and set fallbacks.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Subcommand</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>list</code></td><td>List configured models</td></tr>
            <tr><td><code>set &lt;model&gt;</code></td><td>Set the default model</td></tr>
            <tr><td><code>status</code></td><td>Show configured model state</td></tr>
            <tr><td><code>scan</code></td><td>Scan OpenRouter free models</td></tr>
            <tr><td><code>aliases</code></td><td>Manage model aliases</td></tr>
            <tr><td><code>fallbacks</code></td><td>Manage model fallback list</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code>gemmaclaw models status
gemmaclaw models list
gemmaclaw models set gemma3:12b</code></pre></div>
      </div>

      <div class="cli-cmd-card">
        <h4 id="cmd-channels"><code>gemmaclaw channels</code></h4>
        <p>Manage connected chat channels (Telegram, Discord, WhatsApp, and more).</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Subcommand</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>list</code></td><td>List configured channels and auth profiles</td></tr>
            <tr><td><code>add</code></td><td>Add or update a channel account</td></tr>
            <tr><td><code>login</code></td><td>Link a channel account (interactive)</td></tr>
            <tr><td><code>status</code></td><td>Show gateway channel status</td></tr>
            <tr><td><code>capabilities</code></td><td>Show provider capabilities</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code>gemmaclaw channels list
gemmaclaw channels add --channel telegram --token &lt;bot-token&gt;
gemmaclaw channels login --channel whatsapp
gemmaclaw channels status --probe</code></pre></div>
      </div>

      <div class="cli-cmd-card">
        <h4 id="cmd-benchmark"><code>gemmaclaw benchmark</code></h4>
        <p>Run the benchmark suite against your local Gemma model. Tests instruction following, reasoning, data extraction, safety, and coding across 15+ tasks.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Option</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>--model &lt;model&gt;</code></td><td>Model name or Ollama tag</td></tr>
            <tr><td><code>--backend &lt;backend&gt;</code></td><td>Backend: ollama or llama-cpp</td></tr>
            <tr><td><code>--mock</code></td><td>Deterministic scoring (no LLM judge, fast CI mode)</td></tr>
            <tr><td><code>--filter &lt;text&gt;</code></td><td>Run only tasks matching this text</td></tr>
            <tr><td><code>--context-length &lt;n&gt;</code></td><td>Context window size</td></tr>
            <tr><td><code>--gpu-layers &lt;n&gt;</code></td><td>Number of GPU layers</td></tr>
            <tr><td><code>--pack &lt;name&gt;</code></td><td>Task pack: core, jake-agent, or custom path</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code>gemmaclaw benchmark --model gemma3:4b
gemmaclaw benchmark --mock --model gemma3:4b
gemmaclaw benchmark --filter "coding" --model gemma3:4b</code></pre></div>
        <h4 id="cmd-benchmark-submit"><code>gemmaclaw benchmark submit</code></h4>
        <p>Anonymize results and open a PR to share with the community.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Option</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>--dry-run</code></td><td>Print payload without pushing</td></tr>
            <tr><td><code>-y, --yes</code></td><td>Skip confirmation prompts</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code>gemmaclaw benchmark submit --dry-run
gemmaclaw benchmark submit</code></pre></div>
      </div>

      <div class="cli-cmd-card">
        <h4 id="cmd-doctor"><code>gemmaclaw doctor</code></h4>
        <p>Health checks on the gateway, channels, and configuration with auto-fix capabilities.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Option</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>--fix</code></td><td>Apply recommended repairs automatically</td></tr>
            <tr><td><code>--deep</code></td><td>Scan system services for extra gateway installs</td></tr>
            <tr><td><code>--force</code></td><td>Aggressive repairs (overwrites custom config)</td></tr>
            <tr><td><code>--non-interactive</code></td><td>Run without prompts</td></tr>
            <tr><td><code>--generate-gateway-token</code></td><td>Generate a gateway auth token</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code>gemmaclaw doctor
gemmaclaw doctor --fix
gemmaclaw doctor --deep --fix --non-interactive</code></pre></div>
      </div>

      <div class="cli-cmd-card">
        <h4 id="cmd-plugins"><code>gemmaclaw plugins</code></h4>
        <p>Manage plugins and extensions. Install community plugins, enable/disable bundled ones, and diagnose issues.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Subcommand</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>list</code></td><td>List discovered plugins</td></tr>
            <tr><td><code>install &lt;spec&gt;</code></td><td>Install a plugin (path, npm, or marketplace)</td></tr>
            <tr><td><code>uninstall / enable / disable</code></td><td>Manage installed plugins</td></tr>
            <tr><td><code>update</code></td><td>Update installed plugins</td></tr>
            <tr><td><code>doctor</code></td><td>Report plugin load issues</td></tr>
            <tr><td><code>marketplace</code></td><td>Browse plugin marketplaces</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code>gemmaclaw plugins list
gemmaclaw plugins install @example/my-plugin
gemmaclaw plugins doctor</code></pre></div>
      </div>

      <div class="cli-cmd-card">
        <h4 id="cmd-provision"><code>gemmaclaw provision</code></h4>
        <p>Manually install and start a specific Gemma backend.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Option</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>--backend &lt;backend&gt;</code></td><td>Backend: ollama, llama-cpp, or gemma-cpp</td></tr>
            <tr><td><code>--model &lt;model&gt;</code></td><td>Model to pull</td></tr>
            <tr><td><code>--port &lt;port&gt;</code></td><td>Port for the backend API server</td></tr>
            <tr><td><code>--no-verify</code></td><td>Skip post-provision verification</td></tr>
          </tbody>
        </table></div>
        <div class="code-block"><pre><code>gemmaclaw provision --backend ollama --model gemma3:12b
gemmaclaw provision --backend llama-cpp --port 8081
gemmaclaw provision --backend gemma-cpp</code></pre></div>
      </div>

      <h3>Other Useful Commands</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Command</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>gemmaclaw status</code></td><td>Show channel health and recent sessions</td></tr>
          <tr><td><code>gemmaclaw health</code></td><td>Fetch health from the running gateway</td></tr>
          <tr><td><code>gemmaclaw config get/set</code></td><td>Read or write config values</td></tr>
          <tr><td><code>gemmaclaw configure</code></td><td>Interactive config wizard</td></tr>
          <tr><td><code>gemmaclaw logs</code></td><td>Tail gateway logs</td></tr>
          <tr><td><code>gemmaclaw memory</code></td><td>Search and reindex the memory system</td></tr>
          <tr><td><code>gemmaclaw skills</code></td><td>List available skills</td></tr>
          <tr><td><code>gemmaclaw sessions</code></td><td>List stored sessions</td></tr>
          <tr><td><code>gemmaclaw reset</code></td><td>Reset local config and state</td></tr>
          <tr><td><code>gemmaclaw dashboard</code></td><td>Open the Control UI</td></tr>
          <tr><td><code>gemmaclaw completion</code></td><td>Generate shell completion script</td></tr>
        </tbody>
      </table></div>

      <h3>Configuration</h3>
      <p>Config lives at <code>~/.openclaw/openclaw.json</code>. Edit directly or use the CLI:</p>
      <div class="code-block"><pre><code>gemmaclaw config get gateway.port
gemmaclaw config set gateway.port 3001
gemmaclaw config validate
gemmaclaw configure</code></pre></div>
      <p>Named profiles (<code>--profile mytest</code>) isolate all state under <code>~/.openclaw-mytest/</code>, useful for testing or running multiple instances.</p>

      <h3 id="troubleshooting">Troubleshooting</h3>
      <ul class="setup-list">
        <li><strong>Ollama download fails:</strong> check network. Binary comes from GitHub releases.</li>
        <li><strong>llama.cpp server won't start:</strong> verify model at <code>~/.gemmaclaw/models/llama-cpp/</code>. Re-run <code>gemmaclaw provision --backend llama-cpp</code>.</li>
        <li><strong>gemma.cpp build fails:</strong> ensure cmake and g++ (or clang++) are installed.</li>
        <li><strong>"Healthcheck failed":</strong> backend did not respond in time. Run <code>gemmaclaw doctor</code>.</li>
        <li><strong>Port in use:</strong> use <code>--port N</code> or <code>gemmaclaw setup --advanced</code>.</li>
        <li><strong>Config validation warnings:</strong> run <code>gemmaclaw doctor --fix</code>.</li>
        <li><strong>Plugin load errors:</strong> run <code>gemmaclaw plugins doctor</code>.</li>
        <li><strong>Channel disconnected:</strong> check <code>gemmaclaw channels status --probe</code> and re-login.</li>
        <li><strong>Gateway won't start:</strong> try <code>gemmaclaw gateway run --verbose</code>, then <code>gemmaclaw doctor --deep --fix</code>.</li>
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
    if (searchInput) { searchInput.addEventListener('input', function() {
      const q = this.value.toLowerCase().trim();
      hwCards.forEach(card => { card.style.display = (!q || (card.getAttribute('data-search') || '').includes(q)) ? '' : 'none'; });
    }); }
"""
    return page_template("Self-Hosting Guide", body, active_page="self-hosting.html", extra_scripts=scripts)

def generate_benchmarks_page(benchmark_rows, model_details, size_class_html="", task_explanations_html=""):
    # COMING SOON: Do NOT remove this block until Frank explicitly approves
    # the new benchmark results. The old results had wrong GPU detection and
    # incomplete test explanations. PR #69 added this, PR #71 removed it.
    # Frank directive: keep coming soon until proper benchmarks are ready.
    _BENCHMARKS_COMING_SOON = True  # Set to False when new benchmarks are approved
    if _BENCHMARKS_COMING_SOON:
        body = """<div class="breadcrumb"><a href="index.html">Home</a> / Benchmarks</div>
        <section id="benchmarks" style="text-align:center;padding:4rem 2rem">
          <div style="border:2px dashed var(--border);border-radius:16px;background:var(--bg-elev);padding:4rem 2rem;max-width:700px;margin:0 auto">
            <h2 style="font-size:2rem;margin-bottom:1rem">Benchmarks Coming Soon</h2>
            <p style="color:var(--muted);font-size:1.1rem;max-width:600px;margin:0 auto 2rem">We are rebuilding the benchmark suite from the ground up with full transparency into what each test measures and how models perform.</p>
            <div style="text-align:left;max-width:500px;margin:0 auto">
              <div style="padding:0.5rem 0;color:var(--fg-soft)">All Gemma 4 models tested on RTX 3090</div>
              <div style="padding:0.5rem 0;color:var(--fg-soft)">Full conversation viewer: see prompt, response, and judge scoring</div>
              <div style="padding:0.5rem 0;color:var(--fg-soft)">Clear test explanations: what each test measures and why</div>
              <div style="padding:0.5rem 0;color:var(--fg-soft)">Models grouped by size class with hardware requirements</div>
              <div style="padding:0.5rem 0;color:var(--fg-soft)">Speed benchmarks alongside quality scores</div>
            </div>
          </div>
        </section>"""
        return page_template("Benchmarks", body, active_page="benchmarks.html")

    body = f"""<div class="breadcrumb"><a href="index.html">Home</a> / Benchmarks</div>
    <section id="benchmarks">
      <h2>Benchmark Results by Size Class</h2>
      <p>All models are tested on the same 15-task suite covering instruction following, reasoning, data extraction, safety, and coding. Models are grouped by size class with hardware requirements per tier. Click any model to expand its task breakdown, then click any task row to see the full prompt, the model's response, and the LLM judge's evaluation.</p>
      {size_class_html}
      <div id="model-details">{model_details}</div>
    </section>
    <section id="task-explanations">
      <h2>What We Test</h2>
      <p>Each benchmark run evaluates the model on 15 tasks across 5 categories. Here is what each task measures and an example prompt.</p>
      {task_explanations_html}
    </section>
    <section id="methodology">
      <h2>Methodology</h2>
      <p>Each task is scored either deterministically (exact-match or rule-based) or by an LLM judge that grades against a per-task rubric (max score reflects rubric weight, typically 5 for easy, 10 for medium, 15 for hard). A task counts as a pass when it scores at least 60%. Speed is measured in tokens per second of completion output, recorded per task and aggregated as median over the run. Total time covers the full 15-task suite end-to-end on a single GPU. Hardware is auto-detected, including WSL2 GPU detection via <code>/usr/lib/wsl/lib/nvidia-smi</code>. All runs are deterministic at temperature 0 unless a task explicitly requires creative generation.</p>
    </section>"""
    scripts = """
    document.querySelectorAll('.benchmark-table tbody tr').forEach(row => {
      if (row.classList.contains('task-row') || row.classList.contains('task-detail')) return;
      row.style.cursor = 'pointer';
      row.addEventListener('click', function() {
        const model = this.querySelector('td strong')?.textContent || '';
        const backend = this.querySelectorAll('td')[1]?.textContent || '';
        const id = (model + '-' + backend).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const detail = document.getElementById('detail-' + id);
        if (detail) {
          const isVisible = detail.style.display !== 'none';
          document.querySelectorAll('.model-detail').forEach(d => d.style.display = 'none');
          detail.style.display = isVisible ? 'none' : 'block';
          if (!isVisible) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
    document.querySelectorAll('.model-detail').forEach(d => d.style.display = 'none');

    document.querySelectorAll('tr.task-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', function(ev) {
        ev.stopPropagation();
        const target = document.getElementById(this.getAttribute('data-target'));
        if (!target) return;
        const isOpen = target.style.display !== 'none';
        target.style.display = isOpen ? 'none' : 'table-row';
        const toggle = this.querySelector('.row-toggle');
        if (toggle) toggle.innerHTML = isOpen ? '&#9656;' : '&#9662;';
        this.classList.toggle('open', !isOpen);
      });
    });
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
    function applyFilters() {
      const q = (searchInput ? searchInput.value : '').toLowerCase().trim();
      crCards.forEach(card => {
        const text = card.getAttribute('data-search') || '';
        const cats = card.getAttribute('data-cats') || '';
        card.style.display = ((!q || text.includes(q)) && (activeCat === 'all' || cats.split(' ').includes(activeCat))) ? '' : 'none';
      });
      const container = document.getElementById('community-cards');
      if (container) {
        const visible = container.querySelectorAll('.cr-card:not([style*="display: none"])');
        let noResults = container.querySelector('.no-results');
        if (visible.length === 0) {
          if (!noResults) { noResults = document.createElement('p'); noResults.className = 'no-results'; noResults.textContent = 'No reports match your filters.'; container.appendChild(noResults); }
          noResults.style.display = '';
        } else if (noResults) { noResults.style.display = 'none'; }
      }
    }
    if (searchInput) { searchInput.addEventListener('input', applyFilters); }
    document.querySelectorAll('.cat-filter-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.cat-filter-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        activeCat = this.getAttribute('data-cat');
        applyFilters();
      });
    });
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
          <li>Named multi-instance agents: <code>create</code>, <code>list</code>, <code>chat --agent</code>, <code>message</code></li>
        </ul>
        <div class="phase-status">Status: Live. <code>gemmaclaw setup</code> auto-detects and provisions. Multi-instance agent management shipped.</div>
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


def generate_benchmarking_page():
    body = """<div class="breadcrumb"><a href="index.html">Home</a> / Run Benchmarks</div>
    <section>
      <h2>Running Gemmaclaw Benchmarks</h2>
      <p>Gemmaclaw includes a built-in E2E agentic benchmark harness that evaluates Gemma models as AI agents with real tool use. The harness dispatches 22 complex agent tasks, captures full conversations including tool calls, and saves structured results ready for PR submission.</p>
      <p>Each task runs in an isolated environment with mock tools (email, calendar, tasks, contacts). The model and backend are auto-detected from your hardware, or you can specify them explicitly.</p>

      <h3>Quick Start</h3>
      <div class="code-block"><pre><code># 1. Set up gemmaclaw (auto-detects hardware, installs backend, pulls model)
gemmaclaw setup

# 2. List all benchmark tasks
pnpm benchmark agent list

# 3. Run all 22 agentic tasks (model auto-selected from your hardware)
pnpm benchmark agent

# 4. Run with a specific model
pnpm benchmark agent --model gemma4:31b --quant Q4_K_M --thinking high

# 5. Run a single task (useful for debugging or rerunning failures)
pnpm benchmark agent --task email_triage

# 6. Mock mode: test the harness without a real model (instant)
pnpm benchmark agent --mock</code></pre></div>

      <h3>Backends</h3>
      <p>The benchmark supports two inference backends:</p>
      <div class="cli-cmd-card">
        <h4>Ollama (default)</h4>
        <p>Managed model server. Supports all Gemma 4 models including multimodal. Installed automatically by <code>gemmaclaw setup</code>.</p>
        <div class="code-block"><pre><code>pnpm benchmark agent --model gemma4:e4b
pnpm benchmark agent --model gemma4:31b --ollama-url http://192.168.1.50:11434</code></pre></div>
      </div>
      <div class="cli-cmd-card">
        <h4>llama.cpp</h4>
        <p>OpenAI-compatible API via llama-server. Lower overhead, useful for CPU-only systems and custom quantizations.</p>
        <div class="code-block"><pre><code># Start llama-server (requires a GGUF model file)
llama-server -m /path/to/model.gguf --port 8080 --n-gpu-layers 99

# Run benchmark against it
pnpm benchmark agent --model gemma3:1b --backend llama-cpp --llama-cpp-url http://127.0.0.1:8080</code></pre></div>
      </div>

      <h3>Configuration Options</h3>
      <div class="table-wrap"><table>
        <tr><th>Flag</th><th>Default</th><th>Description</th></tr>
        <tr><td><code>--model &lt;name&gt;</code></td><td>(auto from hardware)</td><td>Model to test (e.g. gemma4:e4b, gemma4:31b)</td></tr>
        <tr><td><code>--backend &lt;type&gt;</code></td><td>ollama</td><td>Backend: ollama or llama-cpp</td></tr>
        <tr><td><code>--quant &lt;level&gt;</code></td><td>(auto-detected)</td><td>Quantization to record (Q4_K_M, Q8_0, FP16)</td></tr>
        <tr><td><code>--thinking &lt;level&gt;</code></td><td>default</td><td>Thinking level (off, low, medium, high)</td></tr>
        <tr><td><code>--filter &lt;text&gt;</code></td><td>(all tasks)</td><td>Run tasks matching text (id or name)</td></tr>
        <tr><td><code>--task &lt;id&gt;</code></td><td>(all tasks)</td><td>Run a single task by exact id</td></tr>
        <tr><td><code>--ollama-url &lt;url&gt;</code></td><td>http://127.0.0.1:11434</td><td>Ollama API URL</td></tr>
        <tr><td><code>--llama-cpp-url &lt;url&gt;</code></td><td>http://127.0.0.1:8080</td><td>llama.cpp server URL</td></tr>
        <tr><td><code>--task-timeout &lt;sec&gt;</code></td><td>600</td><td>Max seconds per task (0 = unlimited)</td></tr>
        <tr><td><code>--idle-timeout &lt;sec&gt;</code></td><td>30</td><td>Idle seconds before task considered done</td></tr>
        <tr><td><code>--context-length &lt;n&gt;</code></td><td>(model default)</td><td>Context window size</td></tr>
        <tr><td><code>--output-dir &lt;dir&gt;</code></td><td>benchmark-results</td><td>Output directory</td></tr>
        <tr><td><code>--mock</code></td><td>off</td><td>Mock mode: no model, instant pass</td></tr>
      </table></div>

      <h3>The 22 Agent Tasks</h3>
      <p>Tasks evaluate Gemma models as AI agents. Each task sends a natural language request, the agent decides which tools to call, interprets results, and takes follow-up actions. The full conversation is captured for review.</p>

      <div class="table-wrap"><table>
        <tr><th>Difficulty</th><th>Tasks</th><th>Points</th><th>Categories</th></tr>
        <tr><td>Medium</td><td>5</td><td>53</td><td>Email, calendar, task management, memory</td></tr>
        <tr><td>Hard</td><td>5</td><td>110</td><td>Email triage, multi-meeting scheduling, client logistics, event coordination</td></tr>
        <tr><td>Very Hard</td><td>12</td><td>335</td><td>Phishing detection, error recovery, data reconciliation, multi-person coordination, financial synthesis, context chaining</td></tr>
        <tr><td><strong>Total</strong></td><td><strong>22</strong></td><td><strong>498</strong></td><td></td></tr>
      </table></div>

      <h3>How It Works</h3>
      <ol class="setup-steps">
        <li><strong>Hardware detection:</strong> The harness uses the same model catalog as <code>gemmaclaw setup</code> to auto-select the best model for your hardware. Override with <code>--model</code> if desired.</li>
        <li><strong>Seed mock tools:</strong> Before each task, a realistic workspace is created with emails, calendar events, contacts, and tasks. Professional/workplace themed.</li>
        <li><strong>Isolated environment:</strong> Each task runs in a fresh gemmaclaw home directory. No state leaks between tasks.</li>
        <li><strong>Dispatch task:</strong> The task prompt is sent via <code>gemmaclaw agent --local</code>. The agent reads emails, checks calendars, creates tasks, sends emails using mock tools.</li>
        <li><strong>Capture conversation:</strong> The full agent loop is recorded: every tool call, tool result, reasoning step, and follow-up action.</li>
        <li><strong>Save results:</strong> Rich metadata (hardware, model, quant, git SHA, Ollama model info) plus per-task transcripts and evaluation stubs.</li>
        <li><strong>Evaluation (separate step):</strong> Results are reviewed against grading criteria. Scores are added to the evaluation files and published to the site.</li>
      </ol>

      <h3>Results Directory</h3>
      <div class="code-block"><pre><code>benchmark-results/
  runs/&lt;model&gt;__&lt;quant&gt;__&lt;timestamp&gt;/
    metadata.json        # Hardware, model, quant, config, git SHA
    results.json         # Per-task conversations, tool calls, stats
    transcripts/         # Human-readable per-task transcripts
    RESULTS.md           # Markdown summary
  evaluations/&lt;model&gt;__&lt;quant&gt;__&lt;timestamp&gt;/
    &lt;task-id&gt;.json       # Grading criteria + evaluation scores</code></pre></div>

      <h3>Metadata Captured</h3>
      <ul class="setup-list">
        <li><strong>Hardware:</strong> GPU name, VRAM, CPU model, core count, total RAM</li>
        <li><strong>Model:</strong> Name, parameter count, quantization level, format (from Ollama API)</li>
        <li><strong>Config:</strong> Backend type, thinking level, context length, URLs</li>
        <li><strong>Environment:</strong> Git SHA, Node.js version, OS/platform, timestamps</li>
      </ul>

      <h3>Submitting Results</h3>
      <ol class="setup-steps">
        <li><strong>Run the benchmark</strong> on your hardware</li>
        <li><strong>Check the results</strong> in <code>benchmark-results/runs/</code></li>
        <li><strong>Open a PR</strong> adding your results directory to the gemmaclaw repo</li>
        <li>Results will be reviewed, evaluated, and published to the site</li>
      </ol>

      <h3>Smoke Test</h3>
      <p>After making changes to the benchmark harness, run the smoke test to verify everything works:</p>
      <div class="code-block"><pre><code># Mock only (instant, no model needed)
bash scripts/benchmark/smoke-test.sh

# Full test: mock + Ollama + llama.cpp
bash scripts/benchmark/smoke-test.sh --real</code></pre></div>

      <h3>Prompt-Response Mode (Legacy)</h3>
      <p>The original prompt-response benchmark is still available. It sends isolated prompts to the backend and checks text output (no agent loop, no tool calling).</p>
      <div class="code-block"><pre><code>pnpm benchmark --local --model gemma4:31b
pnpm benchmark --mock</code></pre></div>
    </section>"""
    return page_template("Run Benchmarks", body, active_page="benchmarking.html")


def generate_site():
    results = load_benchmark_results()
    best = best_results(results)
    benchmark_rows = generate_benchmark_table_rows(best)
    model_details = generate_model_detail_sections(best)
    size_class_html = generate_size_class_sections(best)
    task_explanations_html = generate_task_explanations(best)
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
        "benchmarks.html": generate_benchmarks_page(benchmark_rows, model_details, size_class_html, task_explanations_html),
        "benchmarking.html": generate_benchmarking_page(),
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

    /* Conversation viewer (expandable task rows) */
    tr.task-row { transition: background-color 0.12s; }
    tr.task-row:hover { background: var(--bg-elev-2); }
    tr.task-row.open { background: var(--bg-elev-2); }
    tr.task-row .row-toggle {
      display: inline-block; width: 1rem; color: var(--muted);
      font-size: 0.7rem; transition: transform 0.15s;
    }
    .task-status { display: inline-block; width: 1rem; font-weight: 700; }
    .task-status.pass { color: var(--good); }
    .task-status.fail { color: #d14545; }

    tr.task-detail > td { padding: 1.25rem 1.5rem; background: var(--bg); }
    .conv-meta {
      display: flex; flex-wrap: wrap; gap: 1.5rem;
      padding-bottom: 0.75rem; margin-bottom: 0.75rem;
      border-bottom: 1px solid var(--border);
      font-size: 0.85rem; color: var(--muted);
    }
    .conv-meta strong { color: var(--fg-soft); font-weight: 600; }
    .conv-desc {
      font-style: italic; color: var(--fg-soft);
      margin: 0 0 1rem 0; font-size: 0.95rem;
    }
    .conv-section { margin: 0.75rem 0; }
    .conv-label {
      font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em;
      color: var(--muted); margin-bottom: 0.3rem;
    }
    .conv-block {
      background: var(--bg-elev); border-left: 3px solid var(--border);
      padding: 0.85rem 1rem; margin: 0; border-radius: 4px;
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 0.82rem; color: var(--fg);
      white-space: pre-wrap; word-break: break-word;
      max-height: 24rem; overflow-y: auto;
    }
    .conv-prompt { border-left-color: var(--accent); }
    .conv-block + .conv-block { margin-top: 0.4rem; }
    .conv-judge {
      background: var(--bg-elev); padding: 0.85rem 1rem;
      border-left: 3px solid #d4a017; border-radius: 4px;
      font-size: 0.9rem; color: var(--fg-soft); line-height: 1.5;
    }
    .conv-judge.judge-good { border-left-color: var(--good); }
    .conv-judge.judge-mid { border-left-color: #d4a017; }
    .conv-judge.judge-bad { border-left-color: #d14545; }
    .conv-empty {
      color: var(--muted); font-style: italic; font-size: 0.88rem;
      padding: 0.5rem 0;
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
      .task-explanation { padding: 0.6rem 0.8rem; }
      .task-prompt code { font-size: 0.72rem; }
    }

    /* Size class grouping */
    .size-class-group { margin-bottom: 2rem; }
    .size-class-group h3 { font-size: 1.15rem; font-weight: 600; margin-bottom: 0.3rem; color: var(--text); }
    .hw-recommendation { font-size: 0.88rem; color: var(--muted); margin-bottom: 0.8rem; padding: 0.5rem 0.8rem; background: var(--bg-elev); border-radius: 8px; border-left: 3px solid var(--accent); }
    .quant-badge { font-size: 0.68rem; padding: 1px 6px; border-radius: 4px; background: var(--bg-elev-2); color: var(--muted); font-weight: 500; vertical-align: middle; margin-left: 4px; }

    /* Task explanations */
    #task-explanations { margin-top: 2.5rem; }
    .task-category { margin-bottom: 1.5rem; }
    .task-category h4 { font-size: 1.05rem; font-weight: 600; margin-bottom: 0.3rem; }
    .cat-desc { font-size: 0.85rem; color: var(--muted); margin-bottom: 0.6rem; }
    .task-explanation { padding: 0.7rem 1rem; margin-bottom: 0.5rem; background: var(--bg-elev); border-radius: 8px; }
    .task-header { margin-bottom: 0.25rem; }
    .task-desc { font-size: 0.85rem; color: var(--text); margin-bottom: 0.3rem; }
    .task-prompt { font-size: 0.8rem; color: var(--muted); }
    .task-prompt code { font-size: 0.78rem; background: var(--bg-elev-2); padding: 2px 6px; border-radius: 4px; word-break: break-all; }
    .diff-badge { font-size: 0.68rem; padding: 1px 6px; border-radius: 4px; font-weight: 500; vertical-align: middle; margin-left: 4px; }
    .diff-easy { background: #e6f4ea; color: #1a7f37; }
    .diff-medium { background: #fff3cd; color: #856404; }
    .diff-hard { background: #fce8e6; color: #c93c37; }
"""


if __name__ == "__main__":
    generate_site()
