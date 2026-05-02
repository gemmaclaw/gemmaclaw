## Field Notes — 2026-05-02

A weekly synthesis of what the r/LocalLLaMA community is reporting about Gemma 4 in real use.
Curated from the latest Gemma-mentioning posts (13 net-new since 2026-05-01) and their top comment threads.
Confidence is **medium** unless noted, since this is community signal rather than a controlled benchmark.

_Morning re-check, 2026-05-02 08:30 EDT:_ a follow-up sweep against the past 24 hours of r/LocalLLaMA confirmed three additional posts worth recording. A first-hand AMD Radeon 9060 XT 16GB report (eGPU on a 7840HS mini-PC) lands the 24B A4B IQ4_NL variant at 25.9 tok/s with KV cache at q8_0 and a small 256-token target. More importantly, two independent posts within fourteen hours documented an emerging "zombie loops" failure mode on both Gemma 4 and Qwen 3.6 with quantized KV cache during thinking mode. The convergent expert reading is that q4_0 KV quantization accumulates drift across hundreds of internal reasoning tokens until the model falls into a repetition attractor. This pattern is now strong enough to call out as a known limit (see below).

_Evening re-check, 2026-05-02 17:45 EDT:_ the post-PR #82 sweep found two new high-signal items rather than a broad hardware shift. First, a local vLLM/FP8 vision comparison reports Gemma 4 staying much more concise on messy real-world image prompts, often around 1,500 thinking tokens where Qwen 3.6 can burn 8,000+ tokens and sometimes fail to finish. The same report says Gemma 4 followed normalized 0 to 1 bounding-box JSON instructions more reliably, while Qwen 3.6 did better on the tested 2 FPS deadlift video tracking case. Second, an SGLang production report identified an FP8 KV-cache bug for models with per-layer KV scales, explicitly including Gemma 4, where radix-cache prefix hits can silently corrupt output unless the deployment uses BF16 KV cache or the upstream fix lands. This reinforces the current guidance: for long-context or thinking-mode work, treat KV-cache precision and serving backend as quality controls, not just speed knobs. ([vision source](https://reddit.com/r/LocalLLaMA/comments/1t1te8y), [SGLang source](https://reddit.com/r/LocalLLaMA/comments/1t0s1oa), [PR #24198](https://github.com/sgl-project/sglang/pull/24198))

### Headline this week

Gemma 4's gamedev moment went viral. A Pacman clone challenge on MacBook Pro M5 Max (778 score, 157 comments) saw Gemma 4 31B produce a clean, working game in under 4 minutes and 6,200 tokens, while Qwen 3.6 27B took 18 minutes, 34,000 tokens, and delivered more visual flair but more bugs. The post crystallized the emerging community consensus: Gemma 4 wins on concise, correct, single-shot code generation, while Qwen excels on longer, more creative explorations. Meanwhile, Nvidia released an official NVFP4 quantization of Gemma 4 26B MoE that is near-lossless (benchmarks within 0.4% of full precision) and fits in 18.8GB, and a separate DFlash release for the 31B dense model promises further speedups once llama.cpp merges the supporting PR. The niche-split story from last week is now reinforced with hard numbers: keep both models, use Gemma for quality, Qwen for volume.

### Best current setup (today)

