## Field Notes — 2026-04-30

A weekly synthesis of what the r/LocalLLaMA community is reporting about Gemma 4 in real use.
Curated from the latest 14 Gemma-mentioning posts (5 net-new since 2026-04-29) and their top comment threads.
Confidence is **medium** unless noted, since this is community signal rather than a controlled benchmark.

### Headline this week

Two findings reshape how you should run Gemma 4 today. First, llama.cpp's preliminary SM120 native NVFP4 MMQ landed, and three Gemma 4 31B-it NVFP4 GGUFs are already live on Hugging Face. On consumer Blackwell (RTX 5xxx) that means prefill is a lot faster because weights speak the GPU's native FP4 language with no translation step. Second, a contributor traced the long-running "Gemma 4 is bad at tools" complaint to a real chat-template bug rather than a model deficiency, with a candidate fix already on the Hugging Face discussion. If your agent stack has been flaky, the runtime, not Gemma, was likely the bottleneck.

### Best current setup (today)

- **RTX 5xxx (Blackwell consumer):** if you have an SM120-class card, switch to a Gemma 4 31B-it NVFP4 GGUF and an llama.cpp build that includes [PR #22196](https://github.com/ggml-org/llama.cpp/pull/22196). Q4_K_M still falls back to the regular MMQ/MMA path, so you only see the speedup with NVFP4 weights. Early reports describe a meaningful prefill jump versus 35B-UD_Q4_XL on dual 5060 Ti 16GB rigs. ([source](https://reddit.com/r/LocalLLaMA/comments/1syjflw))
- **Mid-to-high single GPU (24+ GB VRAM, non-Blackwell):** Gemma 4 31B Dense at Q5_K_M or Q6_K is still the strongest single-card choice for general work and visual understanding. Drop to Q4 only if you have to, and expect more agentic-loop failures once you do.
- **Constrained GPU (8-16 GB VRAM):** Gemma 4 26B MoE at Q5_K_M holds up for local coding and chat. Treat Q3 as gambling for any workflow that depends on consistent JSON output.
- **CPU-only / Pi / Apple Silicon at the low end:** Gemma 4 E4B (effectively 9B-A4B on disk, ~9.6 GB) is still the practical workhorse. It runs at 140+ tok/s on a Ryzen 9 5900X and is the sane default for non-GPU rigs.
- **Apple Silicon (32-64 GB unified):** Gemma 4 26B MoE via Ollama Metal continues to perform; 48+ GB headroom can move up to 31B Dense, with the caveat from Apr 29 that MLX has not pulled ahead of GGUF for Gemma 4 yet.

### What works

- **Translation and creative writing.** This week's most upvoted thread (606 score) pulls together what people use Gemma 4 _for_: the model is consistently called the open-weights pick for translation and long-form creative output, while Qwen 3.6 leads on coding and game generation. ([source](https://reddit.com/r/LocalLLaMA/comments/1syt38w))
- **Visual understanding.** Gemma 4 remains the strongest open multimodal answer for image plus text, even from users who otherwise prefer Qwen 3.6 for code-heavy work. ([source](https://reddit.com/r/LocalLLaMA/comments/1sx5h1t))
- **Speculative decoding pairing.** Gemma 4 31B with Gemma 4 E2B as a draft model still delivers 120-200 tok/s on suitable tasks for users with the headroom. ([source](https://reddit.com/r/LocalLLaMA/comments/1sw782p))
- **Native FP4 on Blackwell.** The new NVFP4 path lets RTX 50-series cards skip the dequantize-then-multiply step entirely, since the tensor cores have FP4 math in silicon. The PR is preliminary, so expect rough edges, but this is the first time a full open-weights stack runs end-to-end at SM120 native FP4. ([source](https://reddit.com/r/LocalLLaMA/comments/1syjflw))

### Known limits

- **Tool calling has had a real bug, not just bad vibes.** A contributor traced Gemma 4's intermittent MCP/OpenAI tool failures to its Jinja chat template not being a faithful JSON Schema renderer. JSON shapes like `anyOf: [$ref, null]` (the standard "nullable reference" pattern) collapse to empty `type` fields before the model ever sees them. A patched template lives at [HF discussion 91](https://huggingface.co/google/gemma-4-31B-it/discussions/91); until it lands officially, prefer flat tool schemas and avoid `$ref`/`anyOf` compositions. This finally explains why Qwen 3.6 has felt more reliable as an agent than Gemma 4. ([source](https://reddit.com/r/LocalLLaMA/comments/1syps6i))
- **Translation quality drops fast on smaller languages.** A native Latvian speaker reports Gemma 4 31B understands the input fine but produces 2010-Google-Translate-grade output, with multiple spelling errors per word and brutal idiom transfer. Treat the "great at translation" reputation as English/Mandarin/Spanish-class, not universal. ([source](https://reddit.com/r/LocalLLaMA/comments/1syt38w))
- **Local coding still trails Claude Code on long horizons.** The widely-shared "I'm done with using local LLMs for coding" essay (806 score) argues that even Gemma 4 31B and Qwen 3.6 27B lose enough productivity vs Claude Code that the trade-off is hard to justify for serious deadline work. Calibrate expectations. ([source](https://reddit.com/r/LocalLLaMA/comments/1sxqa2c))
- **Quant floor matters more for agents than for chat.** With workflows that fire hundreds of tool calls, Q3 (and sometimes Q4) introduces small structural glitches (stray characters, malformed JSON) that break a run. Default to Q5_K_M or higher when budget allows. ([source](https://reddit.com/r/LocalLLaMA/comments/1ssdim1))
- **Safety filters on E2B.** Gemma-4-E2B's safety filters remain too aggressive for emergency or medical-shape prompts. Plan an unfiltered or alternate model for those use cases. ([source](https://reddit.com/r/LocalLLaMA/comments/1sr35pk))

### Open questions

- **Will the NVFP4 path beat regular Q4 on inference, or only prefill?** Early commentary is that the speedup is concentrated in prefill on consumer Blackwell. We need controlled before/after numbers on tokens-per-second for both prefill and decode at typical chat and agent context lengths.
- **How much of Gemma 4's "weak agent" reputation evaporates with the chat-template fix?** Side-by-side reruns of the recent OpenCode comparisons with the patched template will tell us whether Qwen 3.6's lead on tool calling was model quality or template plumbing.
- **Gemma 4 26B MoE quant sweet spot.** GGUF benchmarks for the MoE keep landing piecemeal. Q4_K_M vs Q5_K_M vs Q6_K trade-offs on consumer GPUs deserve a controlled run on our benchmark harness.
- **Strix Halo and unified-memory APUs.** Reports on AMD Strix Halo 128GB suggest viable 27-31B dense inference, but day-2 numbers are still sparse. Worth tracking through the late-2026 hardware cycle.
- **Granite 4.1 and Laguna XS.2/M.1 vs Gemma 4 at the same parameter count.** Two new model families dropped this week; neither has community-validated numbers yet, and the question is whether either lands on the Gemma 4 frontier or stays niche. ([Granite 4.1](https://reddit.com/r/LocalLLaMA/comments/1sz23wn), [Laguna](https://reddit.com/r/LocalLLaMA/comments/1sy6oxr))

### Sources

The 14 most relevant Gemma-mentioning posts driving this update, with the 5 newest first:

- [I stumbled on a Gemma 4 chat template bug for tools and fixed it](https://reddit.com/r/LocalLLaMA/comments/1syps6i) (Apr 29, 2026)
- [llama.cpp's Preliminary SM120 Native NVFP4 MMQ Is Merged](https://reddit.com/r/LocalLLaMA/comments/1syjflw) (Apr 29, 2026)
- [What it feels like to have to have Qwen 3.6 or Gemma 4 running locally](https://reddit.com/r/LocalLLaMA/comments/1syt38w) (Apr 29, 2026)
- [Introducing the IBM Granite 4.1 family of models (3B/8B/30B)](https://reddit.com/r/LocalLLaMA/comments/1sz23wn) (Apr 29, 2026)
- [Introducing Laguna XS.2 and Laguna M.1](https://reddit.com/r/LocalLLaMA/comments/1sy6oxr) (Apr 28, 2026)
- [How to run a local coding agent with Gemma 4 and Pi (Patrick Loeber)](https://reddit.com/r/LocalLLaMA/comments/1sx5h1t)
- [The 4B class of 2026](https://reddit.com/r/LocalLLaMA/comments/1sxch39)
- [Tested how OpenCode works with self-hosted LLMs (Qwen 3.5/3.6, Gemma 4, Nemotron 3, GLM-4.7)](https://reddit.com/r/LocalLLaMA/comments/1ssdim1)
- [I'm done with using local LLMs for coding](https://reddit.com/r/LocalLLaMA/comments/1sxqa2c)
- [Speculative decoding with Gemma-4-31B + Gemma-4-E2B](https://reddit.com/r/LocalLLaMA/comments/1sw782p)
- [Qwen 3.6 27B BF16 vs Q4_K_M vs Q8_0 GGUF evaluation](https://reddit.com/r/LocalLLaMA/comments/1sxzqry)
- [Local model on coding has reached a certain threshold to be feasible for real work](https://reddit.com/r/LocalLLaMA/comments/1sxn7x2)
- [Gemma 4 - MLX doesn't seem better than GGUF](https://reddit.com/r/LocalLLaMA/comments/1spn7zh)
- [Gemma-4-E2B's safety filters make it unusable for emergencies](https://reddit.com/r/LocalLLaMA/comments/1sr35pk)

The full set of 65 community reports lives in the Community Reports section above, filterable by hardware category and search.

_Last updated: 2026-04-30. Confidence: medium. Next update fires when the daily Gemma 4 research cron flags notable new findings._
