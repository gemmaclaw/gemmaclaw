import { createInterface } from "node:readline";

/**
 * Beginner-oriented onboarding wizard.
 *
 * Walks a new user through every choice they need to make to end up with a
 * working Gemmaclaw agent: agent name, run environment (host vs container),
 * backend / provider, model, reasoning depth, and starter bootstrap profile.
 *
 * The flow is intentionally explicit and verbose because most first-time users
 * have no prior context for "what is a container", "which model is right for
 * me", "what does thinking level do". Each prompt explains the trade-off in
 * plain language and offers a safe default.
 *
 * This module deliberately keeps no I/O state of its own; callers pass a
 * `WizardIO` so the same logic powers both the live CLI and the tests.
 */

export type OnboardingBackend = "local" | "gemini" | "vertex";
export type OnboardingThinking = "off" | "low" | "medium" | "high";
export type OnboardingBootstrap = "general" | "coding" | "minimal";

export interface OnboardingChoices {
  agentName: string;
  useContainer: boolean;
  backend: OnboardingBackend;
  model: string;
  thinkingLevel: OnboardingThinking;
  bootstrap: OnboardingBootstrap;
  /** Gemini API key when backend === "gemini". */
  apiKey?: string;
}

export interface OnboardingDefaults {
  agentName?: string;
  useContainer?: boolean;
  backend?: OnboardingBackend;
  model?: string;
  thinkingLevel?: OnboardingThinking;
  bootstrap?: OnboardingBootstrap;
}

export interface WizardIO {
  prompt(question: string): Promise<string>;
  log(msg: string): void;
  error(msg: string): void;
}

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/i;

const LOCAL_MODEL_CHOICES: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  {
    id: "auto",
    label: "Auto (recommended)",
    hint: "Pick the best Gemma 4 model for your detected hardware.",
  },
  {
    id: "gemma3:1b",
    label: "Small (gemma3:1b)",
    hint: "~815 MB. Runs on most laptops. Fastest, lowest quality.",
  },
  {
    id: "gemma3:4b",
    label: "Medium (gemma3:4b)",
    hint: "~3 GB. Needs ~6 GB free RAM. Good balance.",
  },
  {
    id: "gemma3:12b",
    label: "Large (gemma3:12b)",
    hint: "~8 GB. Needs ~16 GB free RAM or a GPU.",
  },
  {
    id: "gemma3:27b",
    label: "X-large (gemma3:27b)",
    hint: "~17 GB. Best quality. Needs a beefy GPU or 32+ GB RAM.",
  },
];

const GEMINI_MODEL_CHOICES: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  {
    id: "google/gemini-2.5-flash",
    label: "Flash (recommended)",
    hint: "Fast and cheap. Best for most chat / agent work.",
  },
  {
    id: "google/gemini-2.5-pro",
    label: "Pro",
    hint: "Slower and pricier, but stronger reasoning.",
  },
];

const VERTEX_MODEL_CHOICES: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  {
    id: "gemma-3-4b-it",
    label: "Small (gemma-3-4b-it)",
    hint: "Fast, low-cost. Good for routing and simple chat.",
  },
  {
    id: "gemma-3-12b-it",
    label: "Medium (gemma-3-12b-it)",
    hint: "Balanced quality and cost. Recommended default.",
  },
  {
    id: "gemma-3-27b-it",
    label: "Large (gemma-3-27b-it)",
    hint: "Highest quality. More compute, more cost.",
  },
];

const THINKING_CHOICES: ReadonlyArray<{ id: OnboardingThinking; label: string; hint: string }> = [
  {
    id: "off",
    label: "Off",
    hint: "Reply directly without showing reasoning. Fastest.",
  },
  {
    id: "low",
    label: "Low",
    hint: "Brief reasoning before answering. Cheap and quick.",
  },
  {
    id: "medium",
    label: "Medium (recommended)",
    hint: "Moderate reasoning. Good for coding and analysis.",
  },
  {
    id: "high",
    label: "High",
    hint: "Deep reasoning. Slowest, but best for hard problems.",
  },
];