- **RTX 5xxx (Blackwell consumer):** Gemma 4 26B MoE now has an official [nvidia/Gemma-4-26B-A4B-NVFP4](https://huggingface.co/nvidia/Gemma-4-26B-A4B-NVFP4) quant at 18.8GB. On a 5090 with 80% VRAM allocation, users report ~50K context. Benchmarks are near-lossless: GPQA Diamond 79.9% vs 80.3% baseline, AIME 2025 actually improved to 90.0% from 88.95%. Community speculation is that NVFP4 acts as regularization on MoE routing (prevents over-commitment to dominant expert pathways). For 31B Dense, NVFP4 GGUF with llama.cpp [PR #22196](https://github.com/ggml-org/llama.cpp/pull/22196) remains the path. ([source](https://reddit.com/r/LocalLLaMA/comments/1t0i18e))
- **Mid-to-high single GPU (24+ GB VRAM, non-Blackwell):** Gemma 4 31B Dense at Q5_K_M or Q6_K remains the strongest single-card choice for general work, writing, and visual understanding. New this week: the DFlash variant ([gemma-4-31B-it-DFlash](https://huggingface.co/z-lab/gemma-4-31B-it-DFlash)) has been released but still needs [llama.cpp PR #22105](https://github.com/ggml-org/llama.cpp/pull/22105) to merge before practical use. ggerganov is reportedly planning a speculative-architecture refactor first. ([source](https://reddit.com/r/LocalLLaMA/comments/1t0s4qv))
- **Constrained GPU (8-16 GB VRAM):** Detailed speed benchmarks from an RTX 4070S 12GB user (DDR5 6000MHz, iGPU display offload) show Gemma 4 26B MoE and 31B Dense both runnable with substantial CPU offload. The 12GB club is real: careful config tuning (CUDA 13.1, display offload to iGPU, cache reuse settings) gets 40 t/s on 35B Q6 with system RAM spill. Keep Gemma 4 for prose and Qwen 3.6 for code in this tier. ([source](https://reddit.com/r/LocalLLaMA/comments/1szziv0))
- **AMD consumer GPU (Radeon 9060 XT 16GB, eGPU):** A first-hand report on a 7840HS mini-PC paired with an external Radeon 9060 XT lands the Gemma 4 24B A4B IQ4_NL variant at 25.9 tok/s via llama-server, with KV cache at q8_0 and a small 256-token batch target. The user notes the configuration is usable for OpenCode codebase Q&A. Reply chain confirms 16GB is tight at 128K context and forces partial CPU offload, so for steady-state work expect lower numbers when context fills. ([source](https://reddit.com/r/LocalLLaMA/comments/1t0kxdw))
- **CPU-only / Pi / Apple Silicon at the low end:** Gemma 4 E4B remains the practical workhorse. No new findings this cycle; previous guidance stands.
- **Apple Silicon (32-64 GB unified):** The viral Pacman test ran Gemma 4 31B at 27 tok/s on M5 Max 64GB, confirming strong Apple Silicon inference. MLX has still not pulled ahead of GGUF for Gemma 4. ([source](https://reddit.com/r/LocalLLaMA/comments/1t0epei))
- **Professional GPUs (RTX 6000 Pro, 96GB):** Community strongly recommends sglang or vLLM over llama.cpp for these cards due to MTP support and better large-context handling. Users running llama.cpp on RTX 6000 Pro are "seriously gimping that card." ([source](https://reddit.com/r/LocalLLaMA/comments/1t19iil))

### What works

- **Concise, correct single-shot code generation.** The viral Pacman post (778 score) is the clearest demonstration yet. Gemma 4 31B on M5 Max produced a working game in 3m51s with 6,209 tokens: shorter, clearer, and functionally correct on first run. Qwen 3.6 27B spent 18m04s and 33,946 tokens with more visual creativity but more bugs. This pattern holds across similar community tests: Gemma tends to produce tighter, more correct code, Qwen produces more elaborate but less reliable output. ([source](https://reddit.com/r/LocalLLaMA/comments/1t0epei))
- **Writing, tone, fiction, summarization.** The niche-split consensus from last week is now even stronger. The "are 30B models obsolete?" thread (139 score, 144 comments) keeps accumulating confirming answers: Gemma is "MUCH better than Qwen in writing and tone," "the best at non-code tasks." ([source](https://reddit.com/r/LocalLLaMA/comments/1t00d2m))
- **Near-lossless NVFP4 for MoE.** The Nvidia NVFP4 quant of Gemma 4 26B MoE preserves quality to within 0.4% across multiple benchmarks, and in some cases slightly exceeds full precision. A practitioner with 90 ablation experiments explains this as NVFP4 acting as regularization on the 128-expert router, preventing over-commitment to dominant pathways. This is an important finding for anyone running the MoE variant. ([source](https://reddit.com/r/LocalLLaMA/comments/1t0i18e))
- **Visual understanding.** Remains the strongest open multimodal answer for image-plus-text tasks. No new contradicting signal.
- **Speculative decoding pairing.** Gemma 4 31B + E2B draft model still delivers 120-200 tok/s on suitable tasks. DFlash may further improve this once merged. ([source](https://reddit.com/r/LocalLLaMA/comments/1sw782p))
- **Native FP4 on Blackwell.** Now available for both the 31B Dense (via community GGUF) and the 26B MoE (via Nvidia's official release). ROCm/Vulkan support for NVFP4 is also emerging via llama.cpp and third-party kernels like [petit-kernel](https://github.com/causalflow-ai/petit-kernel). ([source](https://reddit.com/r/LocalLLaMA/comments/1t0i18e))

### Known limits

- **Tool calling has had a real bug, not just bad vibes.** The Jinja chat template issue identified last week is still unpatched upstream. A patched template lives at [HF discussion 91](https://huggingface.co/google/gemma-4-31B-it/discussions/91). Community prediction for May: a "4.1" release fixing tool-calling problems would be the single most impactful update. ([source](https://reddit.com/r/LocalLLaMA/comments/1syps6i))
- **Qwen 3.6 leads on code and agents in the same size band.** Still the dominant community read. For coding agent workflows and long agentic loops, Qwen 3.6 is materially more reliable. But the Pacman test shows Gemma 4 can beat Qwen on one-shot code quality when the task is well-scoped. The gap narrows when you don't need sustained multi-turn tool calling. ([source](https://reddit.com/r/LocalLLaMA/comments/1t00d2m))
- **DFlash is released but blocked.** The z-lab DFlash variant for Gemma 4 31B is published on HuggingFace, but the llama.cpp PR (#22105) remains a draft. ggerganov reportedly wants to refactor the broader speculative codebase first to unify various speculative methods. z-lab was also acquired by HuggingFace, which may affect the timeline. ([source](https://reddit.com/r/LocalLLaMA/comments/1t0s4qv))
- **Fine-tuning Gemma 4 is harder than expected.** A community prediction thread flags that Gemma 4's architecture "seems to be making fine-tuning tricky" and notes that Gemma 4 "didn't really take over the fine-tune crowd." If you need a fine-tunable base, this is a real friction point to watch. ([source](https://reddit.com/r/LocalLLaMA/comments/1t14yhr))
- **Professional GPUs need sglang/vLLM, not llama.cpp.** Users with RTX 6000 Pro (96GB) cards report significantly faster inference with sglang or vLLM due to MTP (Multi-Token Prediction) support and better large-context handling. llama.cpp leaves substantial performance on the table for these cards. This likely applies to the RTX Pro 6000 (sm_120) and DGX Spark (sm_121) as well. ([source](https://reddit.com/r/LocalLLaMA/comments/1t19iil))
- **Structured output stays unreliable below 7B.** Still valid from last week. Validate paths, classify actions, and check outputs in code for sub-7B models.
- **Safety filters on E2B.** Still too aggressive for emergency/medical prompts. No equivalent Gemma 4 uncensored release has surfaced.
- **Zombie loops on quantized KV cache during thinking mode.** Two independent posts within fourteen hours documented Gemma 4 and Qwen 3.6 both falling into terminal repetition loops while in thinking mode: one user on dual RTX 5060 Ti 16GB was running Qwen 3.6 35B-A3B Q4_K_M with `-ctv q4_0 -ctk q4_0` and saw the model emit endless `/` characters during thinking, then reproduced the same failure on Gemma 4. A second poster confirmed the same pattern on Qwen 3.6-35B-A3B and Gemma 4-26B-A4B at Q3 and Q4 quants. The convergent expert reading from u/lit1337 (replied on both threads): q4_0 KV cache accumulates rounding drift across the hundreds of internal tokens that thinking mode generates, eventually pushing the model into a repetition attractor it cannot escape. Workarounds reported in the threads: drop reasoning budget to 0 (kills the loop but disables thinking), raise KV cache precision to q8_0 or fp16, ensure context is not overflowing and the host tool compacts before the limit, and check that you are on CUDA toolkit 13.1 rather than 13.2 since 13.2 has its own confirmed regression with these models. Treat quantized KV cache as a real risk for any thinking-mode workload until upstream stabilizes. ([source 1](https://reddit.com/r/LocalLLaMA/comments/1t08f2g), [source 2](https://reddit.com/r/LocalLLaMA/comments/1t0pejd))

- **SGLang FP8 KV cache can silently corrupt outputs on affected versions.** A production report from AI Router Switzerland traced silent garbage output in Qwen3.6-27B-FP8 to the ragged plus paged attention split path dropping `k_scale`/`v_scale` during radix-cache prefix hits. The author explicitly says the same class can affect FP8 models such as Gemma 4 that store per-layer KV scales. Verified upstream state: [SGLang PR #24198](https://github.com/sgl-project/sglang/pull/24198) is open and approved. Until it lands in the serving build, keep Gemma 4 FP8 deployments on BF16 KV cache or apply the patch before trusting prefix-cache reuse. ([source](https://reddit.com/r/LocalLLaMA/comments/1t0s1oa))

### Open questions

- **Will Google ship a Gemma 4.1 with fixed tool calling?** The community's top May prediction is a "4.1" point release that fixes the template-level tool-calling bug. If it happens, it could significantly close the gap with Qwen 3.6 on agent workloads. No official signal yet. ([source](https://reddit.com/r/LocalLLaMA/comments/1t14yhr))
- **When will DFlash land in llama.cpp?** The speculative-architecture refactor is the bottleneck. Once merged, DFlash could meaningfully improve inference speed for the 31B Dense model, especially when paired with E2B draft models.
- **Will NVFP4 quality hold across AMD via Vulkan/ROCm?** Early support exists via llama.cpp Vulkan and third-party kernels, but no controlled benchmarks on AMD hardware yet. ([source](https://reddit.com/r/LocalLLaMA/comments/1t0i18e))
- **How much does the fine-tuning difficulty matter?** If the community can't easily fine-tune Gemma 4, Qwen 3.6 may absorb the fine-tune crowd entirely, limiting Gemma 4's ecosystem growth.
- **Strix Halo and unified-memory APUs.** Reports on AMD Strix Halo 128GB suggest viable 27-31B dense inference, but data is still thin.
- **April 2026 was "one of the best months ever" for local LLMs.** A retrospective post (518 score) catalogues a historic month. The question is whether May sustains the pace. ([source](https://reddit.com/r/LocalLLaMA/comments/1t06y43))

### Sources

The most relevant Gemma-mentioning posts driving this update, with the newest first:

- [Qwen 3.6 wins the benchmarks, but Gemma 4 wins reality](https://reddit.com/r/LocalLLaMA/comments/1t1te8y) (May 2, 2026, 20 score)
- [SGLang FP8 KV cache corruption and image-request memory leak PRs](https://reddit.com/r/LocalLLaMA/comments/1t0s1oa) (May 1, 2026, 2 score)
- [Qwen 3.6 27B vs Gemma 4 31B - making Packman game!](https://reddit.com/r/LocalLLaMA/comments/1t0epei) (May 1, 2026, 862 score)
- [nvidia/Gemma-4-26B-A4B-NVFP4](https://reddit.com/r/LocalLLaMA/comments/1t0i18e) (May 1, 2026, 213 score)
- [Been using Qwen-3.6-27B + VSCode + RTX 6000 Pro as daily driver](https://reddit.com/r/LocalLLaMA/comments/1t19iil) (May 1, 2026, 184 score)
- [gemma-4-31B-it-DFlash has been released](https://reddit.com/r/LocalLLaMA/comments/1t0s4qv) (May 1, 2026, 117 score)
- [Your local LLM predictions and hopes for May 2026](https://reddit.com/r/LocalLLaMA/comments/1t14yhr) (May 1, 2026, 34 score)
- [12GB-Club: 4070S speeds for Gemma 4 and Qwen 3.6](https://reddit.com/r/LocalLLaMA/comments/1szziv0) (Apr 30, 2026, 31 score)
- [Using a Radeon 9060 XT 16 GB, the gemma4 24b a4b iq4 nl model achieves 25.9 t/s](https://reddit.com/r/LocalLLaMA/comments/1t0kxdw) (May 1, 2026, 5 score)
- [Qwen 3.6 and Gemma 4 "Zombie Loops" (terminal thinking loops)](https://reddit.com/r/LocalLLaMA/comments/1t08f2g) (Apr 30, 2026, 5 score)
- [Model stuck in some thinking zone where it keeps saying a similar thing again and again](https://reddit.com/r/LocalLLaMA/comments/1t0pejd) (May 1, 2026, 4 score)
- [Open Models - April 2026 retrospective](https://reddit.com/r/LocalLLaMA/comments/1t06y43) (Apr 30, 2026, 518 score)
- [Qwen3.6-27B on dual RTX 5060 Ti 16GB with vLLM](https://reddit.com/r/LocalLLaMA/comments/1sysyz2) (Apr 29, 2026)
- [Are Qwen 3.6 27B and 35B making other ~30B models obsolete?](https://reddit.com/r/LocalLLaMA/comments/1t00d2m) (Apr 30, 2026, 139 score)
- [Notes on what actually breaks when you run a coding agent on small local models](https://reddit.com/r/LocalLLaMA/comments/1szsdyb) (Apr 30, 2026)
- [Larger Gemma-4/Qwen3.6](https://reddit.com/r/LocalLLaMA/comments/1szi1mh) (Apr 30, 2026)
- [inclusionAI/Ling-2.6-1T (Hugging Face)](https://reddit.com/r/LocalLLaMA/comments/1sz59l4) (Apr 29, 2026)
- [I stumbled on a Gemma 4 chat template bug for tools and fixed it](https://reddit.com/r/LocalLLaMA/comments/1syps6i) (Apr 29, 2026)
- [llama.cpp's Preliminary SM120 Native NVFP4 MMQ Is Merged](https://reddit.com/r/LocalLLaMA/comments/1syjflw) (Apr 29, 2026)
- [What it feels like to have to have Qwen 3.6 or Gemma 4 running locally](https://reddit.com/r/LocalLLaMA/comments/1syt38w) (Apr 29, 2026)
- [Introducing Laguna XS.2 and Laguna M.1](https://reddit.com/r/LocalLLaMA/comments/1sy6oxr) (Apr 28, 2026)
- [How to run a local coding agent with Gemma 4 and Pi (Patrick Loeber)](https://reddit.com/r/LocalLLaMA/comments/1sx5h1t)
- [The 4B class of 2026](https://reddit.com/r/LocalLLaMA/comments/1sxch39)
- [Tested how OpenCode works with self-hosted LLMs (Qwen 3.5/3.6, Gemma 4, Nemotron 3, GLM-4.7)](https://reddit.com/r/LocalLLaMA/comments/1ssdim1)
- [I'm done with using local LLMs for coding](https://reddit.com/r/LocalLLaMA/comments/1sxqa2c)
- [Speculative decoding with Gemma-4-31B + Gemma-4-E2B](https://reddit.com/r/LocalLLaMA/comments/1sw782p)
- [Gemma-4-E2B's safety filters make it unusable for emergencies](https://reddit.com/r/LocalLLaMA/comments/1sr35pk)

The full set of 82 community reports lives in the Community Reports section above, filterable by hardware category and search.

_Last updated: 2026-05-02 (evening re-check). Confidence: medium. Next update fires when the daily Gemma 4 research cron flags notable new findings._
