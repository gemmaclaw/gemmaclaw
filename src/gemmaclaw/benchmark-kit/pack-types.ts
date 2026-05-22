/**
 * Benchmark Kit pack types: typed, schema-validated discriminated union for
 * task packs. Mirrors the v1 pack contract used by Gemmaclaw's local-agent
 * benchmark fixtures.
 *
 * Two families today:
 *   - "tool-free": grades raw model output to a prompt (benchmark-kit core).
 *   - "agent":     grades a multi-turn agent loop (OpenClaw runner).
 *
 * The legacy benchmark-kit pack format (no `schemaVersion`, no `family`) is
 * still accepted by `parseBenchmarkPack` and treated as `family: "tool-free"`.
 * Newly authored packs SHOULD declare `schemaVersion: "1"` and `family`.
 */

import { z } from "zod";

const TaskFamilyEnum = z.enum(["agent", "tool-free"]);

const TaskDifficultyEnum = z.enum(["easy", "medium", "hard", "very_hard", "expert"]);

const ToolFreeGradingTypeEnum = z.enum([
  "exact_match",
  "contains_all",
  "json_structure",
  "output_quality",
]);

const AgentGradingTypeEnum = z.enum([
  "output_check",
  "command_check",
  "artifact_check",
  "file_check",
  "multi_check",
  "security_check",
  "error_check",
]);

const ToolFreeGradingSchema = z.object({
  type: ToolFreeGradingTypeEnum,
  expected: z.array(z.string()).optional(),
  requiredKeys: z.array(z.string()).optional(),
  criteria: z.array(z.string()).optional(),
  maxScore: z.number().nonnegative(),
});

const AgentSubcheckSchema = z.object({
  type: z.string(),
  criteria: z.array(z.string()).optional(),
  weight: z.number().nonnegative(),
});

/**
 * Agent grading is permissive by design: pack-specific config (check_path,
 * setup, fail_conditions, expected_*) is allowed alongside the standard
 * fields. Validators MUST NOT reject unknown fields here.
 */
const AgentGradingSchema = z
  .object({
    type: AgentGradingTypeEnum,
    criteria: z.array(z.string()).optional(),
    subchecks: z.array(AgentSubcheckSchema).optional(),
    expected_files: z.array(z.string()).optional(),
    expected_commands: z.array(z.string()).optional(),
    check_path: z.string().optional(),
    setup: z.string().optional(),
    fail_conditions: z.array(z.string()).optional(),
    max_score: z.number().nonnegative(),
  })
  .passthrough();

const MockSchema = z
  .object({
    prompt: z.string().optional(),
    expectedOutput: z.string(),
    fuzzyMatches: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Standard task fields. Pack-specific fields beyond these are allowed (the
 * agent packs carry e.g. `experimental` and may add more) and pass
 * through validation untouched.
 */
const TaskBaseSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().optional(),
    category: z.string().optional(),
    difficulty: TaskDifficultyEnum.optional(),
    prompt: z.string().min(1),
    system: z.string().optional(),
    tags: z.array(z.string()).optional(),
    mock: MockSchema.optional(),
    experimental: z.boolean().optional(),
  })
  .passthrough();

const ToolFreeTaskSchema = TaskBaseSchema.extend({
  grading: ToolFreeGradingSchema,
});

const AgentTaskSchema = TaskBaseSchema.extend({
  grading: AgentGradingSchema,
});

const PackHeaderSchema = z.object({
  schemaVersion: z.literal("1"),
  pack: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/),
  family: TaskFamilyEnum,
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const ToolFreePackSchema = PackHeaderSchema.extend({
  family: z.literal("tool-free"),
  tasks: z.array(ToolFreeTaskSchema).min(1),
});

const AgentPackSchema = PackHeaderSchema.extend({
  family: z.literal("agent"),
  tasks: z.array(AgentTaskSchema).min(1),
});

export const BenchmarkPackSchema = z.discriminatedUnion("family", [
  ToolFreePackSchema,
  AgentPackSchema,
]);

export type BenchmarkPack = z.infer<typeof BenchmarkPackSchema>;
export type ToolFreePack = z.infer<typeof ToolFreePackSchema>;
export type AgentPack = z.infer<typeof AgentPackSchema>;
export type ToolFreeTask = z.infer<typeof ToolFreeTaskSchema>;
export type AgentTask = z.infer<typeof AgentTaskSchema>;

/**
 * Loose shape used by the legacy benchmark-kit pack format (no `family`,
 * no `schemaVersion`). Exposed only so `parseBenchmarkPack` can normalize
 * older packs into the v1 union.
 */
const LegacyToolFreePackSchema = z.object({
  pack: z.string(),
  version: z.string(),
  description: z.string().optional(),
  tasks: z.array(ToolFreeTaskSchema).min(1),
});

/**
 * Parse a raw object into a typed `BenchmarkPack`. Accepts both the v1
 * shape and the legacy benchmark-kit shape (auto-promoted to
 * `family: "tool-free"`, `schemaVersion: "1"`). Throws a `ZodError`-derived
 * `Error` with a flattened message on validation failure.
 */
export function parseBenchmarkPack(raw: unknown): BenchmarkPack {
  if (raw && typeof raw === "object" && "family" in (raw as Record<string, unknown>)) {
    const parsed = BenchmarkPackSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`invalid benchmark pack: ${formatZodIssues(parsed.error)}`);
    }
    return parsed.data;
  }
  // Legacy shape: promote to tool-free v1.
  const legacy = LegacyToolFreePackSchema.safeParse(raw);
  if (!legacy.success) {
    throw new Error(`invalid benchmark pack: ${formatZodIssues(legacy.error)}`);
  }
  return {
    schemaVersion: "1",
    pack: legacy.data.pack,
    version: legacy.data.version,
    family: "tool-free",
    description: legacy.data.description,
    tasks: legacy.data.tasks,
  } satisfies BenchmarkPack;
}

function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`)
    .join("; ");
}
