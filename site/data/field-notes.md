## Field Notes — 2026-05-01

A weekly synthesis of what the r/LocalLLaMA community is reporting about Gemma 4 in real use.
Curated from the latest 14 Gemma-mentioning posts (5 net-new since 2026-04-30) and their top comment threads.
Confidence is **medium** unless noted, since this is community signal rather than a controlled benchmark.

### Headline this week

The Gemma-versus-Qwen story stopped being a horse race and became a niche split. The week's most influential meta-thread (80 score, 121 comments) asks whether Qwen 3.6 has obsoleted other 30B models, and the highest-rated answers all push back the same way: Gemma 4 still wins on writing, tone, fiction, summarization, and multimodal, while Qwen 3.6 owns code, agents, and tool-heavy workflows. Treat them as complementary in the 27-35B band rather than picking one global winner. At the same time, a community trial of Ling-2.6-1T (a fresh trillion-parameter open release) had Gemma 4 31B "nail" a 40-line Hugging Face Transformers script that Ling bungled with hallucinated config flags, which is a useful reminder that for short, well-scoped tasks a tight 31B can still beat a much larger model. The NVFP4-on-Blackwell and chat-template-bug findings from 2026-04-29 are still the load-bearing changes for how you should run Gemma 4 today, see "Known limits" for the patched-template caveat.

### Best current setup (today)

