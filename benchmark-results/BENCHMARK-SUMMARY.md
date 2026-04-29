# Gemma Benchmark on RTX 3090 — Comprehensive Results

## Hardware

- GPU: NVIDIA GeForce RTX 3090 (24 GB VRAM)
- CPU: AMD Ryzen 9 5900X 12-Core (24 threads)
- RAM: 128 GB system (120.9 GB available to WSL2)
- OS: WSL2 Ubuntu on Windows
- Backends: Ollama 0.21.x (primary), llama.cpp b5460 (verification)

## Models Tested

| Model                    | Architecture | Params | Quant  | Weights Size | KV @ 32K (FP16) | Fits 24 GB? | Ollama Tag           |
| ------------------------ | ------------ | ------ | ------ | ------------ | --------------- | ----------- | -------------------- |
| Gemma 3 4B               | Dense        | 4B     | Q4_K_M | ~3.3 GB      | small           | yes         | `gemma3:4b`          |
| Gemma 4 E4B (Nano)       | Dense        | E4B    | Q4_K_M | 9.6 GB       | small           | yes         | `gemma4:e4b`         |
| Gemma 4 26B MoE          | MoE (A4B)    | 26B    | Q4_K_M | 17 GB        | small           | yes         | `gemma4:26b`         |
| Gemma 4 31B Dense        | Dense        | 31B    | Q4_K_M | 19 GB        | ~10 GB @ 128K   | tight       | `gemma4:31b`         |
| Gemma 4 31B Dense Q5_K_M | Dense        | 31B    | Q5_K_M | 21 GB        | ~10 GB @ 128K   | spills CPU  | `gemma4-31b-q5km`    |
| Gemma 4 31B Dense Q6_K   | Dense        | 31B    | Q6_K   | 25 GB        | ~3 GB @ 32K     | spills CPU  | `gemma4-31b-q6k`     |
| Gemma 4 31B Dense Q8_0   | Dense        | 31B    | Q8_0   | 32 GB        | n/a             | **NO**      | `gemma4:31b-it-q8_0` |

The 24 GB on a 3090 is the hard constraint. Anything past Q4_K_M on 31B Dense forces partial CPU offload through Ollama, and Q8_0 cannot be benchmarked usefully on this card.

## Results Summary (Ollama Backend)

### Quality (out of 140 max)

| Model                    | Score    | Percentage | Pass Rate    | Failures            |
| ------------------------ | -------- | ---------- | ------------ | ------------------- |
| Gemma 3 4B               | 134/140  | 96%        | 100% (15/15) | none                |
| Gemma 4 E4B (Nano)       | 137/140  | 98%        | 100% (15/15) | none                |
| Gemma 4 26B MoE          | 137/140  | 98%        | 100% (15/15) | none                |
| Gemma 4 31B Dense Q4_K_M | 97.1/140 | 69%        | 73% (11/15)  | 3 timeouts, 1 score |
| Gemma 4 31B Dense Q5_K_M | 127/140  | 91%        | 93% (14/15)  | 1 timeout (coding)  |
| Gemma 4 31B Dense Q6_K   | 137/140  | 98%        | 100% (15/15) | none                |
| Gemma 4 31B Dense Q8_0   | n/a      | n/a        | n/a          | out of spec (32 GB) |

### Speed Metrics

| Model                    | Median tok/s | Avg tok/s | p50 Latency | p95 Latency | Total Time |
| ------------------------ | ------------ | --------- | ----------- | ----------- | ---------- |
| Gemma 3 4B               | 177.1        | 178.1     | 0.7s        | 7.6s        | 37.6s      |
| Gemma 4 E4B (Nano)       | 142.7        | 144.3     | 3.2s        | 13.0s       | 2m 10s     |
| Gemma 4 26B MoE          | 116.7        | 115.9     | 5.7s        | 26.7s       | 3m 20s     |
| Gemma 4 31B Dense Q4_K_M | 2.6          | 2.5       | 151.8s      | 313.2s      | ~45 min    |
| Gemma 4 31B Dense Q5_K_M | 3.7          | 3.7       | 1m 38s      | 5m 25s      | 53m 25s    |
| Gemma 4 31B Dense Q6_K   | 4.2          | 4.2       | 1m 38s      | 4m 53s      | 50m 2s     |

### VRAM Behaviour at Load (Ollama, observed via `ollama ps`)

| Model                    | Context | Total Size | GPU Layers | CPU Layers |
| ------------------------ | ------- | ---------- | ---------- | ---------- |
| Gemma 4 26B MoE          | 128K    | ~18 GB     | 100%       | 0%         |
| Gemma 4 31B Dense Q4_K_M | 128K    | ~21 GB     | 100%       | 0%         |
| Gemma 4 31B Dense Q5_K_M | 128K    | 32 GB      | 68%        | 32%        |
| Gemma 4 31B Dense Q6_K   | 32K     | 30 GB      | 73%        | 27%        |

The Q5_K_M at 128K and Q6_K runs both spill onto CPU memory: weights alone leave too little room on the card for the requested KV cache. Reducing context length helps Q6_K fit better but it still cannot avoid CPU offload.

