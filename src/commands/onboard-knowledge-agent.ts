import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronStorePath, loadCronStore, saveCronStore } from "../cron/store.js";
import type { CronJob, CronStoreFile } from "../cron/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const DEFAULT_KNOWLEDGE_AGENT_CRON_ID = "knowledge-maintenance";
export const DEFAULT_KNOWLEDGE_AGENT_CRON_NAME = "Knowledge maintenance";

export const DEFAULT_KNOWLEDGE_AGENT_PROMPT = [
  "Run workspace knowledge maintenance.",
  "",
  "Use the workspace as the source of truth. Read AGENTS.md first, then inspect recent files under memory/ and durable files under knowledge/.",
  "",
  "Maintain continuity without leaking private data:",
  "- Promote durable facts, decisions, procedures, project context, and lessons from recent daily memory into appropriate knowledge/ files.",
  "- Keep MEMORY.md concise when it exists and only update it with stable, high-value long-term context.",
  "- Keep daily memory as a chronological log. Do not erase raw history unless the user explicitly asked you to remove something.",
  "- Never write secrets, tokens, private keys, or credentials into memory or knowledge files.",
  "- Prefer updating an existing relevant knowledge file over creating duplicates. Create knowledge/ only when it is missing.",
  "- If a lesson should guide future behavior, update AGENTS.md or the relevant SKILL.md only when that is the right durable home.",
  "",
  "Write a short maintenance note in memory/YYYY-MM-DD.md summarizing what changed. If there is nothing useful to promote, write no file changes and reply HEARTBEAT_OK.",
].join("\n");

export function createDefaultKnowledgeAgentCronJob(nowMs = Date.now()): CronJob {
  return {
    id: DEFAULT_KNOWLEDGE_AGENT_CRON_ID,
    name: DEFAULT_KNOWLEDGE_AGENT_CRON_NAME,
    description: "Daily generic workspace knowledge and memory maintenance.",
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "cron", expr: "0 3 * * *", staggerMs: 0 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: DEFAULT_KNOWLEDGE_AGENT_PROMPT,
      thinking: "medium",
      timeoutSeconds: 3600,
      lightContext: false,
    },
    delivery: { mode: "none" },
    failureAlert: false,
    state: {},
  };
}

function hasKnowledgeAgentJob(store: CronStoreFile): boolean {
  return store.jobs.some(
    (job) =>
      job.id === DEFAULT_KNOWLEDGE_AGENT_CRON_ID || job.name === DEFAULT_KNOWLEDGE_AGENT_CRON_NAME,
  );
}

export async function ensureDefaultKnowledgeAgentCron(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter?: WizardPrompter;
  nowMs?: number;
}): Promise<void> {
  if (params.cfg.cron?.enabled === false) {
    params.runtime.log?.("Skipping default knowledge maintenance cron because cron is disabled.");
    return;
  }

  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const store = await loadCronStore(storePath);
  if (hasKnowledgeAgentJob(store)) {
    params.runtime.log?.("Default knowledge maintenance cron already configured.");
    return;
  }

  store.jobs.push(createDefaultKnowledgeAgentCronJob(params.nowMs));
  await saveCronStore(storePath, store);
  await params.prompter?.note(
    "Scheduled daily knowledge maintenance at 3:00 AM. It runs as an isolated agent job and maintains memory/ plus knowledge/ files.",
    "Knowledge maintenance",
  );
}

export async function ensureDefaultGemmaclawAgentCronJobs(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  agentId?: string;
  nowMs?: number;
}): Promise<{ added: number; updated: number }> {
  if (params.cfg.cron?.enabled === false) {
    return { added: 0, updated: 0 };
  }

  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const store = await loadCronStore(storePath);
  let added = 0;

  if (!hasKnowledgeAgentJob(store)) {
    store.jobs.push(createDefaultKnowledgeAgentCronJob(params.nowMs));
    added++;
  }

  if (added > 0) {
    await saveCronStore(storePath, store);
  }

  return { added, updated: 0 };
}
