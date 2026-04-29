#!/usr/bin/env python3
"""
Gemmaclaw Site Generator
Generates a complete GitHub Pages static site from benchmark results and project docs.
4 sections: Setup Guide, Self-Hosting Guides, Benchmark Results, Goals & Progress.
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


def load_community_configs():
    """Load community-reported hardware configs from Reddit extraction."""
    if not COMMUNITY_CONFIGS_FILE.exists():
        return []
    try:
        with open(COMMUNITY_CONFIGS_FILE) as f:
            data = json.load(f)
        return [e for e in data if e.get("hardware_mentions")]
    except (json.JSONDecodeError, KeyError):
        return []


def html_escape(text):
    """Escape HTML special characters."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def generate_community_cards(configs):
    """Generate community hardware report cards from Reddit data."""
    if not configs:
        return ""
    cards = []
    for entry in configs:
        post_id = entry.get("post", "")
        mentions = entry.get("hardware_mentions", [])
        if not mentions:
            continue
        # Build search text from all mentions
        search_text = html_escape(" ".join(mentions).lower())
        # Show up to 5 hardware mention lines
        mention_items = "\n".join(
            f'<li>{html_escape(m)}</li>' for m in mentions[:5]
        )
        reddit_url = f"https://reddit.com/r/LocalLLaMA/comments/{post_id}"
        cards.append(f"""<div class="hw-card community-report" data-search="{search_text}">
  <div class="hw-card-header">
    <div class="hw-specs">
      <ul class="community-mentions">{mention_items}</ul>
    </div>
    <a href="{reddit_url}" class="community-source" target="_blank" rel="noopener">r/LocalLLaMA source</a>
  </div>
</div>""")
    return "\n".join(cards)


def generate_site():
    results = load_benchmark_results()
    best = best_results(results)

    # Data for JavaScript
    results_json = json.dumps([{
        "model": r["model"],
        "backend": r["backend"],
        "hardware": r.get("hardware", {}),
        "summary": r["summary"],
        "dir": r["_dir"],
    } for r in results])

    benchmark_rows = generate_benchmark_table_rows(best)
    model_details = generate_model_detail_sections(best)
    hw_cards = generate_hardware_guide_cards(results)
    community_configs = load_community_configs()
    community_cards = generate_community_cards(community_configs)
    community_count = len(community_configs)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gemmaclaw</title>
  <meta name="description" content="Out-of-the-box best Gemma setup for your hardware. Benchmark results, setup guides, and self-hosting configurations.">
  <style>
{CSS}
  </style>
</head>
<body>
  <nav class="topnav">
    <div class="nav-inner">
      <a href="#" class="logo">Gemmaclaw</a>
      <div class="nav-links">
        <a href="#setup">Setup</a>
        <a href="#hosting">Self-Hosting</a>
        <a href="#benchmarks">Benchmarks</a>
        <a href="#goals">Goals</a>
        <a href="https://github.com/gemmaclaw/gemmaclaw">GitHub</a>
      </div>
    </div>
  </nav>

  <div class="wrap">
    <!-- Hero -->
    <div class="hero">
      <h1><span>Gemmaclaw</span></h1>
      <p class="tagline">One command to a working Gemma assistant, regardless of what hardware you have. Auto-detect, provision, and benchmark.</p>
      <div class="links">
        <a href="#setup" class="btn-primary">Get Started</a>
        <a href="#benchmarks" class="btn-secondary">See Benchmarks</a>
        <a href="https://github.com/gemmaclaw/gemmaclaw" class="btn-secondary">GitHub</a>
      </div>
    </div>

    <!-- Section 1: Setup Guide -->
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
      <div class="code-block">
        <pre><code>git clone https://github.com/gemmaclaw/gemmaclaw.git
cd gemmaclaw
corepack enable && pnpm install
pnpm build
npm install -g .

# Auto-detect hardware + provision + start
gemmaclaw setup

