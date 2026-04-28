# Gemmaclaw

Gemmaclaw makes it easy to run the best Gemma configuration for your hardware, out of the box. You tell it what you have (GPU, CPU, RAM), and it picks the right model, quantization, and backend so you can get a working Gemma-based assistant without tuning anything yourself. CPU-only setups are first-class, not an afterthought.

Built on top of the [OpenClaw](https://github.com/openclaw/openclaw) personal AI assistant framework. Volunteer-driven, Gemma-first.

## Goal

One command to a working Gemma assistant, regardless of what hardware you have.

- Detect your hardware tier (GPU model and VRAM, CPU cores, available RAM).
- Select the best backend, model size, and quantization profile for that tier.
- Fall back gracefully: high-end GPU setups get full-size models via Ollama, modest GPUs get smaller quants, and CPU-only machines get a viable path through gemma.cpp.
- Verify the result actually works (inference speed, memory headroom, tool-use reliability).

No manual model shopping. No "which quant do I pick?" guesswork. It just works.

## How it works

1. **Hardware detection.** Gemmaclaw probes your system: GPU vendor and VRAM, CPU architecture, total and available RAM. Apple Silicon Metal GPUs are detected with unified memory.
2. **Tier classification.** Based on what it finds, your machine is slotted into a hardware tier (e.g., "48 GB Apple Silicon" or "CPU-only, 8 GB RAM").
3. **Profile selection.** Each tier maps to a tested Gemma 4 model. Known issues (e.g., Flash Attention hangs on the 31B Dense model) are tracked in the model catalog with citations, and the selector automatically falls back to a stable alternative.
4. **Provisioning.** Gemmaclaw downloads Ollama, pulls the model, and runs a smoke test.
5. **Configuration.** Writes gateway config with the local Ollama provider, auth disabled for localhost, and full tool access enabled.
6. **Sandboxed tool execution.** When Docker is available, the agent's tool execution (shell commands, file operations, browser automation) runs inside isolated Docker containers via the OpenClaw sandbox system. The gateway itself runs on the host for simplicity. Pass `--no-container` to disable sandboxing and run tools directly on the host.
7. **Verification.** A smoke test confirms the model responds before the gateway starts.

If something does not fit (too little RAM, model has known issues on your platform), Gemmaclaw tells you what it tried and why it fell back, rather than silently degrading.

## Non-GPU support

CPU-only is a first-class path, not a fallback afterthought.

- Today: Gemma 2 and Gemma 3 run on CPU via [gemma.cpp](https://github.com/google/gemma.cpp) with competitive performance on machines with 8 GB or more RAM.
- Future: as gemma.cpp or other CPU backends add Gemma 4 support, Gemmaclaw will incorporate those profiles automatically.
- The goal is that someone with a laptop and no discrete GPU can still get a useful local assistant running Gemma.

## Roadmap

**Phase 1: Evidence.** Benchmark Gemma models across hardware tiers, backends, and quantizations. Document what actually works, how fast, and at what quality. No opinions without data.

**Phase 2: Productization.** Build the auto-detection and profile-selection tooling. Ship a `gemmaclaw doctor` command that diagnoses your system and recommends (or provisions) the right setup. Package tested profiles so they work out of the box.

**Phase 3: Community loop.** Open the profile registry to contributions. Users report what works on their hardware, profiles get refined, coverage grows. A working group keeps the evidence current as new Gemma releases land.

## Status

Phase 2 tooling is live: `gemmaclaw setup` auto-detects hardware and provisions the best backend. Phase 1 benchmarks continue in parallel. Contributions and hardware reports are welcome.

## Benchmark snapshot: Gemma 4 on a 24 GB GPU

Gemma 4 launched on April 2, 2026 in two variants: a **26B A4B MoE** model with about 3.8B active parameters per token, and a **31B dense** model. Both are positioned for consumer-class GPUs, but only one of them is actually a good fit on a single 24 GB card. The harness inside Gemmaclaw was used to compare them against the existing Gemma 3 4B baseline on an RTX 3090, across both Ollama and a standalone `llama-server` backend.

**Hardware tested:** NVIDIA RTX 3090 (24 GB), AMD Ryzen 9 5900X (12 cores / 24 threads), 30 GB system RAM, WSL2 Ubuntu. All models used Q4_K_M quantization. Quality is scored by an LLM judge across 15 tool-use-style tasks spanning instruction following, reasoning, extraction, safety, and coding; throughput is measured at the local HTTP API.

| Model             | Backend              | VRAM   | Score         | Pass rate     | Median tok/s |
| ----------------- | -------------------- | ------ | ------------- | ------------- | ------------ |
| Gemma 3 4B        | Ollama               | ~3 GB  | 134/140 (96%) | 100% (15/15)  | 178          |
| Gemma 4 26B MoE   | Ollama               | ~17 GB | 137/140 (98%) | 100% (15/15)  | 117          |
| Gemma 4 26B MoE   | llama.cpp standalone | ~17 GB | 127/140 (91%) | 93.3% (14/15) | **133**      |
| Gemma 4 31B dense | Ollama               | ~21 GB | 97/140 (69%)  | 73% (11/15)   | 2.6          |

### What this means in practice

- **Gemma 4 26B MoE is the sweet spot for a 24 GB GPU.** It clears 98% on quality, runs at interactive speed (about 117 tok/s on Ollama), and leaves comfortable VRAM headroom for the KV cache. The MoE design activates only a roughly 4B-parameter subset per token, which is why a 26B model can fit and run this fast on consumer hardware.
- **llama.cpp is meaningfully faster than Ollama for this model.** About 14% higher median throughput and roughly half the p50 latency, because it skips the request orchestration layer. The single missed task in that run was a thinking-template artifact (the final response budget was consumed by reasoning tokens), not a quality regression. Both backends are now blessed for Gemma 4 26B MoE: pick llama.cpp for raw speed, Ollama for zero-config model management plus rendering-aware output parsing for thinking models.
- **Gemma 3 4B is still useful when speed is the priority.** It is roughly 50% faster than the 26B MoE model with only a 2-point quality gap, which makes it a good fit for latency-sensitive or batch workloads.
- **Skip Gemma 4 31B dense on a 24 GB card.** Q4_K_M loads at about 21 GB, leaving very little room for the KV cache, and the resulting CPU-offload pressure drops throughput to about 2.6 tok/s. Coding tasks time out before they can finish. The 31B dense variant needs 40+ GB VRAM (A6000, L40, dual-GPU) to be practical.

The full result set, per-task breakdown, methodology, and HTML dashboards live in [`benchmark-results/BENCHMARK-SUMMARY.md`](benchmark-results/BENCHMARK-SUMMARY.md). Reproduce with `gemmaclaw benchmark --model gemma4:26b` (Ollama) or by pointing the harness at a `llama-server` instance running `bartowski/google_gemma-4-26B-A4B-it-Q4_K_M.gguf`.

## Getting started

### Prerequisites

- Node.js 22+
- Docker (recommended, for containerized gateway)
- For gemma.cpp backend (advanced): cmake, g++ (or clang++), git, and a [HuggingFace token](https://huggingface.co/settings/tokens) (`HF_TOKEN`)

No pre-installed Ollama, llama.cpp, or gemma.cpp required. Gemmaclaw downloads and manages everything.

### Install

Clone the repo, build, and install the CLI globally:

```bash
git clone https://github.com/gemmaclaw/gemmaclaw.git
cd gemmaclaw
corepack enable && pnpm install
pnpm build
npm install -g .
```

Then run setup:

```bash
gemmaclaw setup
```

This detects your hardware, picks the best Gemma 4 model, downloads it via Ollama, configures the gateway, and starts it. When Docker is available, agent tool execution is automatically sandboxed in Docker containers. Open the Chat UI URL it prints at the end.

To disable Docker sandboxing (tools run directly on the host):

```bash
gemmaclaw setup --no-container
```

To restart the gateway later:

```bash
gemmaclaw chat
```

### Developer install

Same as above, but skip the global install and run commands directly:

```bash
git clone https://github.com/gemmaclaw/gemmaclaw.git
cd gemmaclaw
corepack enable && pnpm install
pnpm build
node gemmaclaw.mjs setup
node gemmaclaw.mjs chat
```

Example output:

```
Detecting hardware...
  CPU: arm64, 16 cores (Apple M4 Max)
  RAM: 48.0 GB total, 20.6 GB available
  GPU: Apple M4 Max (48 GB unified memory)

Recommended: Gemma 4 26B MoE (4B active) (18.0 GB download)
  Apple Silicon with 48 GB unified memory. Gemma 4 31B Dense skipped due to
  3 open issue(s) on darwin-arm64. 36+ GB RAM, M-series Max/Ultra.

Provisioning ollama on port 11434...
[Ollama] Runtime started on port 11434 (PID 12345).
[Ollama] Model ready.

Smoke test passed. Response: "Hello."

Writing gateway configuration...
  Provider: ollama (http://127.0.0.1:11434/v1)
  Model: ollama/gemma4:26b

Setup complete! Your Gemma assistant is ready.

  Sandbox: Docker (tools run in isolated containers)

Starting gateway on port 18789...
Gateway is ready.

Chat UI: http://127.0.0.1:18789/
```

### Advanced setup

Step-by-step prompts to override backend, model, and port:

```bash
gemmaclaw setup --advanced
```

### Manual provisioning (advanced)

`gemmaclaw provision` is the low-level primitive. Use it when you know exactly what you want:

```bash
# Ollama (recommended for GPU setups, ~815 MB model download)
gemmaclaw provision --backend ollama

# llama.cpp (flexible quants, ~726 MB GGUF download)
gemmaclaw provision --backend llama-cpp

# gemma.cpp (CPU-first, requires cmake/g++, ~5 GB model download)
HF_TOKEN=hf_... gemmaclaw provision --backend gemma-cpp
```

### Verify it works

After setup or provisioning, the backend exposes a local chat completions endpoint. Test it:

```bash
curl http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma3:1b","messages":[{"role":"user","content":"Say hello"}]}'
```

Default ports: Ollama = 11434, llama.cpp = 8080, gemma.cpp = 11436.

The API follows the [OpenAI Chat Completions format](https://platform.openai.com/docs/api-reference/chat/create), so any client or library that speaks that protocol will work out of the box. See the OpenAI docs for the full request/response schema if needed.

### Troubleshooting

- **Ollama download fails**: check network connectivity. The binary is downloaded from GitHub releases.
- **llama.cpp server won't start**: verify the model file exists at `~/.gemmaclaw/models/llama-cpp/`. Re-run provision to re-download.
- **gemma.cpp build fails**: ensure cmake and g++ are installed (`apt-get install cmake g++`). Check that git submodules initialized correctly.
- **gemma.cpp model download fails**: verify `HF_TOKEN` is set and has access to the gated Gemma model on HuggingFace.
- **"Healthcheck failed"**: the backend process started but did not respond in time. Check system resources (RAM, disk).
- **Port already in use**: another process is using the default port. Use `--port <N>` to pick a different one, or use advanced setup.

### Data directory

All managed runtimes and models are stored under `~/.gemmaclaw/` (override with `GEMMACLAW_HOME`):

```
~/.gemmaclaw/
  runtimes/       # Downloaded/built backend binaries
  models/         # Downloaded model files
```

### Running E2E tests in Docker

Verify the install path works on a fresh machine:

```bash
docker build --no-cache -f test/e2e/Dockerfile.install .
```

To verify all backends work from a clean environment:

```bash
# Build the E2E image
docker build -f test/e2e/Dockerfile.provision -t gemmaclaw-provision-e2e .

# Test individual backends (direct provision + agent run)
docker run --rm gemmaclaw-provision-e2e ollama
docker run --rm gemmaclaw-provision-e2e llama-cpp
docker run --rm -e HF_TOKEN=hf_... gemmaclaw-provision-e2e gemma-cpp

# Test all
docker run --rm -e HF_TOKEN=hf_... gemmaclaw-provision-e2e all
```

### Benchmarking

Gemmaclaw includes a built-in benchmark suite that tests model quality across instruction following, reasoning, data extraction, safety, and coding tasks. The benchmark is hardware-aware: it detects your GPU, CPU, and RAM, then reports throughput alongside quality scores so you can compare configurations.

```bash
# Run full benchmark with LLM judge scoring
gemmaclaw benchmark

# Run deterministic scoring only (fast, no judge needed)
gemmaclaw benchmark --mock

# Quick mode: tagged subset, under 10 minutes
gemmaclaw benchmark --quick

# Benchmark a specific model
gemmaclaw benchmark --model gemma3:4b

# Sweep: test a matrix of models, resumable overnight
gemmaclaw benchmark --sweep --models gemma3:4b,gemma3:12b

# Run only coding tasks
gemmaclaw benchmark --filter coding

# Tune hardware parameters
gemmaclaw benchmark --context-length 8192 --gpu-layers 35 --batch-size 512
```

Results are written to `benchmark-results/<run>__<timestamp>/` with three formats:

- `results.json`: machine-readable scores, timing, and hardware info
- `RESULTS.md`: markdown summary table
- `index.html`: GitHub Pages compatible dashboard

#### Sharing results with the community

After a run completes, package and submit the result to the public configuration matrix with one command:

```bash
# Auto-detect the most recent run under ./benchmark-results and open a PR
gemmaclaw benchmark submit

# Submit a specific run
gemmaclaw benchmark submit benchmark-results/gemma3-4b__ollama__2026-04-28T21-02-21

# Preview the anonymized payload and PR body without pushing anything
gemmaclaw benchmark submit --dry-run

# Submit to a different repo (e.g. a fork or a private mirror)
gemmaclaw benchmark submit --repo my-org/my-fork --dataset-dir my-results
```

The `submit` command:

1. Reads `results.json` from the chosen run directory (auto-detects newest if no path is given).
2. Strips known private identifiers (hostname, username, home paths, RFC1918 / loopback URLs).
3. Forks `gemmaclaw/gemmaclaw` (idempotent), creates a `benchmark/<run-id>` branch on the fork.
4. Commits the anonymized result under `community-benchmarks/<run-id>.json`.
5. Pushes the branch and opens a PR against `gemmaclaw/gemmaclaw:main`.

Prerequisites: install the [GitHub CLI](https://cli.github.com/) and run `gh auth login` once. `submit` calls `gh` for the fork, push, and PR steps.

For full details on task packs, scoring methodology, sweep mode, config selection, and the result schema, see the [Benchmark Kit documentation](src/gemmaclaw/benchmark-kit/README.md).

## Commands

| Command                          | Description                                                 |
| -------------------------------- | ----------------------------------------------------------- |
| `gemmaclaw setup`                | Auto-detect hardware, provision, configure, and start       |
| `gemmaclaw setup --no-container` | Same as above but disable Docker sandbox for tool execution |
| `gemmaclaw setup --advanced`     | Interactive wizard for manual backend/model/port selection  |
| `gemmaclaw chat`                 | Open a browser-based chat UI for your Gemma assistant       |
| `gemmaclaw chat --no-open`       | Start gateway without auto-opening the browser              |
| `gemmaclaw chat --port 3001`     | Start gateway on a specific port                            |
| `gemmaclaw tui`                  | Open terminal chat (TUI) with your Gemma assistant          |
| `gemmaclaw benchmark`            | Run the benchmark suite (full LLM judge mode)               |
| `gemmaclaw benchmark --mock`     | Run benchmark with deterministic scoring (fast CI mode)     |
| `gemmaclaw benchmark submit`     | Anonymize the latest run and open a PR to share results     |
| `gemmaclaw provision`            | Low-level: manually provision a specific backend            |
| `gemmaclaw doctor`               | Health checks and quick fixes                               |
| `gemmaclaw config`               | View and edit configuration                                 |

### npm scripts (development)

| Script                    | Description                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| `pnpm benchmark`          | Run benchmark locally (full mode)                                  |
| `pnpm benchmark:mock`     | Run benchmark locally (deterministic only)                         |
| `pnpm test:e2e:benchmark` | Docker e2e: build image, install Ollama, pull model, run benchmark |
| `pnpm test:e2e:install`   | Docker e2e: verify clean install works                             |
| `pnpm build`              | Build the project                                                  |
| `pnpm test`               | Run unit tests                                                     |

## Contributing

Issues and pull requests are welcome. Keep contributions small, reproducible, and backed by data where possible. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Links

- [Upstream OpenClaw](https://github.com/openclaw/openclaw) (the framework Gemmaclaw is built on)
- [OpenClaw docs](https://docs.openclaw.ai) (optional reference for advanced configuration)
- [gemma.cpp](https://github.com/google/gemma.cpp)

## Disclaimer

This project is composed of volunteers, including both Google engineers and members of the open source community. At this time, Gemmaclaw is not an official Google repository. The actions and opinions expressed in this repository do not reflect any official statements from Google, and no liability should be attributed to Google. This is a volunteer project intended to help empower people with AI, leveraging Gemma.