const BOOTSTRAP_CHOICES: ReadonlyArray<{
  id: OnboardingBootstrap;
  label: string;
  hint: string;
}> = [
  {
    id: "general",
    label: "General assistant (recommended)",
    hint: "Friendly default persona. Ready for chat, planning, research.",
  },
  {
    id: "coding",
    label: "Coding helper",
    hint: "Tuned for editing code, running tests, and shell commands.",
  },
  {
    id: "minimal",
    label: "Minimal",
    hint: "Empty workspace. You'll write the persona yourself.",
  },
];

/**
 * Validate an agent name. Returns null when valid, or a human-readable error
 * otherwise. Allowed: letters, digits, dashes; must start with a letter; 1-31
 * characters total. Names map directly to filesystem paths under
 * `~/.gemmaclaw/agents/<name>/`, so we want them to be safe and predictable.
 */
export function validateAgentName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "Agent name cannot be empty.";
  }
  if (!AGENT_NAME_PATTERN.test(trimmed)) {
    return "Use only letters, digits, and dashes (1-31 chars, must start with a letter).";
  }
  return null;
}

/**
 * Resolve the canonical model identifier given a wizard choice. For "auto"
 * local, we return "auto" so downstream code can run hardware detection.
 */
export function resolveModelId(backend: OnboardingBackend, choice: string): string {
  const trimmed = choice.trim();
  if (!trimmed) {
    return defaultModelFor(backend);
  }
  if (backend === "gemini" && !trimmed.includes("/")) {
    return `google/${trimmed}`;
  }
  return trimmed;
}

export function defaultModelFor(backend: OnboardingBackend): string {
  if (backend === "local") {
    return "auto";
  }
  if (backend === "gemini") {
    return "google/gemini-2.5-flash";
  }
  return "gemma-3-12b-it";
}

export function modelChoicesFor(
  backend: OnboardingBackend,
): ReadonlyArray<{ id: string; label: string; hint: string }> {
  if (backend === "local") {
    return LOCAL_MODEL_CHOICES;
  }
  if (backend === "gemini") {
    return GEMINI_MODEL_CHOICES;
  }
  return VERTEX_MODEL_CHOICES;
}

/**
 * Run the full onboarding wizard. The caller supplies `defaults` to seed any
 * non-interactive flags (e.g. `--agent-name` from the CLI). Anything left
 * unset is asked interactively via `io`.
 */
export async function runOnboardingWizard(
  io: WizardIO,
  defaults: OnboardingDefaults = {},
): Promise<OnboardingChoices> {
  io.log("");
  io.log("Welcome to Gemmaclaw. We'll set up an AI agent in five quick questions.");
  io.log("Press Enter at any prompt to keep the [bracketed] default.");
  io.log("");

  const agentName = await askAgentName(io, defaults.agentName);
  const useContainer = await askContainer(io, defaults.useContainer);
  const backend = await askBackend(io, defaults.backend);
  const model = await askModel(io, backend, defaults.model);
  const thinkingLevel = await askThinking(io, defaults.thinkingLevel);
  const bootstrap = await askBootstrap(io, defaults.bootstrap);

  let apiKey: string | undefined;
  if (backend === "gemini") {
    apiKey = await askGeminiApiKey(io);
  }

  return {
    agentName,
    useContainer,
    backend,
    model,
    thinkingLevel,
    bootstrap,
    apiKey,
  };
}

async function askAgentName(io: WizardIO, preset?: string): Promise<string> {
  if (preset) {
    const error = validateAgentName(preset);
    if (error) {
      throw new Error(`Invalid --agent-name "${preset}": ${error}`);
    }
    return preset.trim();
  }

  io.log("1. Agent name");
  io.log("   Each agent has its own workspace and memory under ~/.gemmaclaw/agents/<name>/.");
  io.log('   Pick something short and meaningful. "main" is fine if you only run one.');
  io.log("");

  for (;;) {
    const answer = await io.prompt("Agent name [main]: ");
    const candidate = answer.trim() || "main";
    const error = validateAgentName(candidate);
    if (!error) {
      io.log("");
      return candidate;
    }
    io.error(error);
  }
}