# Restart later
gemmaclaw chat</code></pre>
      </div>

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
      <div class="table-wrap">
        <table>
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
        </table>
      </div>

      <h3>Troubleshooting</h3>
      <ul class="setup-list">
        <li><strong>Ollama download fails:</strong> check network. Binary comes from GitHub releases.</li>
        <li><strong>llama.cpp server won't start:</strong> verify model at <code>~/.gemmaclaw/models/llama-cpp/</code>. Re-run provision.</li>
        <li><strong>gemma.cpp build fails:</strong> ensure cmake and g++ are installed.</li>
        <li><strong>"Healthcheck failed":</strong> backend did not respond in time. Check system resources.</li>
        <li><strong>Port in use:</strong> use <code>--port N</code> or advanced setup.</li>
      </ul>
    </section>

    <!-- Section 2: Self-Hosting Guides -->
    <section id="hosting">
      <h2>Gemma4 Self-Hosting Guide</h2>
      <p>Find the best Gemma configuration for your hardware. Search by GPU, CPU, or RAM to see what works, how fast, and what quality to expect.</p>

      <div class="search-bar">
        <input type="text" id="hw-search" placeholder="Search by hardware (e.g. RTX 3090, M4 Max, 32GB, CPU only...)" autocomplete="off">
      </div>

      <div id="hw-cards">
        {hw_cards}
      </div>

      <div class="hosting-notes">
        <h3>Backend Comparison</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Backend</th><th>Best For</th><th>GPU Support</th><th>Notes</th></tr></thead>
            <tbody>
              <tr><td><strong>Ollama</strong></td><td>Most users, GPU setups</td><td>CUDA, Metal, ROCm</td><td>Easiest setup, automatic model management</td></tr>
              <tr><td><strong>llama.cpp</strong></td><td>Flexible quantization</td><td>CUDA, Metal, Vulkan</td><td>More quant options, manual model files</td></tr>
              <tr><td><strong>gemma.cpp</strong></td><td>CPU-first setups</td><td>CPU only (for now)</td><td>Google-native, Gemma 2/3 only currently</td></tr>
            </tbody>
          </table>
        </div>

        <h3>Hardware Tiers</h3>
        <ul class="setup-list">
          <li><strong>High-end GPU (24+ GB VRAM):</strong> Run Gemma 4 31B Dense or 26B MoE at full precision. RTX 3090/4090, A100, etc.</li>
          <li><strong>Mid-range GPU (8-16 GB VRAM):</strong> Gemma 4 26B MoE with quantization, or Gemma 4 E4B unquantized.</li>
          <li><strong>Apple Silicon (32+ GB unified):</strong> Gemma 4 26B MoE via Ollama Metal. 48+ GB can try 31B Dense.</li>
          <li><strong>CPU only (16+ GB RAM):</strong> Gemma 4 E4B or Gemma 3 4B via Ollama. Viable for interactive use at 140+ tok/s.</li>
          <li><strong>CPU only (8-16 GB RAM):</strong> Gemma 3 4B or Gemma 2 via gemma.cpp. Smaller but functional.</li>
        </ul>
      </div>

      {"" if not community_count else f'''<div class="community-section">
        <h3>Community Reports ({community_count} from r/LocalLLaMA)</h3>
        <p>Hardware configurations reported by the community. These are user reports, not official benchmarks. Search above to filter.</p>
        <div id="community-cards">{community_cards}</div>
      </div>'''}
    </section>

    <!-- Section 3: Benchmark Results -->
    <section id="benchmarks">
      <h2>Benchmark Results</h2>
      <p>All models tested on the same task suite: instruction following, reasoning, data extraction, safety, and coding. Click a row for detailed per-task breakdown.</p>

      <div class="table-wrap">
        <table id="benchmark-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Backend</th>
              <th>GPU</th>
              <th>Quality</th>
              <th>Pass Rate</th>
              <th>Speed</th>
              <th>Total Time</th>
            </tr>
          </thead>
          <tbody>
            {benchmark_rows}
          </tbody>
        </table>
      </div>

      <div id="model-details">
        {model_details}
      </div>
    </section>

    <!-- Section 4: Goals & Progress -->
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
    </section>
  </div>

  <footer>
    <p>Built on <a href="https://github.com/openclaw/openclaw" class="inline">OpenClaw</a>. Volunteer-driven, Gemma-first.</p>
    <p class="footer-sub">Not an official Google product.</p>
  </footer>

  <script>
    // Hardware search filter (includes community cards)
    const searchInput = document.getElementById('hw-search');
    const hwCards = document.querySelectorAll('#hw-cards .hw-card');
    const communityCards = document.querySelectorAll('#community-cards .hw-card');
    const allCards = [...hwCards, ...communityCards];
    if (searchInput) {{
      searchInput.addEventListener('input', function() {{
        const q = this.value.toLowerCase().trim();
        allCards.forEach(card => {{
          const text = card.getAttribute('data-search') || '';
          card.style.display = (!q || text.includes(q)) ? '' : 'none';
        }});
      }});
    }}

    // Benchmark table row click to toggle detail
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

    // Initially hide all model details
    document.querySelectorAll('.model-detail').forEach(d => d.style.display = 'none');
  </script>
