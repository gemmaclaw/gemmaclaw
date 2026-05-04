import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  OnboardingBackend,
  OnboardingBootstrap,
  OnboardingChoices,
  OnboardingThinking,
} from "../gemmaclaw/provision/onboarding-wizard.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { applyAgentConfig, listAgentEntries } from "./agents.config.js";

export type SetupGemmaCommandOpts = {
  advanced?: boolean;
  noContainer?: boolean;
  /**
   * When true, skip prompts entirely. Combined with the explicit option flags
   * below this becomes the CI / scripted path. The rest of the flow still
   * runs (config write, summary print, optional dry-run skip of provisioning).
   */
  nonInteractive?: boolean;
  /**
   * Skip every operation that talks to the network or spawns a long-running
   * process: model downloads, gateway start, smoke tests. Still writes config
   * and prints the summary so e2e tests can validate the full UX without
   * standing up Ollama / llama.cpp inside the test container.
   */
  dryRun?: boolean;

  /** Pre-set onboarding choices supplied via flags. */
  agentName?: string;
  thinking?: OnboardingThinking;
  bootstrap?: OnboardingBootstrap;
  setupMode?: OnboardingBackend;
  model?: string;
};

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_POLL_MAX_ATTEMPTS = 60;

async function probeGatewayHealth(port: number): Promise<boolean> {
  try {
    const url = `http://127.0.0.1:${String(port)}/healthz`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return false;
    }
    const body = await res.text();
    return body.includes("ok");
  } catch {
    return false;
  }
}

