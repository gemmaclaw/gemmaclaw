/**
 * merged-setup.gemmaclaw.ts
 *
 * Orchestrates the full merged Gemmaclaw + OpenClaw setup flow. Walks a new
 * user through:
 *   Steps 1-9:  Gemmaclaw-specific choices (agent name, container, backend,
 *               model, thinking level, bootstrap profile, enhancements)
 *   Step 10:    OpenClaw gateway configuration (port, bind, auth mode, Tailscale)
 *   Step 11:    OpenClaw channel setup (Discord, Telegram, WhatsApp, etc.)
 *   Step 12:    Config write + backend provisioning + smoke test
 *
 * Backwards-compatible paths:
 *   gemmaclaw setup --wizard        → pure OpenClaw wizard (no Gemmaclaw steps)
 *   gemmaclaw setup --workspace-only → pure workspace init
 *   All existing --non-interactive / --dry-run / --setup-mode flags still work
 */

import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { GatewayWizardSettings } from "../../wizard/setup.types.js";
import type {
  OnboardingBootstrap,
  OnboardingChoices,
  OnboardingDefaults,
  OnboardingThinking,
  WizardIO,
} from "./onboarding-wizard.js";
import {
  askAgentName,
  askBackend,
  askBootstrap,
  askContainer,
  askEnhancements,
  askModel,
  askThinking,
  buildNonInteractiveChoices,
} from "./onboarding-wizard.js";

export type ExistingConfigAction = "keep" | "update" | "reset";

export interface MergedSetupWizardResult {
  choices: OnboardingChoices;
  existingConfigAction: ExistingConfigAction | null;
  /** OpenClaw gateway settings, populated after Step 10 if gateway wizard ran. */
  gatewaySettings?: GatewayWizardSettings;
}

/**
 * Ask the user what to do with an existing config file.
 * Returns null if there is no existing config.
 */
async function askExistingConfigAction(
  io: WizardIO,
  existingConfig: OpenClawConfig | null,
): Promise<ExistingConfigAction | null> {
  if (!existingConfig) {
    return null;
  }

  io.log("Existing Gemmaclaw configuration detected.");
  io.log("");
  io.log("  1) Use existing values  Skip setup prompts and keep current config.");
  io.log("  2) Update values        Re-run wizard with current values as defaults.");
  io.log("  3) Reset                Wipe Gemmaclaw config and start fresh.");
  io.log("");

  for (;;) {
    const answer = await io.prompt("Choose [1/2/3, default=1]: ");
    const choice = answer.trim() || "1";
    if (choice === "1" || choice.toLowerCase() === "keep") {
      io.log("");
      return "keep";
    }
    if (choice === "2" || choice.toLowerCase() === "update") {
      io.log("");
      return "update";
    }
    if (choice === "3" || choice.toLowerCase() === "reset") {
      io.log("");
      return "reset";
    }
    io.error(`Invalid choice "${choice}". Enter 1, 2, or 3.`);
  }
}

/**
 * Load the existing Gemmaclaw onboarding manifest (if any) to use as defaults
 * when the user chooses "update". Returns null if no manifest exists.
 */
async function loadExistingOnboardingDefaults(): Promise<OnboardingDefaults | null> {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { resolveStateDir } = await import("../../config/paths.js");
    const stateDir = resolveStateDir(process.env);
    const manifestPath = path.default.join(stateDir, "agents", "main", "agent", "onboarding.json");
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw) as {
      agentName?: string;
      backend?: string;
      model?: string;
      thinkingLevel?: string;
      bootstrap?: string;
      useContainer?: boolean;
      enhancements?: string[];
    };
    return {
      agentName: manifest.agentName,
      backend: manifest.backend as OnboardingDefaults["backend"],
      model: manifest.model,
      thinkingLevel: manifest.thinkingLevel as OnboardingThinking | undefined,
      bootstrap: manifest.bootstrap as OnboardingBootstrap | undefined,
      useContainer: manifest.useContainer,
    };
  } catch {
    return null;
  }
}

/**
 * Check whether a config file exists at the standard location.
 */
