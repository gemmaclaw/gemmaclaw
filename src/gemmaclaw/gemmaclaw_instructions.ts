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
    instructionMarkdown: [
      "### External delivery receipt verification",
      "",
      "- Enhancement id: `external_delivery_receipt_verification`",
      "- Guarded by benchmark: `scheduled_media_delivery_verification`",
      "- Before claiming that you sent an external message, media file, email, calendar change, webhook, or scheduled delivery, verify the result from the real send receipt, provider response, durable log, or mock receipt used by the test harness.",
      "- Creating a local artifact, writing a script, scheduling a command, or seeing a tool intent is not delivery proof.",
      "- If the receipt is missing, ambiguous, or failed, say the delivery is unverified, keep investigating, and do not tell the user it was sent.",
      "- For scheduled jobs, verify the active scheduler location and the next run or trigger proof, not just a copied config file in the workspace.",
    ].join("\n"),
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
    instructionMarkdown: [
      "### Commitment follow-through loop",
      "",
      "- Enhancement id: `commitment_followthrough_loop`",
      "- Guarded by benchmark: `commitment_followthrough_verification`",
      "- Do not say you are `on it`, `will fix it`, `will get it sorted`, `will follow up`, or equivalent unless you either finish the work inline in the current turn and verify the result before replying, or create and verify a durable Gemmaclaw-native follow-up that can resume without the user repeating the request.",
      "- Gemmaclaw-native follow-up means a local scheduler entry, local task/todo/work record, or Gemmaclaw subagent/session mechanism available in this runtime. Do not assume external ACP workers, private operator queues, or installation-specific infrastructure exists unless this installation explicitly provides it.",
      "- A durable follow-up record must include the title, reason, exact next action, owner/runtime, wake time or subagent/session id, verification command or artifact, and creation timestamp.",
      "- After making a commitment, reply only after the work is complete or after the durable follow-up has been read back and verified. The reply must say what was completed, or where and when the local follow-up will resume.",
      "- If scheduler, tool, filesystem, or subagent access fails, say the work is blocked with the exact evidence and keep the claim truthful. Do not imply background work is underway when no verified follow-up exists.",
      "- For scheduler repair, inspect active scheduler surfaces before saying a job exists or is fixed: Gemmaclaw/OpenClaw cron config, host crontab or systemd timers when accessible, and the relevant execution logs.",
    ].join("\n"),
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