async function waitForGatewayReady(port: number): Promise<boolean> {
  for (let i = 0; i < HEALTH_POLL_MAX_ATTEMPTS; i++) {
    if (await probeGatewayHealth(port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

function killProcessesOnPort(port: number): void {
  try {
    const pids = execSync(`lsof -ti :${port}`, {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: "pipe",
    }).trim();
    if (pids) {
      for (const pid of pids.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {
          // Already gone.
        }
      }
      // Give processes a moment to exit.
      execSync("sleep 1", { stdio: "pipe" });
      // Force kill any that survived.
      for (const pid of pids.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  } catch {
    // No processes on port, or lsof not available.
  }
}

function resolveCliEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../dist/entry.js"),
    path.resolve(here, "../gemmaclaw.mjs"),
    path.resolve(here, "../openclaw.mjs"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
  return process.argv[1] ?? candidates[0];
}

function spawnGatewayDetached(port: number): ChildProcess {
  const entryPath = resolveCliEntryPath();
  const child = spawn(process.execPath, [entryPath, "gateway", "run", "--port", String(port)], {
    stdio: "ignore",
    detached: true,
    env: process.env,
  });
  child.unref();
  return child;
}

function buildChatUrl(port: number, choices: OnboardingChoices): string {
  const agentId = normalizeAgentId(choices.agentName);
  return `http://127.0.0.1:${String(port)}/?agent=${encodeURIComponent(agentId)}`;
}

async function startGatewayAndGetChatUrl(
  runtime: RuntimeEnv,
  choices: OnboardingChoices,
  port: number,
): Promise<string | undefined> {
  const { ensureControlUiAssetsBuilt } = await import("../infra/control-ui-assets.js");
  runtime.log("");
  runtime.log("Checking Control UI assets...");
  const uiBuild = await ensureControlUiAssetsBuilt(runtime);
  if (uiBuild.ok) {
    runtime.log(uiBuild.built ? "Control UI built." : "Control UI assets ready.");
  } else {
    runtime.error(`Control UI: ${uiBuild.message}`);
    runtime.error("The gateway will attempt to build them on first start.");
  }

  killProcessesOnPort(port);

  runtime.log("");
  runtime.log(`Starting gateway on port ${String(port)}...`);
  spawnGatewayDetached(port);

  const ready = await waitForGatewayReady(port);
  if (!ready) {
    runtime.error("Gateway did not become ready within 30 seconds.");
    runtime.error("You can start it manually later with: gemmaclaw chat");
    return undefined;
  }
  runtime.log("Gateway is ready.");
  return buildChatUrl(port, choices);
}

function isDockerInstalled(): boolean {
  try {
    execSync("docker --version", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function isDockerRunning(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureDockerReadyOrFallback(
  runtime: RuntimeEnv,
  prompt: ((q: string) => Promise<string>) | null,
): Promise<boolean> {
  if (!isDockerInstalled()) {
    runtime.log("");
    runtime.log("Docker is not installed, falling back to direct/host execution.");
    runtime.log("Install Docker later if you want sandboxing:");
    runtime.log("  macOS:   brew install --cask docker   (then open Docker.app)");
    runtime.log("  Linux:   curl -fsSL https://get.docker.com | sh");
    runtime.log("  Windows: https://docs.docker.com/desktop/install/windows-install/");
    return false;
  }

  if (!isDockerRunning()) {
    runtime.log("");
    runtime.log("Docker is installed but the daemon is not running. Start it:");
    runtime.log("  macOS:   Open Docker Desktop (or: open -a Docker)");
    runtime.log("  Linux:   sudo systemctl start docker");
    if (!prompt) {
      runtime.log("Continuing without Docker sandbox.");
      return false;
    }
    const answer = await prompt(
      "Press Enter once Docker is running (or type 'skip' to run without it): ",
    );
    if (answer.trim().toLowerCase() === "skip") {
      return false;
    }
    if (!isDockerRunning()) {
      runtime.log("Docker daemon is still not running. Continuing without sandbox.");
      return false;
    }
  }

  return true;
}

/**
 * Map the onboarding wizard's friendly choices onto an Ollama-style model id
 * that the local provisioner can pull. "auto" defers to hardware detection.
 */
function resolveLocalOllamaModel(modelChoice: string, fallback?: string): string | undefined {
  if (!modelChoice || modelChoice === "auto") {
    return fallback;
  }
  return modelChoice;
}

function persistThinkingDefault(thinking: OnboardingThinking): "off" | "low" | "medium" | "high" {
  return thinking;
}

function applySandboxOffDefault(draft: OpenClawConfig): void {
  draft.agents ??= {};
  draft.agents.defaults ??= {};
  draft.agents.defaults.sandbox = {
    mode: "off",
    backend: "docker",
    scope: "session",
    workspaceAccess: "rw",
  };
}

function applyGemmaclawToolDefaults(draft: OpenClawConfig): void {
  draft.tools ??= {};
  draft.tools.exec ??= {};
  (draft.tools.exec as Record<string, unknown>).security = "full";
  (draft.tools.exec as Record<string, unknown>).ask = "off";

  const tools = draft.tools as Record<string, unknown>;
  const sandboxTools = (tools.sandbox ?? {}) as Record<string, unknown>;
  const sandboxToolPolicy = (sandboxTools.tools ?? {}) as Record<string, unknown>;
  sandboxToolPolicy.allow = [];
  sandboxToolPolicy.deny = [];
  sandboxTools.tools = sandboxToolPolicy;
  tools.sandbox = sandboxTools;
}

function applySetupAgentConfig(draft: OpenClawConfig, choices: OnboardingChoices): void {
  const existingEntries = listAgentEntries(draft);
  const agentId = normalizeAgentId(choices.agentName);
  const workspaceDir = resolveAgentWorkspaceDir(draft, agentId);
  const agentDir = resolveAgentDir(draft, agentId);
  const nextConfig = applyAgentConfig(draft, {
    agentId,
    name: choices.agentName.trim() || agentId,
    workspace: workspaceDir,
    agentDir,
  });

  draft.agents = nextConfig.agents;
  if (existingEntries.length === 0) {
    draft.agents = {
      ...draft.agents,
      list: (draft.agents?.list ?? []).filter((entry) => normalizeAgentId(entry?.id) === agentId),
    };
  }
}

export async function setupGemmaCommand(
  opts: SetupGemmaCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  // Lazy-load to keep CLI startup fast.
  const { detectHardware, detectSystemTools, formatHardwareInfo } =
    await import("../gemmaclaw/provision/hardware.js");
  const { selectQuickProfile, runAdvancedWizard, createStdioWizardIO, formatModelSize } =
    await import("../gemmaclaw/provision/setup-wizard.js");
  const { provision, verifyCompletion } = await import("../gemmaclaw/provision/provision.js");
  const { DEFAULT_GATEWAY_PORT } = await import("../config/paths.js");
  const {
    runOnboardingWizard,
    createStdioOnboardingIO,
    buildNonInteractiveChoices,
    formatChoicesSummary,
  } = await import("../gemmaclaw/provision/onboarding-wizard.js");

  // Check Node.js version.
  const nodeVersion = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (nodeVersion < 22) {
    runtime.error(`Node.js 22+ required (current: ${process.versions.node}).`);
    runtime.error("  nvm:     nvm install 22 && nvm use 22");
    runtime.error("  macOS:   brew install node@22");
    runtime.exit(1);
  }

  const dryRun = opts.dryRun ?? process.env.OPENCLAW_SETUP_DRY_RUN === "1";

  // Build onboarding choices either from CLI flags (non-interactive) or from
  // the interactive wizard. The wizard accepts presets so flags partially
  // skip individual prompts (e.g. --agent-name skips the name prompt).
  let choices: OnboardingChoices;
  if (opts.nonInteractive) {
    choices = buildNonInteractiveChoices({
      agentName: opts.agentName,
      useContainer: opts.noContainer === true ? false : undefined,
      backend: opts.setupMode,
      model: opts.model,
      thinkingLevel: opts.thinking,
      bootstrap: opts.bootstrap,
      apiKey: process.env.GEMINI_API_KEY?.trim(),
    });
  } else {
    const io = createStdioOnboardingIO();
    try {
      choices = await runOnboardingWizard(io, {
        agentName: opts.agentName,
        useContainer: opts.noContainer === true ? false : undefined,
        backend: opts.setupMode,
        model: opts.model,
        thinkingLevel: opts.thinking,
        bootstrap: opts.bootstrap,
      });
    } finally {
      io.close();
    }
  }

  const { isContainerEnvironment } = await import("../gateway/net.js");
  const runningInsideContainer = isContainerEnvironment();
  if (runningInsideContainer && choices.useContainer) {
    choices = { ...choices, useContainer: false };
  }

  // Echo the resolved choices so the user can see what setup is about to do.
  runtime.log("");
  for (const line of formatChoicesSummary(choices)) {
    runtime.log(line);
  }
  runtime.log("");

  // If the user picked container mode, verify Docker is actually available
  // and gracefully fall back to host execution otherwise.
  let useDocker = choices.useContainer;
  if (runningInsideContainer) {
    runtime.log("");
    runtime.log("Container environment detected; defaulting sandbox.mode=off.");
  }
  if (choices.useContainer && !dryRun) {
    const interactivePrompt = opts.nonInteractive
      ? null
      : async (q: string) => {
          const rl = (await import("node:readline/promises")).default.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          try {
            return await rl.question(q);
          } finally {
            rl.close();
          }
        };
    useDocker = await ensureDockerReadyOrFallback(runtime, interactivePrompt);
  }

  if (choices.backend === "gemini") {
    await setupGeminiBackend(runtime, choices, { dryRun });
    await applySharedAgentDefaults(choices, useDocker, runningInsideContainer);
    const chatUrl = dryRun
      ? undefined
      : await startGatewayAndGetChatUrl(runtime, choices, DEFAULT_GATEWAY_PORT);
    await printPostSetupSummary(runtime, choices, chatUrl);
    return;
  }

  if (choices.backend === "vertex") {
    await setupVertexBackend(runtime, choices, { dryRun });
    await applySharedAgentDefaults(choices, useDocker, runningInsideContainer);
    const chatUrl = dryRun
      ? undefined
      : await startGatewayAndGetChatUrl(runtime, choices, DEFAULT_GATEWAY_PORT);
    await printPostSetupSummary(runtime, choices, chatUrl);
    return;
  }

  // Local (default) backend: detect hardware and provision Ollama / llama.cpp.
  runtime.log("Detecting hardware...");

  const hw = detectHardware();
  const tools = detectSystemTools();

  for (const line of formatHardwareInfo(hw)) {
    runtime.log(line);
  }

  let profile;

  if (opts.advanced) {
    const io = createStdioWizardIO();
    try {
      profile = await runAdvancedWizard(io, hw, tools);
    } finally {
      io.close();
    }
  } else {
    profile = selectQuickProfile(hw, tools);
    const recommendedModel = resolveLocalOllamaModel(choices.model, profile.model);
    if (recommendedModel && recommendedModel !== profile.model) {
      profile = { ...profile, model: recommendedModel, modelDisplayName: recommendedModel };
    }
    const displayName = profile.modelDisplayName ?? profile.model ?? "default model";
    const dlSize = formatModelSize(profile.modelDownloadBytes);
    runtime.log("");
    runtime.log(`Recommended: ${displayName} (${dlSize} download)`);
    runtime.log(`  ${profile.reason}`);
  }

  if (dryRun) {
    runtime.log("");
    runtime.log("[dry-run] Skipping backend provisioning, gateway start, and smoke test.");
    runtime.log(
      `[dry-run] Would provision ${profile.backend} with model ${profile.model ?? "(auto)"} on port ${String(profile.port)}.`,
    );
    await applySharedAgentDefaults(choices, useDocker, runningInsideContainer);
    await printPostSetupSummary(runtime, choices, undefined);
    return;
  }

  runtime.log("");
  runtime.log(`Provisioning ${profile.backend} on port ${String(profile.port)}...`);

  const progress = (msg: string) => {
    runtime.log(msg);
  };

  try {
    const result = await provision({
      backend: profile.backend,
      model: profile.model,
      port: profile.port,
      progress,
    });

    runtime.log("");
    runtime.log("Running smoke test...");
    const verification = await verifyCompletion(result.handle.apiBaseUrl, result.modelId);

    if (verification.ok) {
      runtime.log(`Smoke test passed. Response: "${verification.content}"`);

      runtime.log("");
      runtime.log("Writing gateway configuration...");
      const { mutateConfigFile } = await import("../config/mutate.js");
      const ollamaModel = result.modelId;
      const ollamaBaseUrl = `${result.handle.apiBaseUrl}/v1`;
      const enableSandbox = useDocker;
      await mutateConfigFile({
        mutate: (draft) => {
          draft.gateway ??= {};
          draft.gateway.mode = "local";
          draft.gateway.auth ??= {};
          draft.gateway.auth.mode = "none";

          draft.models ??= {};
          draft.models.providers ??= {};
          draft.models.providers.ollama = {
            baseUrl: ollamaBaseUrl,
            api: "ollama",
            models: [
              {
                id: ollamaModel,
                name: ollamaModel,
                reasoning: false,
                input: ["text", "image"],
                contextWindow: 262_144,
                maxTokens: 8_192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          };

          draft.agents ??= {};
          draft.agents.defaults ??= {};
          draft.agents.defaults.model = `ollama/${ollamaModel}`;
          draft.agents.defaults.thinkingDefault = persistThinkingDefault(choices.thinkingLevel);
          applySetupAgentConfig(draft, choices);

          applyGemmaclawToolDefaults(draft);

          if (enableSandbox) {
            draft.agents.defaults.sandbox = {
              mode: "all",
              backend: "docker",
              scope: "session",
              workspaceAccess: "rw",
            };
          } else if (runningInsideContainer) {
            applySandboxOffDefault(draft);
          }
        },
      });
      runtime.log(`  Provider: ollama (${ollamaBaseUrl})`);
      runtime.log(`  Model: ollama/${ollamaModel}`);

      if (enableSandbox) {
        runtime.log(`  Sandbox: Docker (tools run in isolated containers)`);
        const { resolveDefaultSandboxSharedDir } = await import("../agents/sandbox/config.js");
        const sharedDir = resolveDefaultSandboxSharedDir();
        try {
          const { mkdirSync } = await import("node:fs");
          mkdirSync(sharedDir, { recursive: true });
          runtime.log(`  Shared: ${sharedDir} (mounted at /shared in containers)`);
        } catch {
          runtime.log(`  Shared: could not create ${sharedDir}`);
        }
      } else {
        runtime.log(`  Sandbox: off (tools run on host)`);
      }

      await applyAgentNameAndBootstrap(choices);

      runtime.log("");
      runtime.log("Setup complete! Your Gemma assistant is ready.");

      const chatUrl = await startGatewayAndGetChatUrl(runtime, choices, DEFAULT_GATEWAY_PORT);
      if (!chatUrl) {
        runtime.log("");
        runtime.log(
          `Backend PID: ${String(result.handle.pid)} (stop with: kill ${String(result.handle.pid)})`,
        );
        await printPostSetupSummary(runtime, choices, undefined);
        return;
      }
      await printPostSetupSummary(runtime, choices, chatUrl);
      runtime.log(
        `Backend PID: ${String(result.handle.pid)} (stop with: kill ${String(result.handle.pid)})`,
      );
    } else {
      runtime.error(`Smoke test failed: ${verification.error}`);
      runtime.error("The backend started but could not generate a response.");
      runtime.error(
        "Try running again or use 'gemmaclaw setup --advanced' to pick a different backend.",
      );
      await result.handle.stop();
      runtime.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.error(`Setup failed: ${message}`);
    runtime.error("");
    runtime.error("Troubleshooting:");
    runtime.error("  - Check network connectivity (runtimes and models are downloaded)");
    runtime.error("  - Try 'gemmaclaw setup --advanced' to pick a different backend");
    runtime.error("  - See 'gemmaclaw provision --help' for manual control");
    runtime.exit(1);
  }
}

async function setupGeminiBackend(
  runtime: RuntimeEnv,
  choices: OnboardingChoices,
  ctx: { dryRun: boolean },
): Promise<void> {
  if (!choices.apiKey) {
    runtime.error("Gemini API key required. Set GEMINI_API_KEY or pick another backend.");
    runtime.exit(1);
    return;
  }
  runtime.log(`Configuring Gemini API with model ${choices.model}.`);
  if (ctx.dryRun) {
    runtime.log("[dry-run] Skipping auth profile write.");
  } else {
    await writeGeminiAuthProfile(choices.agentName, choices.apiKey);
  }
}

async function setupVertexBackend(
  runtime: RuntimeEnv,
  choices: OnboardingChoices,
  ctx: { dryRun: boolean },
): Promise<void> {
  runtime.log(`Configuring Vertex AI with model ${choices.model}.`);
  if (ctx.dryRun) {
    runtime.log("[dry-run] Skipping gcloud auth probe and Vertex config write.");
    return;
  }
  const { interactiveVertexSetup, buildVertexConfig } =
    await import("../gemmaclaw/provision/vertex-setup.js");
  const { writeConfigFile } = await import("../config/config.js");

  const result = await interactiveVertexSetup({ model: choices.model });
  if (!result.ok || !result.config) {
    runtime.error(`Vertex AI setup failed: ${result.error}`);
    runtime.exit(1);
    return;
  }

  const vertexConfigPatch = buildVertexConfig(result.config);
  await writeConfigFile(vertexConfigPatch);

  if (result.config.accessToken) {
    await writeVertexAuthProfile(choices.agentName, result.config.accessToken);
  }
}

async function writeGeminiAuthProfile(agentName: string, apiKey: string): Promise<void> {
  const fs = await import("node:fs");
  const homeDir = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/root";
  const agentDir = path.join(homeDir, ".openclaw", "agents", normalizeAgentId(agentName), "agent");
  const authPath = path.join(agentDir, "auth-profiles.json");
  let auth: Record<string, unknown> = { version: 1, profiles: {} };
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  } catch {
    /* first time */
  }
  const profiles = (auth.profiles ?? {}) as Record<string, unknown>;
  profiles["google:api-key"] = { type: "token", provider: "google", token: apiKey };
  auth.profiles = profiles;
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
}

async function writeVertexAuthProfile(agentName: string, accessToken: string): Promise<void> {
  const fs = await import("node:fs");
  const homeDir = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/root";
  const authPath = path.join(
    homeDir,
    ".openclaw",
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

/**
 * Persist the agent name, thinking level, and bootstrap choice into the
 * shared config draft. Used for non-local backends that skip the local
 * provisioning block but still need defaults written.
 */
async function applySharedAgentDefaults(
  choices: OnboardingChoices,
  useContainer: boolean,
  forceSandboxOff = false,
): Promise<void> {
  const { mutateConfigFile } = await import("../config/mutate.js");
  await mutateConfigFile({
    mutate: (draft) => {
      draft.agents ??= {};
      draft.agents.defaults ??= {};
      const defaults = draft.agents.defaults as Record<string, unknown>;
      defaults["thinkingDefault"] = persistThinkingDefault(choices.thinkingLevel);
      // Map onboarding backend → canonical model id for non-local routes.
      if (choices.backend === "gemini") {
        defaults["model"] = choices.model;
      } else if (choices.backend === "vertex") {
        defaults["model"] = `google-vertex/${choices.model}`;
      }
      applyGemmaclawToolDefaults(draft);

      // Agent name, bootstrap profile, and container preference are recorded
      // in the per-agent onboarding.json manifest. They aren't part of the
      // OpenClaw config schema (which would reject unknown keys), and the
      // manifest is the single source of truth for "what did setup choose".
      if (useContainer) {
        defaults["sandbox"] = {
          mode: "all",
          backend: "docker",
          scope: "session",
          workspaceAccess: "rw",
        };
      } else if (forceSandboxOff) {
        applySandboxOffDefault(draft);
      }
      applySetupAgentConfig(draft, choices);
    },
  });
  await applyAgentNameAndBootstrap(choices);
}

async function applyAgentNameAndBootstrap(choices: OnboardingChoices): Promise<void> {
  const fs = await import("node:fs");
  const { loadConfig } = await import("../config/config.js");
  const { applyBootstrapProfile } = await import("../gemmaclaw/provision/bootstrap-profiles.js");
  const cfg = loadConfig();
  const agentId = normalizeAgentId(choices.agentName);
  const agentDir = resolveAgentDir(cfg, agentId);
  const agentRoot = path.dirname(agentDir);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "sessions"), { recursive: true });
  // Stamp a tiny manifest so we can verify which bootstrap profile was chosen
  // without relying on parsing the larger config file.
  const manifestPath = path.join(agentRoot, "agent", "onboarding.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        agentName: choices.agentName,
        backend: choices.backend,
        model: choices.model,
        thinkingLevel: choices.thinkingLevel,
        bootstrap: choices.bootstrap,
        useContainer: choices.useContainer,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  // Drop the bootstrap profile's starter files (AGENTS.md, optional TOOLS.md)
  // into the same workspace recorded in the canonical agent config. Never
  // overwrite user edits — `applyBootstrapProfile` skips existing files by default.
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  applyBootstrapProfile(choices.bootstrap, workspaceDir);
}

async function printPostSetupSummary(
  runtime: RuntimeEnv,
  choices: OnboardingChoices,
  gatewayUrl: string | undefined,
): Promise<void> {
  const summary = await import("../gemmaclaw/provision/onboarding-wizard.js");
  runtime.log("");
  for (const line of summary.formatChoicesSummary(choices)) {
    runtime.log(line);
  }
  runtime.log("");
  for (const line of summary.formatNextSteps(choices, gatewayUrl)) {
    runtime.log(line);
  }
}