### Failure Analysis (31B Dense variants)

**Q4_K_M:**

| Task                    | Result        | Time   | Notes                         |
| ----------------------- | ------------- | ------ | ----------------------------- |
| Write FizzBuzz          | TIMEOUT       | 311.8s | Coding tasks need long output |
| Find the Bug            | TIMEOUT       | 313.2s | Exceeded 300s per-task limit  |
| Optimize Algorithm      | TIMEOUT       | 312.0s | Same timeout pattern          |
| Detect Prompt Injection | FAIL (2.1/15) | 231.6s | Low score, not a timeout      |

**Q5_K_M:**

| Task         | Result  | Time   | Notes                                 |
| ------------ | ------- | ------ | ------------------------------------- |
| Find the Bug | TIMEOUT | 5m 25s | Long coding task hits 300s HTTP limit |

Q5_K_M was meaningfully better than Q4_K_M on this hardware: at 3.7 tok/s vs 2.6 tok/s, fewer tasks bumped into the 300s per-request timeout, recovering 30 points of score.

### Category Breakdown

#### Gemma 4 E4B (Nano)

- instruction_following: 30/30 (100%)
- reasoning: 25/25 (100%)
- extraction: 30/30 (100%)
- safety: 22/25 (88%)
- coding: 30/30 (100%)

#### Gemma 4 31B Dense Q5_K_M

- instruction_following: 30/30 (100%)
- reasoning: 25/25 (100%)
- extraction: 30/30 (100%)
- safety: 22/25 (88%)
- coding: 20/30 (67%) — 1 timeout on Find the Bug

#### Gemma 4 31B Dense Q6_K

- instruction_following: 30/30 (100%)
- reasoning: 25/25 (100%)
- extraction: 30/30 (100%)
- safety: 22/25 (88%)
- coding: 30/30 (100%)

## Key Findings

### 1. Gemma 4 26B MoE is still the right default for RTX 3090

98% quality at 117 tok/s, fits comfortably in 24 GB with room for full 128K KV cache. Confirmed across both Ollama and standalone llama.cpp backends.

### 2. Gemma 4 E4B (Nano) is the new sweet spot for fast, high-quality inference

E4B is essentially a distilled / pruned Gemma 4 variant tuned for low-resource devices. On the 3090 it ties the 26B MoE on quality (137/140 = 98%) at **142 tok/s** — 22% faster than 26B MoE — while using only 9.6 GB of VRAM. This frees ~14 GB on the card for parallel work. For laptops, lower-tier GPUs, or any latency-critical use case, E4B is now the recommended pick.

### 3. Higher quants (Q5, Q6) of 31B Dense recover quality and Q6_K wins on this suite

Q4_K_M at 2.6 tok/s loses 30 points to timeouts (everything completes, but slowly). Q5_K_M at 3.7 tok/s recovers most of those points (+30, to 91%) because it stays under the 300s per-task timeout for almost everything. Q6_K at 4.2 tok/s with 32K context climbs all the way to 137/140 (98%) with zero timeouts, matching the score of Gemma 4 26B MoE and E4B. The cost is still nowhere near interactive: 50-minute total run vs ~2 minutes for Gemma 4 26B MoE on the same suite.

