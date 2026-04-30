## Field Notes — 2026-04-29

A weekly synthesis of what the r/LocalLLaMA community is reporting about Gemma 4 in real use.
Curated from the latest 14 Gemma-mentioning posts and their top comment threads.
This is community signal, not a benchmark, and confidence is **medium** unless noted.

### Best current setup (today)

- **Mid-to-high GPU (24+ GB VRAM):** Gemma 4 31B Dense at Q6_K or higher remains the strongest single-GPU pick for general tasks and visual understanding. Drop to Q4 only if you must, and expect noticeably more glitches in agentic workflows.
- **Constrained GPU (8-16 GB VRAM):** Gemma 4 26B MoE at a good quant (Q5/Q6) holds up for local coding and chat. Q3 should be treated as gambling, not a working setup, when precision matters.
- **CPU-only / Pi / Apple Silicon at the low end:** Gemma 4 E4B (9.6 GB on disk, effectively 9B-A4B) is the practical workhorse. It runs at 140+ tok/s on a Ryzen 9 5900X and is the default we recommend for non-GPU rigs.
- **Apple Silicon (32-64 GB unified):** Gemma 4 26B MoE via Ollama Metal continues to perform; 48+ GB can move up to 31B Dense.

### What works

- **Visual understanding:** Gemma 4 is consistently called out as still the strongest open model for image+text, even by users who otherwise prefer Qwen 3.6 for coding. ([source](https://reddit.com/r/LocalLLaMA/comments/1sx5h1t))
- **Quality on real coding tasks:** Gemma 4 31B is reported to still match or beat Qwen 3.6 on some applications when the harness, quant, and context are tuned. The headline story is Qwen 3.6 27B catching up, not Gemma 4 falling off. ([source](https://reddit.com/r/LocalLLaMA/comments/1sx5h1t))
- **Speculative decoding pairing:** Gemma 4 31B paired with Gemma 4 E2B as a draft model continues to deliver 120-200 tok/s on specific tasks for users with the headroom. ([source](https://reddit.com/r/LocalLLaMA/comments/1sw782p))
- **Pi / coding agent walkthrough:** Patrick Loeber's tutorial on running a Gemma 4 coding agent on a Pi is now circulating; commenters note the same workflow generalizes to llama.cpp, not just LM Studio. ([source](https://reddit.com/r/LocalLLaMA/comments/1sx5h1t))

### Known limits

- **Local coding is not yet a Claude Code substitute.** A widely-upvoted writeup (806+ score) argues that even Gemma 4 31B and Qwen 3.6 27B lose enough productivity vs Claude Code that the trade-off is hard to justify for serious work. Calibrate expectations accordingly. ([source](https://reddit.com/r/LocalLLaMA/comments/1sxqa2c))
- **Quant floor matters for agents.** With agentic workflows that issue hundreds of tool calls, low quants (Q3, sometimes Q4) introduce small structural glitches (stray characters, malformed JSON) that break the run. Default to Q5_K_M or higher when you can. ([source](https://reddit.com/r/LocalLLaMA/comments/1ssdim1))
- **Safety filters on E2B.** Gemma-4-E2B's safety filters have been flagged as overly aggressive for emergency/medical-style prompts. Plan for an unfiltered or alternate model if that is your use case. ([source](https://reddit.com/r/LocalLLaMA/comments/1sr35pk))
- **E4B size confusion.** Gemma 4 E4B is a 9B-A4B MoE on disk, not a 4B dense model. Comparisons against true 4B competitors are not apples to apples. ([source](https://reddit.com/r/LocalLLaMA/comments/1sxch39))

### Open questions

- **Qwen 3.6 27B vs Gemma 4 31B for coding:** The community is mid-split on which is better, but tooling, quant, and context length keep changing the answer. We will keep an eye on harness-controlled comparisons.
- **Gemma 4 26B MoE quant sweet spot:** GGUF benchmarks are still landing. Q4_K_M vs Q5_K_M vs Q6_K trade-offs on consumer GPUs deserve their own controlled run on our benchmark harness.
- **Strix Halo and other unified-memory APUs:** Early reports on AMD Strix Halo 128GB suggest viable 27-31B dense inference, but day-2 numbers are sparse. Worth tracking for the late-2026 hardware cycle.

### Sources

The 14 newly updated Gemma-mentioning posts driving this update:

- [How to run a local coding agent with Gemma 4 and Pi (Patrick Loeber)](https://reddit.com/r/LocalLLaMA/comments/1sx5h1t)
- [The 4B class of 2026 (benchmark)](https://reddit.com/r/LocalLLaMA/comments/1sxch39)
- [Tested how OpenCode works with self-hosted LLMs (Qwen 3.5/3.6, Gemma 4, Nemotron 3, GLM-4.7)](https://reddit.com/r/LocalLLaMA/comments/1ssdim1)
- [Youtuber tries Qwen 3.5 35B, Qwen 3.6 35B, and Gemma 4 27B on large JS reverse engineering](https://reddit.com/r/LocalLLaMA/comments/1ssadey)
- [I'm done with using local LLMs for coding](https://reddit.com/r/LocalLLaMA/comments/1sxqa2c)
- [Qwen 3.6 27B BF16 vs Q4_K_M vs Q8_0 GGUF evaluation](https://reddit.com/r/LocalLLaMA/comments/1sxzqry)
- [Local model on coding has reached a certain threshold to be feasible for real work](https://reddit.com/r/LocalLLaMA/comments/1sxn7x2)
- [Built myself a bit of a local LLM workhorse (56 GB VRAM)](https://reddit.com/r/LocalLLaMA/comments/1sxd2sc)
- [Qwen 3.6 27B on Strix Halo 128GB: any experiences?](https://reddit.com/r/LocalLLaMA/comments/1sxbvux)
- [Qwen 3.6 is actually useful for vibe-coding, and way cheaper than Claude](https://reddit.com/r/LocalLLaMA/comments/1st3m8y)
- [Switched from Qwen 3.6 35B-A3B to Qwen 3.6 27B mid-coding](https://reddit.com/r/LocalLLaMA/comments/1swifke)
- [Is a high-end private local LLM setup worth it?](https://reddit.com/r/LocalLLaMA/comments/1ss7bcs)
- [Guys this is so fun!](https://reddit.com/r/LocalLLaMA/comments/1sxjnv4)
- [Something from Mistral (Vibe) tomorrow](https://reddit.com/r/LocalLLaMA/comments/1sy6xoo)

The full set of 61 community reports lives in the Community Reports section above, filterable by hardware category.

_Last updated: 2026-04-29. Confidence: medium. Next update fires when the daily Gemma4 research cron flags notable new findings._