async function askContainer(io: WizardIO, preset?: boolean): Promise<boolean> {
  if (preset !== undefined) {
    return preset;
  }

  io.log("2. Where should the agent run its tools (shell, files, browser)?");
  io.log("");
  io.log("  1) Container (recommended)");
  io.log("     Tools run inside an isolated Docker container. The agent can do");
  io.log("     anything it needs to (run shells, edit files, browse the web)");
  io.log("     without being able to touch your host machine. Safer default if");
  io.log("     you're not sure. Requires Docker installed and running.");
  io.log("");
  io.log("  2) Directly on this machine");
  io.log("     Faster and simpler, but the agent can read and modify any file");
  io.log("     your user account can. Pick this if you trust the model and want");
  io.log("     less setup.");
  io.log("");

  for (;;) {
    const answer = await io.prompt("Choose [1/2, default=1]: ");
    const choice = answer.trim() || "1";
    if (choice === "1" || choice.toLowerCase() === "container") {
      io.log("");
      return true;
    }
    if (choice === "2" || choice.toLowerCase() === "host" || choice.toLowerCase() === "direct") {
      io.log("");
      return false;
    }
    io.error(`Invalid choice "${choice}". Enter 1 or 2.`);
  }
}

async function askBackend(io: WizardIO, preset?: OnboardingBackend): Promise<OnboardingBackend> {
  if (preset) {
    return preset;
  }

  io.log("3. Where should the model run?");
  io.log("");
  io.log("  1) Local       Run on this machine. Private, no data leaves your network.");
  io.log("                 Auto-detects GPU and downloads the model.");
  io.log("  2) Gemini API  Use Google's hosted Gemini API. No GPU required, just an API");
  io.log("                 key from aistudio.google.com.");
  io.log("  3) Vertex AI   Use Google Cloud Vertex AI. Best for enterprise / GCP users.");
  io.log("                 Requires gcloud CLI signed in.");
  io.log("");

  for (;;) {
    const answer = await io.prompt("Choose [1/2/3, default=1]: ");
    const choice = answer.trim() || "1";
    if (choice === "1" || choice.toLowerCase() === "local") {
      io.log("");
      return "local";
    }
    if (choice === "2" || choice.toLowerCase() === "gemini") {
      io.log("");
      return "gemini";
    }
    if (choice === "3" || choice.toLowerCase() === "vertex") {
      io.log("");
      return "vertex";
    }
    io.error(`Invalid choice "${choice}". Enter 1, 2, or 3.`);
  }
}

async function askModel(
  io: WizardIO,
  backend: OnboardingBackend,
  preset?: string,
): Promise<string> {
  if (preset) {
    return resolveModelId(backend, preset);
  }

  const choices = modelChoicesFor(backend);
  io.log("4. Which model?");
  for (let i = 0; i < choices.length; i++) {
    const c = choices[i];
    if (!c) {
      continue;
    }
    io.log(`  ${String(i + 1)}) ${c.label}`);
    io.log(`     ${c.hint}`);
  }
  io.log("");

  for (;;) {
    const answer = await io.prompt(`Choose [1-${String(choices.length)}, default=1]: `);
    const trimmed = answer.trim();
    if (trimmed === "") {
      io.log("");
      return choices[0]?.id ?? defaultModelFor(backend);
    }
    const idx = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= choices.length) {
      io.log("");
      return choices[idx - 1]?.id ?? defaultModelFor(backend);
    }
    // Allow free-form model id for power users (validated by provisioner).
    if (/^[a-z0-9][a-z0-9./_:-]{1,80}$/i.test(trimmed)) {
      io.log("");
      return trimmed;
    }
    io.error(`Invalid choice "${trimmed}". Enter 1-${String(choices.length)} or a model id.`);
  }
}