</body>
</html>"""

    SITE_DIR.mkdir(exist_ok=True)
    with open(SITE_DIR / "index.html", "w") as f:
        f.write(html)

    print(f"Site generated at {SITE_DIR / 'index.html'}")
    print(f"  {len(results)} benchmark results loaded")
    print(f"  {len(best)} unique model/backend combos")
    print(f"  {community_count} community hardware reports loaded")


CSS = """
    :root {
      --bg: #0d1117;
      --bg-elev: #161b22;
      --bg-elev-2: #1c2129;
      --border: #30363d;
      --fg: #e6edf3;
      --fg-soft: #c9d1d9;
      --muted: #8b949e;
      --accent: #4285f4;
      --accent-soft: #1f3a5f;
      --good: #3fb950;
      --warn: #d29922;
      --bad: #f85149;
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
      background: rgba(13, 17, 23, 0.95);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
    }
    .nav-inner {
      max-width: 960px; margin: 0 auto;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.75rem 1.5rem;
    }
    .logo {
      font-size: 1.1rem; font-weight: 700; color: var(--accent);
      text-decoration: none;
    }
    .nav-links { display: flex; gap: 1.5rem; }
    .nav-links a {
      color: var(--muted); text-decoration: none; font-size: 0.9rem; font-weight: 500;
      transition: color 0.15s;
    }
    .nav-links a:hover { color: var(--fg); }

    .wrap { max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }

    /* Hero */
    .hero { text-align: center; padding: 3rem 0 4rem; }
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

    /* Sections */
    section { margin-top: 3rem; scroll-margin-top: 4rem; }
    h2 { font-size: 1.6rem; font-weight: 600; margin-bottom: 1rem; letter-spacing: -0.01em; }
    h3 { font-size: 1.1rem; font-weight: 600; margin: 1.5rem 0 0.75rem; color: var(--fg-soft); }
    p { color: var(--fg-soft); margin-bottom: 1rem; }
    a.inline { color: var(--accent); text-decoration: none; }
    a.inline:hover { text-decoration: underline; }

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
    .community-mentions { list-style: none; margin: 0; font-size: 0.88rem; color: var(--fg-soft); }
    .community-mentions li { padding: 0.2rem 0; }
    .community-source {
      font-size: 0.82rem; color: var(--accent); text-decoration: none;
      margin-top: 0.5rem; display: inline-block;
    }
    .community-source:hover { text-decoration: underline; }
    .community-report { border-left: 3px solid var(--accent-soft); }

    /* Footer */
    footer {
      margin-top: 4rem; padding-top: 2rem;
      border-top: 1px solid var(--border);
      color: var(--muted); font-size: 0.85rem; text-align: center;
    }
    footer a { color: var(--accent); text-decoration: none; }
    .footer-sub { margin-top: 0.5rem; font-size: 0.78rem; }

    /* Responsive */
    @media (max-width: 640px) {
      h1 { font-size: 2rem; }
      .tagline { font-size: 1rem; }
      .nav-links { gap: 1rem; }
      .nav-links a { font-size: 0.82rem; }
      .hw-specs { flex-direction: column; gap: 0.25rem; }
      .hw-model { flex-wrap: wrap; gap: 0.5rem; }
    }
"""


if __name__ == "__main__":
    generate_site()