async function loadExistingConfig(): Promise<OpenClawConfig | null> {
  try {
    const { readConfigFileSnapshot } = await import("../../config/config.js");
    const snapshot = await readConfigFileSnapshot();
    if (snapshot.exists && snapshot.valid) {
      return snapshot.config;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run the Gemmaclaw-specific steps (1-9) of the merged wizard and return
 * the user's choices. Steps 10-11 (gateway + channels) are handled separately
 * by the caller since they use the OpenClaw clack-based prompter.
 *
 * @param io     WizardIO for readline-based prompts
 * @param defaults Pre-set values from CLI flags or existing config
 * @param opts   Additional options (skipGemmaSteps, includeExtended, existingConfig)
 */
export async function runGemmaclawSetupSteps(
  io: WizardIO,
  defaults: OnboardingDefaults = {},
  opts: {
    skipExistingConfigCheck?: boolean;
    includeExtended?: boolean;
    existingConfig?: OpenClawConfig | null;
  } = {},
): Promise<{ choices: OnboardingChoices; existingConfigAction: ExistingConfigAction | null }> {
  // Step 1: Gemmaclaw header
  io.log("");
  io.log("Welcome to Gemmaclaw setup.");
  io.log("We'll configure your AI agent in a few quick steps, then set up the");
  io.log("gateway and channels so everything is ready to use.");
  io.log("Press Enter at any prompt to keep the [bracketed] default.");
  io.log("");

  // Step 2: Existing config check
  let existingConfigAction: ExistingConfigAction | null = null;
  let effectiveDefaults = { ...defaults };

  if (!opts.skipExistingConfigCheck) {
    const existingConfig =
      opts.existingConfig !== undefined ? opts.existingConfig : await loadExistingConfig();
    existingConfigAction = await askExistingConfigAction(io, existingConfig);

    if (existingConfigAction === "keep") {
      // Skip all Gemmaclaw prompts; return with whatever defaults we have.
      const choices = buildNonInteractiveChoices({
        agentName: defaults.agentName ?? "main",
        backend: defaults.backend ?? "local",
        model: defaults.model,
        thinkingLevel: defaults.thinkingLevel,
        bootstrap: defaults.bootstrap,
        useContainer: defaults.useContainer,
        enhancements: defaults.enhancements,
      });
      return { choices, existingConfigAction };
    }

    if (existingConfigAction === "update") {
      // Pre-populate defaults from the existing onboarding manifest.
      const existingDefaults = await loadExistingOnboardingDefaults();
      if (existingDefaults) {
        effectiveDefaults = { ...existingDefaults, ...defaults };
      }
    }
    // "reset": proceed fresh, ignore existing config.
  }

  // Steps 3-9: Gemmaclaw-specific prompts.
  const agentName = await askAgentName(io, effectiveDefaults.agentName);
  const useContainer = await askContainer(io, effectiveDefaults.useContainer);
  const backend = await askBackend(io, effectiveDefaults.backend, opts.includeExtended ?? true);

  // Step 6: Model selection (skipped for "extended" — handled by OpenClaw model picker).
  const model = await askModel(io, backend, effectiveDefaults.model);

  // Steps 7-9: Thinking level, bootstrap profile, enhancements.
  const thinkingLevel = await askThinking(io, effectiveDefaults.thinkingLevel);
  const bootstrap = await askBootstrap(io, effectiveDefaults.bootstrap);
  const enhancements = await askEnhancements(io, effectiveDefaults.enhancements);

  const choices: OnboardingChoices = {
    agentName,
    useContainer,
    backend,
    model,
    thinkingLevel,
    bootstrap,
    enhancements,
  };

  return { choices, existingConfigAction };
}

/**
 * Run gateway config (Step 10) using the OpenClaw clack prompter.
 * Returns the updated config and gateway settings, or null if skipped.
 */
export async function runGatewayConfigStep(
  runtime: RuntimeEnv,
  currentConfig: OpenClawConfig,
  opts: { dryRun?: boolean; nonInteractive?: boolean } = {},
): Promise<{ nextConfig: OpenClawConfig; settings: GatewayWizardSettings } | null> {
  if (opts.dryRun || opts.nonInteractive) {
    if (opts.dryRun) {
      runtime.log("[dry-run] Skipping gateway configuration step.");
    }
    return null;
  }

  try {
    const { configureGatewayForSetup } = await import("../../wizard/setup.gateway-config.js");
    const { createClackPrompter } = await import("../../wizard/clack-prompter.js");
    const { DEFAULT_GATEWAY_PORT } = await import("../../config/paths.js");
    const { readConfigFileSnapshot } = await import("../../config/config.js");

    runtime.log("");
    runtime.log("Step 10: Gateway configuration");
    runtime.log("Configure how the Gemmaclaw gateway listens and authenticates.");
    runtime.log("");

    const snapshot = await readConfigFileSnapshot();
    const baseConfig: OpenClawConfig = snapshot.exists && snapshot.valid ? snapshot.config : {};
    const prompter = createClackPrompter();

    await prompter.intro("Gateway setup");

    const result = await configureGatewayForSetup({
      flow: "quickstart",
      baseConfig,
      nextConfig: { ...currentConfig },
      localPort: DEFAULT_GATEWAY_PORT,
      quickstartGateway: {
        hasExisting: false,
        port: DEFAULT_GATEWAY_PORT,
        bind: "loopback",
        tailscaleMode: "off",
        authMode: "token",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime,
    });

    await prompter.outro("Gateway configured.");
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.error(`Gateway configuration step failed: ${message}`);
    runtime.error("You can configure the gateway later with: gemmaclaw configure gateway");
    return null;
  }
}

/**
 * Run channel setup (Step 11) using the OpenClaw clack prompter.
 * Returns the updated config, or null if skipped.
 */
export async function runChannelSetupStep(
  runtime: RuntimeEnv,
  currentConfig: OpenClawConfig,
  opts: { dryRun?: boolean; nonInteractive?: boolean } = {},
): Promise<OpenClawConfig | null> {
  if (opts.dryRun || opts.nonInteractive) {
    if (opts.dryRun) {
      runtime.log("[dry-run] Skipping channel setup step.");
    }
    // Non-interactive: no channel setup (channels can be added later via --wizard).
    return null;
  }

  try {
    const { setupChannels } = await import("../../commands/onboard-channels.js");
    const { createClackPrompter } = await import("../../wizard/clack-prompter.js");

    runtime.log("");
    runtime.log("Step 11: Channel setup");
    runtime.log("Connect Gemmaclaw to Discord, Telegram, WhatsApp, or other channels.");
    runtime.log("(Press Enter to skip any channel you do not want to configure now.)");
    runtime.log("");

    const prompter = createClackPrompter();
    await prompter.intro("Channel setup");
    const updatedConfig = await setupChannels(currentConfig, runtime, prompter);
    await prompter.outro("Channel setup complete.");
    return updatedConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.error(`Channel setup step failed: ${message}`);
    runtime.error("You can add channels later with: gemmaclaw setup --wizard");
    return null;
  }
}

/**
 * Run the OpenClaw auth-choice flow for the "extended" or "gemini" backend
 * selection. Returns the auth choice string and an updated config.
 *
 * For "gemini": pre-seeds Google Gemini API key flow.
 * For "extended": presents the full OpenClaw provider picker.
 */
export async function runOpenClawAuthFlow(
  runtime: RuntimeEnv,
  currentConfig: OpenClawConfig,
  backend: "gemini" | "extended",
  opts: { dryRun?: boolean; nonInteractive?: boolean } = {},
): Promise<{ authChoice: string; model: string; nextConfig: OpenClawConfig } | null> {
  if (opts.dryRun) {
    runtime.log(`[dry-run] Skipping OpenClaw auth flow for backend="${backend}".`);
    const model = backend === "gemini" ? "google/gemini-2.5-flash" : "";
    return {
      authChoice: backend === "gemini" ? "google/gemini-api-key" : "skip",
      model,
      nextConfig: currentConfig,
    };
  }

  if (opts.nonInteractive) {
    // Non-interactive: return a placeholder; caller handles non-interactive auth.
    const model = backend === "gemini" ? "google/gemini-2.5-flash" : "";
    return {
      authChoice: backend === "gemini" ? "google/gemini-api-key" : "skip",
      model,
      nextConfig: currentConfig,
    };
  }

  try {
    const { createClackPrompter } = await import("../../wizard/clack-prompter.js");
    const { promptAuthChoiceGrouped } = await import("../../commands/auth-choice-prompt.js");
    const { promptDefaultModel } = await import("../../flows/model-picker.js");
    const { ensureAuthProfileStore } = await import("../../agents/auth-profiles.runtime.js");

    const prompter = createClackPrompter();
    const store = ensureAuthProfileStore();

    await prompter.intro(backend === "gemini" ? "Gemini API authentication" : "Provider selection");

    const authChoice = await promptAuthChoiceGrouped({
      prompter,
      store,
      includeSkip: false,
      config: currentConfig,
      env: process.env,
    });

    // Apply auth choice to config.
    const { applyAuthChoice } = await import("../../commands/auth-choice.apply.js");
    const applyResult = await applyAuthChoice({
      authChoice,
      config: currentConfig,
      prompter,
      runtime,
      env: process.env,
      setDefaultModel: false,
    });

    const nextConfig = applyResult.config ?? currentConfig;

    // Derive preferred provider from the auth choice string (e.g. "google/..." → "google").
    const preferredProvider = typeof authChoice === "string" ? authChoice.split("/")[0] : undefined;

    // Pick the default model for the chosen provider.
    const modelResult = await promptDefaultModel({
      config: nextConfig,
      prompter,
      allowKeep: false,
      preferredProvider,
      env: process.env,
      runtime,
    });

    await prompter.outro("Provider configured.");
    return {
      authChoice,
      model: modelResult.model ?? "",
      nextConfig: modelResult.config ?? nextConfig,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.error(`Provider auth flow failed: ${message}`);
    runtime.error("You can configure the provider later with: gemmaclaw setup --wizard");
    return null;
  }
}