async function askThinking(io: WizardIO, preset?: OnboardingThinking): Promise<OnboardingThinking> {
  if (preset) {
    return preset;
  }

  io.log("5. How much should the agent think before answering?");
  io.log("   Higher levels are slower but produce better answers on tricky problems.");
  for (let i = 0; i < THINKING_CHOICES.length; i++) {
    const c = THINKING_CHOICES[i];
    if (!c) {
      continue;
    }
    io.log(`  ${String(i + 1)}) ${c.label}`);
    io.log(`     ${c.hint}`);
  }
  io.log("");

  for (;;) {
    const answer = await io.prompt(
      `Choose [1-${String(THINKING_CHOICES.length)}, default=3 (medium)]: `,
    );
    const trimmed = answer.trim();
    if (trimmed === "") {
      io.log("");
      return "medium";
    }
    const idx = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= THINKING_CHOICES.length) {
      io.log("");
      return THINKING_CHOICES[idx - 1]?.id ?? "medium";
    }
    const lc = trimmed.toLowerCase();
    if (lc === "off" || lc === "low" || lc === "medium" || lc === "high") {
      io.log("");
      return lc;
    }
    io.error(`Invalid choice "${trimmed}". Enter 1-4 or off/low/medium/high.`);
  }
}

async function askBootstrap(
  io: WizardIO,
  preset?: OnboardingBootstrap,
): Promise<OnboardingBootstrap> {
  if (preset) {
    return preset;
  }

  io.log("6. What should the agent's starter persona look like?");
  io.log("   This seeds AGENTS.md / SOUL.md in the workspace. You can edit later.");
  for (let i = 0; i < BOOTSTRAP_CHOICES.length; i++) {
    const c = BOOTSTRAP_CHOICES[i];
    if (!c) {
      continue;
    }
    io.log(`  ${String(i + 1)}) ${c.label}`);
    io.log(`     ${c.hint}`);
  }
  io.log("");

  for (;;) {
    const answer = await io.prompt(
      `Choose [1-${String(BOOTSTRAP_CHOICES.length)}, default=1 (general)]: `,
    );
    const trimmed = answer.trim();
    if (trimmed === "") {
      io.log("");
      return "general";
    }
    const idx = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= BOOTSTRAP_CHOICES.length) {
      io.log("");
      return BOOTSTRAP_CHOICES[idx - 1]?.id ?? "general";
    }
    const lc = trimmed.toLowerCase();
    if (lc === "general" || lc === "coding" || lc === "minimal") {
      io.log("");
      return lc;
    }
    io.error(`Invalid choice "${trimmed}". Enter 1-3 or general/coding/minimal.`);
  }
}

async function askGeminiApiKey(io: WizardIO): Promise<string> {
  const env = process.env.GEMINI_API_KEY?.trim();
  if (env) {
    io.log(`Using GEMINI_API_KEY from environment (length=${String(env.length)}).`);
    io.log("");
    return env;
  }
  io.log("   Get a free Gemini API key at https://aistudio.google.com/apikey");
  for (;;) {
    const answer = await io.prompt("Gemini API key: ");
    const trimmed = answer.trim();
    if (trimmed.length === 0) {
      io.error("API key required for the Gemini API path. Pick another backend or paste your key.");
      continue;
    }
    io.log("");
    return trimmed;
  }
}

/**
 * Render the user's choices as a printable summary block. Used both as the
 * pre-provision confirmation and as the post-setup recap.
 */
export function formatChoicesSummary(choices: OnboardingChoices): string[] {
  const backendLabel =
    choices.backend === "local"
      ? "Local (this machine)"
      : choices.backend === "gemini"
        ? "Gemini API (Google AI Studio)"
        : "Vertex AI (GCP)";
  const containerLabel = choices.useContainer
    ? "Container (Docker sandbox for tools)"
    : "Direct on host (no sandbox)";
  const bootstrapLabel =
    BOOTSTRAP_CHOICES.find((c) => c.id === choices.bootstrap)?.label ?? choices.bootstrap;
  return [
    "Your setup:",
    `  Agent name:  ${choices.agentName}`,
    `  Run mode:    ${containerLabel}`,
    `  Backend:     ${backendLabel}`,
    `  Model:       ${choices.model}`,
    `  Thinking:    ${choices.thinkingLevel}`,
    `  Persona:     ${bootstrapLabel}`,
  ];
}