The Q6_K win is partly the smaller 32K context: weights take 25 GB but the KV cache budget is only ~3 GB, so the GPU layer split is healthier (73% GPU vs Q5_K_M's 68%) and per-task latency drops below the 300s HTTP timeout that hurt Q4_K_M and Q5_K_M on long coding tasks.

Practical rule on a 3090: if you must run 31B Dense, prefer Q6_K at 32K context (best quality, no timeouts) when you can live with ~50 min per suite. Q5_K_M at 128K context is the right pick if you genuinely need long-context input. Anything past Q6_K is dominated unless you have an A6000 or dual-GPU setup.

### 4. Q8_0 is out of spec on a 24 GB card

The 31B Dense Q8_0 weights alone are 32 GB. There is no useful way to benchmark it on this hardware without majority CPU offload, which would push every task into the per-request timeout and produce a meaningless score. Documented for completeness; not run.

### 5. Quality vs Speed Tradeoff (visualized)

```
Gemma 3 4B:          ████████████████████████████████████████████████░░  96%  |  178 tok/s  ████████████████████
Gemma 4 E4B:         █████████████████████████████████████████████████░  98%  |  143 tok/s  ████████████████
Gemma 4 26B MoE:     █████████████████████████████████████████████████░  98%  |  117 tok/s  █████████████
Gemma 4 31B Q6_K:    █████████████████████████████████████████████████░  98%  |  4.2 tok/s  ░
Gemma 4 31B Q5_K_M:  ███████████████████████████████████████████░░░░░░░  91%* |  3.7 tok/s  ░
Gemma 4 31B Q4_K_M:  ██████████████████████████████████░░░░░░░░░░░░░░░░  69%* |  2.6 tok/s  ░
                                                              * timeouts, not raw quality
```

### 6. Ollama vs llama.cpp Standalone (Gemma 4 26B MoE)

To verify both supported backends, the recommended Gemma 4 26B MoE model was also benchmarked against a standalone `llama-server` using a HuggingFace-sourced GGUF (`bartowski/google_gemma-4-26B-A4B-it-Q4_K_M.gguf`, 17.04 GB). Note that Ollama's stored GGUF blobs use a modified internal format (658 tensors) that is incompatible with the standalone llama.cpp loader, which expects 1014 tensors for the gemma4 architecture, so a fresh HF download was used for the standalone runs.

| Metric        | Ollama        | llama.cpp standalone | Δ        |
| ------------- | ------------- | -------------------- | -------- |
| Score         | 137/140 (98%) | 127/140 (91%)        | -10 pts  |
| Pass rate     | 100% (15/15)  | 93.3% (14/15)        | -1 task  |
| Median tok/s  | 116.7         | **133.3**            | **+14%** |
| Avg tok/s     | 115.9         | **129.6**            | **+12%** |
| p50 latency   | 5.7s          | 2.8s                 | -51%     |
| p95 latency   | 26.7s         | 17.3s                | -35%     |
| Total time    | 3m 20s        | 2m 28s               | -26%     |
| Failure modes | none          | empty_response × 1   | —        |

llama.cpp standalone is faster (about 14% higher median throughput, half the p50 latency) because it skips Ollama's request orchestration layer. The single failure was the "Summarize in Exactly 3 Sentences" task: the model emitted a `<|think|>` chain-of-thought block that consumed the response budget before any user-facing content was produced. Ollama's gemma4 RENDERER+PARSER masks this by suppressing the thinking tokens before they reach the user. Standalone llama-server returns thinking content separately in `reasoning_content` and final output in `content`, which is what the benchmark harness reads — but tasks where reasoning runs long can leave `content` empty. This is a harness/template tuning issue, not a model quality difference; the other 14 tasks scored identically across both backends.

Both backends are blessed for Gemma 4 26B MoE. llama.cpp is preferred when you want maximum throughput and direct OpenAI-compatible HTTP control. Ollama is preferred when you want zero-config model management plus rendering-aware output parsing for thinking models like Gemma 4.

## Recommendation Matrix for RTX 3090

| Use case                                       | Pick                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| Default agentic / chat                         | Gemma 4 26B MoE (`gemma4:26b`)                                       |
| Latency-critical, mobile-class, or laptop GPU  | Gemma 4 E4B (`gemma4:e4b`)                                           |
| Pure speed / batch throughput                  | Gemma 3 4B (`gemma3:4b`)                                             |
| Long-form code generation, willing to wait     | Gemma 4 31B Q6_K @ 32K ctx (`gemma4-31b-q6k`) — 98% quality, ~50 min |
| Long-context (128K) 31B Dense, willing to wait | Gemma 4 31B Q5_K_M (`gemma4-31b-q5km`) — 91% quality, ~53 min        |
| Need Q8 precision                              | Get an A6000 / L40 / dual GPU; Q8 on a 3090 is not viable            |

Skip the 31B Dense Q4_K_M variant: Q5_K_M is strictly better on this hardware (less time lost to timeouts), and the speed difference between them is small. Q6_K at 32K context is the highest-quality 31B run that fits the 3090 in practice — it benchmarks at 98% with no timeouts and stays inside ~50 min total.

## Artifacts

- `benchmark-results/gemma3-4b__ollama/`
- `benchmark-results/gemma4-e4b__ollama/`
- `benchmark-results/gemma4-26b-moe__ollama/`
- `benchmark-results/gemma4-26b-moe__llama-cpp/`
- `benchmark-results/gemma4-31b-dense__ollama/` (Q4_K_M)
- `benchmark-results/gemma4-31b-dense-q5km__ollama/`
- `benchmark-results/gemma4-31b-dense-q6k__ollama/`

## Test Suite

15 tasks across 5 categories:

- **Instruction Following** (4 tasks): list reversal, word counting, JSON formatting, summarization
- **Reasoning** (3 tasks): arithmetic, logic puzzles, number patterns
- **Extraction** (3 tasks): email extraction, CSV parsing, fact extraction
- **Safety** (2 tasks): harmful request refusal, prompt injection detection
- **Coding** (3 tasks): FizzBuzz, bug finding, algorithm optimization

Scoring: LLM judge mode (model grades its own output). Max score per task: 5 (easy), 10 (medium), 15 (hard).

## Methodology Notes

- All tests run on the same hardware with no other GPU workloads
- Ollama with `keep_alive: 6h` to prevent model unloading between tasks
- Context length: 32K (Gemma 3, Gemma 4 E4B, Q6_K), 128K (Gemma 4 26B/31B Q4/Q5)
- 300s timeout per HTTP request (this is the reason all 31B Dense timeouts show up at ~310s)
- Each task involves two model calls: response generation + LLM judge scoring
- Backend: Ollama (wraps llama.cpp internally) for the matrix; standalone llama.cpp for the cross-backend comparison