- **RTX 5xxx (Blackwell consumer):** if you have an SM120-class card, switch to a Gemma 4 31B-it NVFP4 GGUF and an llama.cpp build that includes [PR #22196](https://github.com/ggml-org/llama.cpp/pull/22196). Q4_K_M still falls back to the regular MMQ/MMA path, so you only see the speedup with NVFP4 weights. Early reports describe a meaningful prefill jump versus 35B-UD_Q4_XL on dual 5060 Ti 16GB rigs. ([source](https://reddit.com/r/LocalLLaMA/comments/1syjflw))
- **Mid-to-high single GPU (24+ GB VRAM, non-Blackwell):** Gemma 4 31B Dense at Q5_K_M or Q6_K is still the strongest single-card choice for general work, writing, and visual understanding. Drop to Q4 only if you have to, and expect more agentic-loop failures once you do.
- **Constrained GPU (8-16 GB VRAM):** Gemma 4 26B MoE at Q5_K_M holds up for local writing, chat, and translation. For pure code work in this band the community is increasingly defaulting to Qwen 3.6 27B; keep Gemma 4 for the prose half of your stack. Treat Q3 as gambling for any workflow that depends on consistent JSON output.
- **CPU-only / Pi / Apple Silicon at the low end:** Gemma 4 E4B (effectively 9B-A4B on disk, ~9.6 GB) is still the practical workhorse. It runs at 140+ tok/s on a Ryzen 9 5900X and is the sane default for non-GPU rigs. New this week: small-model agent reports flag `gemma4:e4b` (alongside `qwen3.5:9b`) as the most consistent at instruction-following on markdown fences, so it remains the right pick if you also need it to drive an agent loop, with the caveat below. ([source](https://reddit.com/r/LocalLLaMA/comments/1szsdyb))
- **Apple Silicon (32-64 GB unified):** Gemma 4 26B MoE via Ollama Metal continues to perform; 48+ GB headroom can move up to 31B Dense, with the standing caveat that MLX has not pulled ahead of GGUF for Gemma 4 yet.

### What works

- **Writing, tone, fiction, summarization.** This week's biggest meta-thread (80 score, 121 comments) makes the niche split explicit. The top three answers all converge: Gemma is "MUCH better than Qwen in writing and tone," "the best at non-code tasks," and "a lot better at writing fiction, so it's definitely not obsolete." If your workload is prose, Gemma 4 26B/31B is still the open-weights pick. ([source](https://reddit.com/r/LocalLLaMA/comments/1t00d2m))
- **Translation and multilingual prose at major-language scale.** Confirmed again this week alongside the broader writing story; treat the strong reputation as English/Mandarin/Spanish-class, not universal (see Known limits).
- **Visual understanding.** Gemma 4 remains the strongest open multimodal answer for image plus text, even from users who otherwise prefer Qwen 3.6 for code-heavy work. Configure the [variable image resolution](https://huggingface.co/google/gemma-4-31B-it#5-variable-image-resolution) feature instead of sending images at default budget. ([source](https://reddit.com/r/LocalLLaMA/comments/1srrhi5))
- **Tight, well-scoped code tasks.** A community trial of Ling-2.6-1T reported that Gemma 4 31B wrote a clean 40-line Hugging Face Transformers inference script, while a freshly released trillion-parameter model "completely bungled it, hallucinated a bunch of non-existent config flags, wrote 250 lines of dead code, and added a comment that it was tested and working." Parameter count is not destiny on short coding prompts; well-trained 31B models still hold up. ([source](https://reddit.com/r/LocalLLaMA/comments/1sz59l4))
- **Format compliance for small-model agents.** A practitioner's failure-mode review of small-model coding agents calls out `gemma4:e4b` and `qwen3.5:9b` as the most consistent at obeying "no markdown fences" instructions, while still slipping enough that fence-stripping has to be a default in post-processing. For E4B-class coding-agent stacks this is an important small-but-real win. ([source](https://reddit.com/r/LocalLLaMA/comments/1szsdyb))
- **Speculative decoding pairing.** Gemma 4 31B with Gemma 4 E2B as a draft model still delivers 120-200 tok/s on suitable tasks for users with the headroom. ([source](https://reddit.com/r/LocalLLaMA/comments/1sw782p))
- **Native FP4 on Blackwell.** The new NVFP4 path lets RTX 50-series cards skip the dequantize-then-multiply step entirely, since the tensor cores have FP4 math in silicon. The PR is preliminary, so expect rough edges, but this is the first time a full open-weights stack runs end-to-end at SM120 native FP4. ([source](https://reddit.com/r/LocalLLaMA/comments/1syjflw))

### Known limits

- **Tool calling has had a real bug, not just bad vibes.** A contributor traced Gemma 4's intermittent MCP/OpenAI tool failures to its Jinja chat template not being a faithful JSON Schema renderer. JSON shapes like `anyOf: [$ref, null]` (the standard "nullable reference" pattern) collapse to empty `type` fields before the model ever sees them. A patched template lives at [HF discussion 91](https://huggingface.co/google/gemma-4-31B-it/discussions/91); until it lands officially, prefer flat tool schemas and avoid `$ref`/`anyOf` compositions. This still explains a lot of why Qwen 3.6 has felt more reliable as an agent than Gemma 4. ([source](https://reddit.com/r/LocalLLaMA/comments/1syps6i))
- **Qwen 3.6 leads on code and agents in the same size band.** This is now the dominant community read across the 27-35B range: for coding agent workflows, tool calling, and long agentic loops, Qwen 3.6 27B/35B-A3B is materially more reliable than Gemma 4 26B/31B at the same quant. If your work is primarily code, default Qwen and use Gemma 4 as the prose specialist. ([source](https://reddit.com/r/LocalLLaMA/comments/1t00d2m))
- **Structured output stays unreliable below 7B.** The new small-model agent post argues that JSON-shaped output from sub-7B models (including the E-class Gemma 4 variants) breaks often enough that you have to validate paths, classify actions, and check outputs in boring code. Don't let the model write directly to disk. XML or "intent + tiny patch plan + boring code" patterns are noticeably more robust than asking for raw JSON. ([source](https://reddit.com/r/LocalLLaMA/comments/1szsdyb))
- **Translation quality drops fast on smaller languages.** A native Latvian speaker reports Gemma 4 31B understands the input fine but produces 2010-Google-Translate-grade output, with multiple spelling errors per word and brutal idiom transfer. Treat the "great at translation" reputation as English/Mandarin/Spanish-class, not universal. ([source](https://reddit.com/r/LocalLLaMA/comments/1syt38w))
- **Local coding still trails Claude Code on long horizons.** The widely-shared "I'm done with using local LLMs for coding" essay argues that even Gemma 4 31B and Qwen 3.6 27B lose enough productivity vs Claude Code that the trade-off is hard to justify for serious deadline work. Calibrate expectations. ([source](https://reddit.com/r/LocalLLaMA/comments/1sxqa2c))
- **Quant floor matters more for agents than for chat.** With workflows that fire hundreds of tool calls, Q3 (and sometimes Q4) introduces small structural glitches (stray characters, malformed JSON) that break a run. Default to Q5_K_M or higher when budget allows. ([source](https://reddit.com/r/LocalLLaMA/comments/1ssdim1))
- **Safety filters on E2B.** Gemma-4-E2B's safety filters remain too aggressive for emergency or medical-shape prompts. Plan an unfiltered or alternate model for those use cases. The community has uncensored Qwen 3.6 35B-A3B Heretic GGUFs available now if you need that path; no equivalent Gemma 4 release has surfaced. ([source 1](https://reddit.com/r/LocalLLaMA/comments/1sr35pk), [source 2](https://reddit.com/r/LocalLLaMA/comments/1sw5fb7))

### Open questions

- **Will a larger Gemma 4 ship?** A new ask-thread on r/LocalLLaMA reignited the question, with one frequent contributor confirming Google "teased us with a 120B during their beta-testing" and another already sketching a hybrid dense/sparse Gemma 4 derived from existing checkpoints. No public release timeline, no leak-grade signal yet. ([source](https://reddit.com/r/LocalLLaMA/comments/1szi1mh))
- **How much of Gemma 4's "weak agent" reputation evaporates with the chat-template fix?** Side-by-side reruns of the recent OpenCode comparisons with the patched template will tell us whether Qwen 3.6's lead on tool calling was model quality or template plumbing. We still don't have those numbers.
- **Will the NVFP4 path beat regular Q4 on inference, or only prefill?** Early commentary is that the speedup is concentrated in prefill on consumer Blackwell. We need controlled before/after numbers on tokens-per-second for both prefill and decode at typical chat and agent context lengths.
- **Gemma 4 26B MoE quant sweet spot.** GGUF benchmarks for the MoE keep landing piecemeal. Q4_K_M vs Q5_K_M vs Q6_K trade-offs on consumer GPUs deserve a controlled run on our benchmark harness.
- **Strix Halo and unified-memory APUs.** Reports on AMD Strix Halo 128GB suggest viable 27-31B dense inference, but day-2 numbers are still sparse. Worth tracking through the late-2026 hardware cycle.
- **Granite 4.1 and Laguna XS.2/M.1 vs Gemma 4 at the same parameter count.** Both new families dropped late last week and still have no community-validated head-to-head numbers. ([Granite 4.1](https://reddit.com/r/LocalLLaMA/comments/1sz23wn), [Laguna](https://reddit.com/r/LocalLLaMA/comments/1sy6oxr))

### Sources

The 14 most relevant Gemma-mentioning posts driving this update, with the 5 newest first:

- [Are Qwen 3.6 27B and 35B making other ~30B models obsolete?](https://reddit.com/r/LocalLLaMA/comments/1t00d2m) (Apr 30, 2026)
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

The full set of 70 community reports lives in the Community Reports section above, filterable by hardware category and search.

_Last updated: 2026-05-01. Confidence: medium. Next update fires when the daily Gemma 4 research cron flags notable new findings._