/**
 * Build a human-readable "what's next" block printed after setup completes.
 */
export function formatNextSteps(choices: OnboardingChoices, gatewayUrl?: string): string[] {
  const lines: string[] = [];
  lines.push("Next steps:");
  if (gatewayUrl) {
    lines.push(`  - Open the chat UI:  ${gatewayUrl}`);
  }
  lines.push(
    `  - Send a one-shot message:  gemmaclaw message --agent ${choices.agentName} "Hello"`,
  );
  lines.push(`  - Open an interactive chat: gemmaclaw chat --agent ${choices.agentName}`);
  lines.push(`  - Open local TUI/chat:      gemmaclaw tui ${choices.agentName}`);
  lines.push(
    choices.useContainer
      ? "    (Docker-backed agents use a persistent per-agent 127.0.0.1 port.)"
      : "    (Host-local agents open the terminal TUI directly.)",
  );
  lines.push("  - Re-run setup any time:    gemmaclaw setup");
  lines.push("");
  lines.push("Change later:");
  lines.push("  - Switch backend / model:   gemmaclaw setup --advanced");
  lines.push(
    `  - Edit persona files:       see ~/.gemmaclaw/workspaces/${choices.agentName}/AGENTS.md`,
  );
  lines.push(`  - Tweak thinking level:     edit agents.defaults.thinkingDefault in config`);
  return lines;
}

/**
 * Create a `WizardIO` backed by stdin/stdout. The returned object has a
 * `close()` method so the caller can release the underlying readline
 * interface when the wizard is done.
 *
 * Uses a non-promise readline interface in `terminal: false` mode and a
 * manual line queue. The promise-based `rl.question()` API has a known
 * footgun on non-TTY (piped) stdin: it returns the first line and then
 * blocks indefinitely on subsequent calls. The custom queue avoids that and
 * keeps interactive TTY usage feeling exactly the same.
 */
export function createStdioOnboardingIO(): WizardIO & { close(): void } {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  const lineQueue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let closed = false;

  rl.on("line", (line) => {
    const next = waiters.shift();
    if (next) {
      next(line);
    } else {
      lineQueue.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (w) {
        w("");
      }
    }
  });

  return {
    prompt: (q) =>
      new Promise<string>((resolve) => {
        process.stdout.write(q);
        const queued = lineQueue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        if (closed) {
          resolve("");
          return;
        }
        waiters.push(resolve);
      }),
    log: (msg) => {
      console.log(msg);
    },
    error: (msg) => {
      console.error(msg);
    },
    close: () => {
      rl.close();
    },
  };
}

/**
 * Build an `OnboardingChoices` object directly from non-interactive flags +
 * environment defaults. Used by `--non-interactive` / CI / e2e harnesses so
 * the same downstream code path runs without prompting.
 */
export function buildNonInteractiveChoices(opts: {
  agentName?: string;
  useContainer?: boolean;
  backend?: OnboardingBackend;
  model?: string;
  thinkingLevel?: OnboardingThinking;
  bootstrap?: OnboardingBootstrap;
  apiKey?: string;
}): OnboardingChoices {
  const agentName = opts.agentName?.trim() || "main";
  const nameError = validateAgentName(agentName);
  if (nameError) {
    throw new Error(`Invalid agent name "${agentName}": ${nameError}`);
  }
  const backend: OnboardingBackend = opts.backend ?? "local";
  const model = resolveModelId(backend, opts.model ?? "");
  const thinkingLevel: OnboardingThinking = opts.thinkingLevel ?? "medium";
  const bootstrap: OnboardingBootstrap = opts.bootstrap ?? "general";
  const useContainer = opts.useContainer ?? true;
  return {
    agentName,
    useContainer,
    backend,
    model,
    thinkingLevel,
    bootstrap,
    apiKey: backend === "gemini" ? (opts.apiKey ?? process.env.GEMINI_API_KEY?.trim()) : undefined,
  };
}
