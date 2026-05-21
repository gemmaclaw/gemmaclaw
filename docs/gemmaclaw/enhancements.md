---
summary: "Gemmaclaw-specific setup enhancements beyond upstream OpenClaw"
read_when:
  - You are setting up a Gemmaclaw agent and want to understand default enhancements
  - You are adding a benchmark-driven improvement for Gemma-powered agents
title: "Gemmaclaw Enhancements"
---

# Gemmaclaw enhancements

Gemmaclaw enhancements are small improvements that Gemmaclaw applies beyond upstream OpenClaw defaults. They are deliberately registered in one place so setup, runtime injection, docs, tests, benchmarks, and future upstream-merge smoke checks all agree on what should exist.

The registry and generated prompt live in `src/gemmaclaw/gemmaclaw_instructions.ts`. Setup records the selected enhancement ids in `.gemmaclaw-enhancements.json`, and runtime bootstrap injection renders the code-owned instructions beside the workspace `AGENTS.md` context. The instructions are not copied into `AGENTS.md`.

## Gemmaclaw instructions

Every Gemmaclaw agent receives a code-owned self-awareness block from `gemmaclaw_instructions.ts`. It tells the agent that it is running as Gemmaclaw, links to the repo and docs, and instructs it to clone or update `~/gemmaclaw` to the latest default branch before inspecting its own implementation.

This global instruction is always injected. Enhancement flags control optional enhancement sections inside the same generated instruction context.

## Setup controls

By default, `gemmaclaw setup` enables the default enhancement set.

Use these flags to make the selection explicit:

```bash
gemmaclaw setup --enhancements default
gemmaclaw setup --enhancements all
gemmaclaw setup --enhancements none
gemmaclaw setup --no-enhancements
gemmaclaw setup --enhancements external_delivery_receipt_verification
```

Interactive setup asks whether to enable the default enhancement set. Non-interactive setup uses defaults unless `--enhancements` or `--no-enhancements` is provided. The chosen ids are persisted in `.gemmaclaw-enhancements.json`.

Benchmarks use a raw baseline by default. The agent benchmark harness writes `.gemmaclaw-enhancements.json` with an empty `enhancements` list unless `--gemmaclaw-enhancements <selection>` is provided. Use `default`, `all`, or a comma-separated id list only when you are intentionally measuring enhanced Gemmaclaw behavior.

## external_delivery_receipt_verification

Status: default enabled

Code and prompt:

- Registry and generated instructions: `src/gemmaclaw/gemmaclaw_instructions.ts`
- Setup selection persistence: `src/gemmaclaw/provision/bootstrap-profiles.ts`
- Runtime injection: `src/agents/bootstrap-files.ts`
- Agent-facing prompt location: injected as generated context path `gemmaclaw_instructions.ts`, beside `AGENTS.md`

What it does:

This enhancement tells agents not to claim that an external delivery succeeded until they verify the real provider response, send receipt, durable log, or benchmark mock receipt. It covers messages, media files, email, calendar mutations, webhooks, scheduled sends, and similar side effects.

It also calls out scheduled jobs specifically: an agent must verify the active scheduler location and trigger proof, not just write a copied config file in a workspace directory.

Failure class helped:

Jake previously overclaimed a scheduled Telegram audio job by writing local artifacts and reasoning about an inactive cron location, then saying the audio had been sent without a verified Telegram receipt. The enhancement generalizes the fix to any Gemmaclaw agent that performs externally visible delivery.

Benchmark guard:

- Benchmark id: `scheduled_media_delivery_verification`
- Benchmark docs: `docs/cli/benchmark.md`
- Harness seed helper: `scripts/benchmark/seed-mock-gog.py`

Run the benchmark both ways when measuring this enhancement:

```bash
pnpm benchmark agent --task scheduled_media_delivery_verification --backend openai-codex --model gpt-5.5 --thinking medium --gemmaclaw-enhancements none
pnpm benchmark agent --task scheduled_media_delivery_verification --backend openai-codex --model gpt-5.5 --thinking medium --gemmaclaw-enhancements default
```

Omitting `--gemmaclaw-enhancements` is equivalent to `none` for benchmarks. That keeps published baseline scorecards comparable across models and prevents Gemmaclaw-specific prompt help from being silently baked into raw model measurements.

Run setup-path smoke checks with enhancements enabled and disabled:

```bash
gemmaclaw setup --non-interactive --dry-run --agent-name enhance-container --setup-mode gemini --model google/gemini-2.5-flash --enhancements default
gemmaclaw setup --non-interactive --dry-run --agent-name plain-container --setup-mode gemini --model google/gemini-2.5-flash --no-enhancements
gemmaclaw setup --non-interactive --dry-run --agent-name enhance-host --setup-mode gemini --model google/gemini-2.5-flash --no-container --enhancements default
gemmaclaw setup --non-interactive --dry-run --agent-name plain-host --setup-mode gemini --model google/gemini-2.5-flash --no-container --no-enhancements
```

Expected evidence:

- Enabled agents have `external_delivery_receipt_verification` in `.gemmaclaw-enhancements.json` and receive it through generated `gemmaclaw_instructions.ts` runtime context.
- Disabled agents have an empty enhancement list in `.gemmaclaw-enhancements.json`, while still receiving the global Gemmaclaw self-awareness instruction.
- Container agents still include Docker sandbox guidance.
- Non-container agents omit Docker sandbox guidance.
- `onboarding.json` records the selected enhancement ids.
