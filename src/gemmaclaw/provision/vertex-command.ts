import fs from "node:fs";
import path from "node:path";
import { applySetupAgentConfig, applyAgentNameAndBootstrap } from "../../commands/setup-gemma.js";
import { mutateConfigFile } from "../../config/config.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { resolveStateDir } from "../../config/paths.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  resolveGemmaclawEnhancementIds,
  type GemmaclawEnhancementId,
} from "../gemmaclaw_instructions.js";
import type { OnboardingBootstrap, OnboardingThinking } from "./onboarding-wizard.js";
import { buildVertexConfig, interactiveVertexSetup } from "./vertex-setup.js";

type VertexSetupCommandOptions = {
  agentName?: string;
  noContainer?: boolean;
  thinking?: string;
  bootstrap?: string;
  nonInteractive?: boolean;
  acceptRisk?: boolean;
  dryRun?: boolean;
  enhancements?: string | readonly GemmaclawEnhancementId[];
};

type VertexSetupProviderOptions = {
  project?: string;
  region?: string;
  model?: string;
  apiFormat?: "native" | "openai";
  dedicatedUrl?: string;
};

function normalizeThinking(value: string | undefined): OnboardingThinking {
  return value === "off" || value === "low" || value === "medium" || value === "high"
    ? value
    : "medium";
}

function normalizeBootstrap(value: string | undefined): OnboardingBootstrap {
  return value === "general" || value === "coding" || value === "minimal" ? value : "general";
}

async function writeVertexAuthProfile(agentName: string, accessToken: string): Promise<void> {
  const stateDir = resolveStateDir(process.env);
  const authPath = path.join(
    stateDir,
    "agents",
    normalizeAgentId(agentName),
    "agent",
    "auth-profiles.json",
  );
  let auth: Record<string, unknown> = { version: 1, profiles: {} };
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  } catch {
    /* first time */
  }
  const profiles = (auth.profiles ?? {}) as Record<string, unknown>;
  profiles["google-vertex:gcloud"] = {
    type: "token",
    provider: "google-vertex",
    token: accessToken,
  };
  auth.profiles = profiles;
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
}

export async function runVertexSetupCommand(
  opts: VertexSetupCommandOptions,
  vertex: VertexSetupProviderOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const agentName = opts.agentName?.trim() || "main";
  const choices = {
    agentName,
    useContainer: opts.noContainer !== true,
    backend: "vertex" as const,
    model: vertex.model || "gemma-3-27b-it",
    thinkingLevel: normalizeThinking(opts.thinking),
    bootstrap: normalizeBootstrap(opts.bootstrap),
    enhancements: resolveGemmaclawEnhancementIds(opts.enhancements),
  };

  if (opts.dryRun) {
    runtime.log("[dry-run] Skipping gcloud auth probe and Vertex config write.");
    return;
  }

  const result = await interactiveVertexSetup({
    ...vertex,
    nonInteractive: Boolean(opts.nonInteractive),
  });
  if (!result.ok || !result.config) {
    runtime.error(`Vertex AI setup failed: ${result.error}`);
    runtime.exit(1);
    return;
  }

  const vertexConfigPatch = buildVertexConfig(result.config);
  await mutateConfigFile({
    mutate: (draft) => {
      Object.assign(draft, applyMergePatch(draft, vertexConfigPatch));
      applySetupAgentConfig(draft, { ...choices, model: result.config?.model ?? choices.model });
    },
  });
  runtime.log("Config updated with Vertex AI provider.");

  await applyAgentNameAndBootstrap({ ...choices, model: result.config.model });

  if (result.config.accessToken && !result.config.useAutomatedCredentials) {
    await writeVertexAuthProfile(agentName, result.config.accessToken);
    runtime.log("Auth profile saved (google-vertex:gcloud).");
    runtime.log(
      "Note: Access tokens expire in about 1 hour. Run 'gemmaclaw setup --vertex' again to refresh, or set GOOGLE_APPLICATION_CREDENTIALS for auto-refresh.",
    );
  }

  runtime.log(
    `Vertex AI ready: ${result.config.model} on ${result.config.project} (${result.config.region})`,
  );
  runtime.log("Test it: gemmaclaw agent --local --message 'Hello'");
}
