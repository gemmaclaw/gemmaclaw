import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  OnboardingBackend,
  OnboardingBootstrap,
  OnboardingChoices,
  OnboardingThinking,
} from "../gemmaclaw/provision/onboarding-wizard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

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

/** Injectable probe for Docker availability. Override in tests to avoid spawning Docker. */
export interface DockerProbe {
  isInstalled(): boolean;
  isRunning(): boolean;
}

const DOCKER_PROBE: DockerProbe = { isInstalled: isDockerInstalled, isRunning: isDockerRunning };

/**
 * Assert that Docker is available for container mode. Hard-fails with a clear
 * actionable error when Docker is missing or not running. Never silently falls
 * back to host execution — the user explicitly chose container mode.
 *
 * In interactive mode, if Docker is installed but not running, the user gets
 * one prompt to start it before setup aborts. In non-interactive mode (prompt
 * is null), the function exits immediately on any Docker failure.
 *
 * Note: this check is skipped entirely when dryRun is true, since dry-run is
 * meant to validate wizard flow and config without touching live services.
 */
export async function assertDockerForContainerMode(
  runtime: RuntimeEnv,
  probe: DockerProbe,
  prompt: ((q: string) => Promise<string>) | null,
): Promise<void> {
  const installUrl = "https://docs.docker.com/get-docker/";

  if (!probe.isInstalled()) {
    runtime.error("");
    runtime.error("Container mode requires Docker, but Docker is not installed on this machine.");
    runtime.error(`Install Docker from ${installUrl} and rerun setup,`);
    runtime.error("or choose local mode (option 2 in the setup wizard, or --no-container).");
    runtime.exit(1);
    return;
  }

  if (!probe.isRunning()) {
    runtime.error("");
    runtime.error("Container mode requires Docker, but the Docker daemon is not running.");
    runtime.error("Start Docker and try again:");
    runtime.error("  macOS:   Open Docker Desktop (or: open -a Docker)");
    runtime.error("  Linux:   sudo systemctl start docker");

    if (prompt) {
      const answer = await prompt("Press Enter once Docker is running (or Ctrl+C to cancel): ");
      if (!answer.trim() && probe.isRunning()) {
        return;
      }
    }

    runtime.error("");
    runtime.error(`Install or start Docker from ${installUrl} and rerun setup,`);
    runtime.error("or choose local mode (--no-container).");
    runtime.exit(1);
    return;
  }
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

  // Echo the resolved choices so the user can see what setup is about to do.
  runtime.log("");
  for (const line of formatChoicesSummary(choices)) {
    runtime.log(line);
  }
  runtime.log("");

  // If the user picked container mode, verify Docker is actually available.
  // Hard-fail with an actionable error if Docker is missing or not running —
  // the user explicitly chose container mode, so silently downgrading to host
  // execution would contradict their intent.
  // Dry-run skips this check so wizard flow and config writes can be tested
  // without a running Docker daemon.
  if (choices.useContainer) {
    if (dryRun) {
      runtime.log("[dry-run] Skipping Docker availability check for container mode.");
    } else {
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
      await assertDockerForContainerMode(runtime, DOCKER_PROBE, interactivePrompt);
    }
  }
  const useDocker = choices.useContainer;

  if (choices.backend === "gemini") {
    await setupGeminiBackend(runtime, choices, { dryRun });
    await applySharedAgentDefaults(choices, useDocker);
    await printPostSetupSummary(runtime, choices, undefined);
    return;
  }

  if (choices.backend === "vertex") {
    await setupVertexBackend(runtime, choices, { dryRun });
    await applySharedAgentDefaults(choices, useDocker);
    await printPostSetupSummary(runtime, choices, undefined);
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
    await applySharedAgentDefaults(choices, useDocker);
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

          draft.tools ??= {};
          draft.tools.exec ??= {};
          (draft.tools.exec as Record<string, unknown>).security = "full";
          (draft.tools.exec as Record<string, unknown>).ask = "off";

          if (enableSandbox) {
            draft.agents.defaults.sandbox = {
              mode: "all",
              backend: "docker",
              scope: "session",
              workspaceAccess: "rw",
            };
          }
        },
      });
      runtime.log(`  Provider: ollama (${ollamaBaseUrl})`);
      runtime.log(`  Model: ollama/${ollamaModel}`);

      if (enableSandbox) {
        runtime.log(`  Sandbox: Docker (tools run in isolated containers)`);
        const sharedDir = path.join(process.env.HOME ?? "/root", ".gemmaclaw", "shared");
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

      const gwPort = DEFAULT_GATEWAY_PORT;
      killProcessesOnPort(gwPort);

      runtime.log("");
      runtime.log(`Starting gateway on port ${String(gwPort)}...`);
      spawnGatewayDetached(gwPort);

      const ready = await waitForGatewayReady(gwPort);
      if (!ready) {
        runtime.error("Gateway did not become ready within 30 seconds.");
        runtime.error("You can start it manually with: gemmaclaw chat");
        runtime.log("");
        runtime.log(
          `Backend PID: ${String(result.handle.pid)} (stop with: kill ${String(result.handle.pid)})`,
        );
        await printPostSetupSummary(runtime, choices, undefined);
        return;
      }
      runtime.log("Gateway is ready.");

      const chatUrl = `http://127.0.0.1:${String(gwPort)}/`;
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
  const agentDir = path.join(homeDir, ".openclaw", "agents", agentName, "agent");
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
    agentName,
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
      }
    },
  });
  await applyAgentNameAndBootstrap(choices);
}

async function applyAgentNameAndBootstrap(choices: OnboardingChoices): Promise<void> {
  const fs = await import("node:fs");
  const { applyBootstrapProfile } = await import("../gemmaclaw/provision/bootstrap-profiles.js");
  const homeDir = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/root";
  const agentRoot = path.join(homeDir, ".openclaw", "agents", choices.agentName);
  fs.mkdirSync(path.join(agentRoot, "agent"), { recursive: true });
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
  // into the workspace. We use the workspace dir from the existing default
  // (~/.openclaw/workspace for the "main" agent; per-agent under
  // ~/.openclaw/workspaces/<name> for everyone else) and never overwrite
  // user edits — `applyBootstrapProfile` skips existing files by default.
  const workspaceDir =
    choices.agentName === "main"
      ? path.join(homeDir, ".openclaw", "workspace")
      : path.join(homeDir, ".openclaw", "workspaces", choices.agentName);
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
