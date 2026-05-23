import { COMMITMENT_FOLLOWTHROUGH_LOOP_PROMPT } from "./enhancements/commitment_followthrough_loop.js";
import { EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_PROMPT } from "./enhancements/external_delivery_receipt_verification.js";

export const EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID =
  "external_delivery_receipt_verification" as const;
export const COMMITMENT_FOLLOWTHROUGH_LOOP_ID = "commitment_followthrough_loop" as const;

export const GEMMACLAW_INSTRUCTIONS_CONTEXT_PATH = "gemmaclaw_instructions.ts";
export const GEMMACLAW_ENHANCEMENT_SELECTION_FILENAME = ".gemmaclaw-enhancements.json";

export type GemmaclawEnhancementId =
  | typeof EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID
  | typeof COMMITMENT_FOLLOWTHROUGH_LOOP_ID;

export interface GemmaclawEnhancement {
  id: GemmaclawEnhancementId;
  title: string;
  category: "prompt" | "harness" | "setup";
  defaultEnabled: boolean;
  description: string;
  instructionMarkdown: string;
  docsPath: string;
  benchmarkIds: string[];
}

export const GEMMACLAW_ENHANCEMENTS: readonly GemmaclawEnhancement[] = [
  {
    id: EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID,
    title: "External delivery receipt verification",
    category: "prompt",
    defaultEnabled: true,
    description:
      "Require agents to verify real delivery receipts or logs before claiming that an external message, media file, email, calendar mutation, or scheduled send completed.",
    docsPath: "docs/gemmaclaw/enhancements.md",
    benchmarkIds: ["scheduled_media_delivery_verification"],
    instructionMarkdown: EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_PROMPT,
  },
  {
    id: COMMITMENT_FOLLOWTHROUGH_LOOP_ID,
    title: "Commitment follow-through loop",
    category: "prompt",
    defaultEnabled: true,
    description:
      "Require agents to finish promised work inline or create and verify a durable Gemmaclaw-native follow-up before saying they are working on it.",
    docsPath: "docs/gemmaclaw/enhancements.md",
    benchmarkIds: ["commitment_followthrough_verification"],
    instructionMarkdown: COMMITMENT_FOLLOWTHROUGH_LOOP_PROMPT,
  },
];

const ENHANCEMENT_BY_ID = new Map<GemmaclawEnhancementId, GemmaclawEnhancement>(
  GEMMACLAW_ENHANCEMENTS.map((enhancement) => [enhancement.id, enhancement]),
);

export function listGemmaclawEnhancements(): GemmaclawEnhancement[] {
  return [...GEMMACLAW_ENHANCEMENTS];
}

export function getDefaultGemmaclawEnhancementIds(): GemmaclawEnhancementId[] {
  return GEMMACLAW_ENHANCEMENTS.filter((enhancement) => enhancement.defaultEnabled).map(
    (enhancement) => enhancement.id,
  );
}

export function isGemmaclawEnhancementId(value: string): value is GemmaclawEnhancementId {
  return ENHANCEMENT_BY_ID.has(value as GemmaclawEnhancementId);
}

export function resolveGemmaclawEnhancementIds(
  selection: string | readonly GemmaclawEnhancementId[] | undefined,
): GemmaclawEnhancementId[] {
  if (typeof selection !== "string") {
    return selection ? [...selection] : getDefaultGemmaclawEnhancementIds();
  }

  const normalized = selection.trim();
  if (normalized === "" || normalized === "default") {
    return getDefaultGemmaclawEnhancementIds();
  }
  if (normalized === "none" || normalized === "off" || normalized === "false") {
    return [];
  }
  if (normalized === "all") {
    return GEMMACLAW_ENHANCEMENTS.map((enhancement) => enhancement.id);
  }

  const rawIds = normalized
    .split(",")
    .map((part: string) => part.trim())
    .filter(Boolean);
  const ids: GemmaclawEnhancementId[] = [];
  for (const id of rawIds) {
    if (!isGemmaclawEnhancementId(id)) {
      throw new Error(
        `Unknown Gemmaclaw enhancement "${id}". Use one of: ${GEMMACLAW_ENHANCEMENTS.map(
          (enhancement) => enhancement.id,
        ).join(", ")}, default, all, or none.`,
      );
    }
    ids.push(id);
  }
  return ids;
}

export function renderGemmaclawInstructions(
  ids: readonly GemmaclawEnhancementId[] = getDefaultGemmaclawEnhancementIds(),
): string {
  const sections = ids.map((id) => {
    const enhancement = ENHANCEMENT_BY_ID.get(id);
    if (!enhancement) {
      throw new Error(`Unknown Gemmaclaw enhancement "${id}".`);
    }
    return enhancement.instructionMarkdown;
  });
  const lines = [
    "## Gemmaclaw Instructions",
    "",
    "These code-owned Gemmaclaw instructions are injected by the runtime beyond user workspace AGENTS.md. They are not copied into AGENTS.md.",
    "",
    "### Gemmaclaw self-awareness",
    "",
    "- You are running as a Gemmaclaw agent, a Gemma-focused OpenClaw distribution.",
    "- Gemmaclaw repository: https://github.com/gemmaclaw/gemmaclaw",
    "- Gemmaclaw documentation: https://gemmaclaw.github.io/gemmaclaw/",
    "- If you need to understand your own inner workings, setup behavior, benchmark harness, tools, prompts, or runtime configuration, clone the repository to `~/gemmaclaw` if it is missing, otherwise update it to the latest default branch before inspecting the code directly.",
    "- Do not guess how Gemmaclaw works when the repo or docs can answer it. Read the code, then act.",
    "",
  ];
  if (sections.length > 0) {
    lines.push(...sections);
  }
  return lines.join("\n");
}

export function parseGemmaclawEnhancementSelection(raw: string): GemmaclawEnhancementId[] {
  const parsed = JSON.parse(raw) as { enhancements?: unknown };
  const value = parsed.enhancements;
  if (!Array.isArray(value)) {
    return getDefaultGemmaclawEnhancementIds();
  }
  const rawIds = value.map((item) => {
    if (typeof item !== "string") {
      throw new Error("Gemmaclaw enhancement selection must contain string ids only.");
    }
    return item;
  });
  if (rawIds.length === 0) {
    return [];
  }
  return resolveGemmaclawEnhancementIds(rawIds.join(","));
}
