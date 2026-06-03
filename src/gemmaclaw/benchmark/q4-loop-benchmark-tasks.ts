import type { AgentBenchmarkTask } from "./agent-task-types.js";

export const Q4_LOOP_CONTEXT_BANDS = [16_000, 32_000, 64_000] as const;

const DONE_MARKER = "Q4_LOOP_BENCHMARK_DONE";

function repeatToApproxTokens(seed: string, targetTokens: number): string {
  const targetChars = targetTokens * 4;
  const chunks: string[] = [];
  let size = 0;
  let i = 1;
  while (size < targetChars) {
    const chunk = seed
      .replaceAll("{{ITERATION}}", String(i))
      .replaceAll("{{MODULE}}", `module-${String(i).padStart(4, "0")}`);
    chunks.push(chunk);
    size += chunk.length;
    i++;
  }
  return chunks.join("\n");
}

function buildContextPad(targetTokens: number): string {
  return repeatToApproxTokens(
    [
      "### Prior agent transcript shard {{ITERATION}}",
      "The previous worker inspected packages/{{MODULE}}/src/pricing.ts and confirmed that",
      "the discount calculation must clamp negative quantities before multiplying.",
      "It also inspected packages/{{MODULE}}/tests/pricing.test.ts and confirmed the",
      "failing assertion is about enterprise annual plans receiving the annual",
      "multiplier and the enterprise volume discount. Do not reinspect this shard after the fix",
      "is written. Preserve the evidence and move forward.",
      "",
      "Observed command transcript:",
      "$ pnpm test -- pricing",
      "FAIL packages/{{MODULE}}/tests/pricing.test.ts",
      "  expected annual enterprise total 820800 but received 864000",
      "  expected negative quantity to throw RangeError but received -1200",
      "",
      "Decision note:",
      "- The correct fix is in calculateInvoiceTotal, not in the test.",
      "- The helper normalizeSeats should reject non-positive seats.",
      "- Stop after writing the two target files and the evidence report.",
    ].join("\n"),
    targetTokens,
  );
}

export function buildQ4LoopAgenticPrompt(contextBandTokens: number): string {
  return [
    "Complete this Gemmaclaw Q4 loop-resistance benchmark task in the benchmark workspace.",
    "Use the available file tools to create or update files. Do not use real personal accounts.",
    "This task intentionally includes a long synthetic prior transcript to stress long-context",
    "plan/edit/test behavior. The prior transcript contains repeated-looking shards, but the",
    "actual task is at the end. Do not loop over the transcript. Do not keep re-inspecting",
    "evidence after you have enough information.",
    "",
    `## Context Band Target: ${contextBandTokens} approximate tokens`,
    buildContextPad(contextBandTokens),
    "",
    "## Current Workspace Fixtures",
    "Create these files if they do not already exist, then apply the fix.",
    "",
    "### package.json",
    "```json",
    JSON.stringify(
      {
        scripts: { test: "vitest run tests/pricing.test.ts" },
        dependencies: { vitest: "^1.6.0", typescript: "^5.4.0" },
        devDependencies: {},
      },
      null,
      2,
    ),
    "```",
    "",
    "### src/pricing.ts",
    "```ts",
    "export type Plan = 'starter' | 'business' | 'enterprise';",
    "",
    "const BASE_MONTHLY: Record<Plan, number> = {",
    "  starter: 1200,",
    "  business: 2400,",
    "  enterprise: 6000,",
    "};",
    "",
    "export function calculateInvoiceTotal(plan: Plan, seats: number, annual: boolean): number {",
    "  const subtotal = BASE_MONTHLY[plan] * seats;",
    "  const annualized = annual ? subtotal * 12 : subtotal;",
    "  return annualized;",
    "}",
    "```",
    "",
    "### tests/pricing.test.ts",
    "```ts",
    "import { describe, expect, it } from 'vitest';",
    "import { calculateInvoiceTotal } from '../src/pricing';",
    "",
    "describe('calculateInvoiceTotal', () => {",
    "  it('combines annual and enterprise volume discounts', () => {",
    "    expect(calculateInvoiceTotal('enterprise', 12, true)).toBe(820800);",
    "  });",
    "",
    "  it('rejects non-positive seats', () => {",
    "    expect(() => calculateInvoiceTotal('starter', -1, false)).toThrow(RangeError);",
    "  });",
    "});",
    "```",
    "",
    "## Required Work",
    "1. Write the fixed `src/pricing.ts` file.",
    "2. Preserve `tests/pricing.test.ts` exactly unless you need to recreate the fixture.",
    "3. Create `Q4_LOOP_RESULT.md` with the exact test command you would run and the expected passing assertions.",
    `4. End your final answer with the marker ${DONE_MARKER} and stop. Do not start another inspection cycle after that marker.`,
    "",
    "## Loop Failure Conditions",
    "- Repeating the same read or edit attempt three or more times.",
    "- Saying you need to inspect files after the relevant fixture has already been provided.",
    "- Emitting another tool call after the final marker.",
    "- Rewriting the same patch repeatedly without new state.",
  ].join("\n");
}

export function buildQ4LoopBenchmarkTask(contextBandTokens: number): AgentBenchmarkTask {
  return {
    id: `q4_loop_agentic_repo_fix_${Math.round(contextBandTokens / 1000)}k`,
    name: `Q4 Loop Agentic Repo Fix (${Math.round(contextBandTokens / 1000)}k context)`,
    description:
      "Long-context agentic coding fixture for measuring repeated inspection, duplicate edits, " +
      "failure to stop, and other loop-like behavior under low quantization or KV-cache settings.",
    category: "expanded_coding",
    difficulty: "very_hard",
    prompt: buildQ4LoopAgenticPrompt(contextBandTokens),
    grading: {
      type: "conversation_check",
      criteria: [
        "Must create or update src/pricing.ts with a non-positive seat guard",
        "Must apply both the annual multiplier and the enterprise volume discount so 12 annual enterprise seats total 820800",
        "Must create Q4_LOOP_RESULT.md with expected test evidence",
        `Must end the final answer with ${DONE_MARKER}`,
        "Must not repeat the same inspection or edit loop three or more times",
      ],
      maxScore: 120,
    },
  };
}

export const Q4_LOOP_BENCHMARK_TASKS: AgentBenchmarkTask[] = Q4_LOOP_CONTEXT_BANDS.map((band) =>
  buildQ4LoopBenchmarkTask(band),
);
