import { describe, expect, it, vi } from "vitest";
import {
  COMMITMENT_FOLLOWTHROUGH_LOOP_ID,
  EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID,
} from "../gemmaclaw_instructions.js";
import {
  buildNonInteractiveChoices,
  defaultModelFor,
  formatChoicesSummary,
  formatNextSteps,
  modelChoicesFor,
  resolveModelId,
  runOnboardingWizard,
  validateAgentName,
  type WizardIO,
} from "./onboarding-wizard.js";

const DEFAULT_ENHANCEMENTS = [
  EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID,
  COMMITMENT_FOLLOWTHROUGH_LOOP_ID,
];

/**
 * Build a scripted WizardIO that pops one queued response per `prompt()` call
 * and records every log/error line for later assertions.
 */
function makeScriptedIO(answers: string[]): {
  io: WizardIO;
  logs: string[];
  errors: string[];
  prompts: string[];
} {
  const queue = [...answers];
  const logs: string[] = [];
  const errors: string[] = [];
  const prompts: string[] = [];
  const io: WizardIO = {
    prompt: vi.fn(async (q: string) => {
      prompts.push(q);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`No scripted answer left for prompt: ${q}`);
      }
      return next;
    }),
    log: vi.fn((msg: string) => {
      logs.push(msg);
    }),
    error: vi.fn((msg: string) => {
      errors.push(msg);
    }),
  };
  return { io, logs, errors, prompts };
}

describe("validateAgentName", () => {
  it("accepts simple alphanumeric names", () => {
    expect(validateAgentName("main")).toBeNull();
    expect(validateAgentName("my-agent")).toBeNull();
    expect(validateAgentName("agent42")).toBeNull();
  });

  it("rejects empty names", () => {
    expect(validateAgentName("")).toContain("empty");
    expect(validateAgentName("   ")).toContain("empty");
  });

  it("rejects names with disallowed characters", () => {
    expect(validateAgentName("my agent")).toContain("letters");
    expect(validateAgentName("Agent_42")).toContain("letters");
    expect(validateAgentName("../etc")).toContain("letters");
  });

  it("rejects names that don't start with a letter", () => {
    expect(validateAgentName("1agent")).toContain("letters");
    expect(validateAgentName("-agent")).toContain("letters");
  });

  it("rejects names longer than 31 characters", () => {
    expect(validateAgentName("a".repeat(32))).toContain("letters");
  });
});

describe("defaultModelFor", () => {
  it("returns 'auto' for local backend", () => {
    expect(defaultModelFor("local")).toBe("auto");
  });

  it("returns Gemini Flash for gemini backend", () => {
    expect(defaultModelFor("gemini")).toBe("google/gemini-2.5-flash");
  });

  it("returns gemma-3-12b-it for vertex backend", () => {
    expect(defaultModelFor("vertex")).toBe("gemma-3-12b-it");
  });
});

describe("modelChoicesFor", () => {
  it("returns local choices including auto", () => {
    const choices = modelChoicesFor("local");
    expect(choices.length).toBeGreaterThan(0);
    expect(choices[0]?.id).toBe("auto");
  });

  it("returns Gemini choices including flash", () => {
    const choices = modelChoicesFor("gemini");
    expect(choices.some((c) => c.id === "google/gemini-2.5-flash")).toBe(true);
  });

  it("returns Vertex choices including gemma-3-12b-it", () => {
    const choices = modelChoicesFor("vertex");
    expect(choices.some((c) => c.id === "gemma-3-12b-it")).toBe(true);
  });
});

describe("resolveModelId", () => {
  it("returns the trimmed input when not blank", () => {
    expect(resolveModelId("local", "  gemma3:4b  ")).toBe("gemma3:4b");
  });

  it("normalizes unqualified Gemini model ids to the Google provider", () => {
    expect(resolveModelId("gemini", "gemini-2.5-flash")).toBe("google/gemini-2.5-flash");
    expect(resolveModelId("gemini", "google/gemini-2.5-pro")).toBe("google/gemini-2.5-pro");
  });

  it("returns the backend default when input is blank", () => {
    expect(resolveModelId("local", "")).toBe("auto");
    expect(resolveModelId("gemini", "")).toBe("google/gemini-2.5-flash");
  });
});

describe("runOnboardingWizard", () => {
  it("walks the user through every prompt in order", async () => {
    // Default answers via Enter: name, container, backend, model, thinking, bootstrap, enhancements.
    const { io, logs, prompts } = makeScriptedIO([
      "", // agent name → main
      "", // container choice → 1 (yes)
      "", // backend → 1 (local)
      "", // model → choice 1 (auto)
      "", // thinking level → medium
      "", // bootstrap → general
      "", // enhancements → defaults
    ]);

    const choices = await runOnboardingWizard(io);

    expect(choices).toEqual({
      agentName: "main",
      useContainer: true,
      backend: "local",
      model: "auto",
      thinkingLevel: "medium",
      bootstrap: "general",
      enhancements: DEFAULT_ENHANCEMENTS,
      apiKey: undefined,
    });

    // Seven prompts total in the local path.
    expect(prompts).toHaveLength(7);

    // Each step's heading is printed.
    const joined = logs.join("\n");
    expect(joined).toContain("Agent name");
    expect(joined).toContain("Where should the agent run its tools");
    expect(joined).toContain("Where should the model run");
    expect(joined).toContain("Which model");
    expect(joined).toContain("How much should the agent think");
    expect(joined).toContain("starter persona");
    expect(joined).toContain("Enable Gemmaclaw enhancements");
  });

  it("collects an API key when the user picks the Gemini backend", async () => {
    delete process.env.GEMINI_API_KEY;
    const { io } = makeScriptedIO([
      "demo-agent",
      "2", // host (no container)
      "2", // gemini
      "1", // first model in gemini list
      "2", // low thinking
      "2", // coding bootstrap
      "n", // disable enhancements
      "AIza-test-key",
    ]);

    const choices = await runOnboardingWizard(io);

    expect(choices).toEqual({
      agentName: "demo-agent",
      useContainer: false,
      backend: "gemini",
      model: "google/gemini-2.5-flash",
      thinkingLevel: "low",
      bootstrap: "coding",
      enhancements: [],
      apiKey: "AIza-test-key",
    });
  });

  it("re-prompts when the user enters an invalid agent name", async () => {
    const { io, errors } = makeScriptedIO([
      "Bad Name", // invalid
      "main", // valid
      "",
      "",
      "",
      "",
      "",
      "",
    ]);

    const choices = await runOnboardingWizard(io);
    expect(choices.agentName).toBe("main");
    expect(errors.some((e) => e.includes("letters"))).toBe(true);
  });

  it("re-prompts when the user enters an invalid backend choice", async () => {
    const { io, errors } = makeScriptedIO([
      "", // agent name
      "", // container default
      "9", // invalid backend
      "1", // valid: local
      "",
      "",
      "",
      "",
    ]);

    const choices = await runOnboardingWizard(io);
    expect(choices.backend).toBe("local");
    expect(errors.some((e) => e.includes("Invalid choice"))).toBe(true);
  });

  it("respects preset defaults and skips matching prompts", async () => {
    const { io, prompts } = makeScriptedIO([
      "", // model still asks
      "", // thinking still asks
      "", // bootstrap still asks
      "", // enhancements still asks
    ]);

    const choices = await runOnboardingWizard(io, {
      agentName: "preset-agent",
      useContainer: false,
      backend: "vertex",
    });

    expect(choices.agentName).toBe("preset-agent");
    expect(choices.useContainer).toBe(false);
    expect(choices.backend).toBe("vertex");
    expect(choices.model).toBe("gemma-3-4b-it"); // first vertex choice
    expect(choices.thinkingLevel).toBe("medium");
    expect(choices.bootstrap).toBe("general");
    expect(choices.enhancements).toEqual(DEFAULT_ENHANCEMENTS);
    expect(prompts).toHaveLength(4);
  });

  it("rejects a preset agent name that is not allowed", async () => {
    const { io } = makeScriptedIO([]);
    await expect(runOnboardingWizard(io, { agentName: "Bad Name" })).rejects.toThrow(
      /Invalid --agent-name/,
    );
  });

  it("uses GEMINI_API_KEY from env when present", async () => {
    process.env.GEMINI_API_KEY = "env-key-1234";
    try {
      const { io } = makeScriptedIO([
        "", // agent name → main
        "", // container default
        "2", // gemini
        "", // first model
        "", // medium thinking
        "", // general bootstrap
        "", // enhancements default
      ]);
      const choices = await runOnboardingWizard(io);
      expect(choices.apiKey).toBe("env-key-1234");
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });
});

describe("buildNonInteractiveChoices", () => {
  it("uses safe defaults when nothing is supplied", () => {
    const choices = buildNonInteractiveChoices({});
    expect(choices).toEqual({
      agentName: "main",
      useContainer: true,
      backend: "local",
      model: "auto",
      thinkingLevel: "medium",
      bootstrap: "general",
      enhancements: DEFAULT_ENHANCEMENTS,
      apiKey: undefined,
    });
  });

  it("plumbs through every supplied option", () => {
    const choices = buildNonInteractiveChoices({
      agentName: "ci-bot",
      useContainer: false,
      backend: "gemini",
      model: "gemini-2.5-pro",
      thinkingLevel: "high",
      bootstrap: "coding",
      enhancements: "none",
      apiKey: "AIza-x",
    });
    expect(choices).toEqual({
      agentName: "ci-bot",
      useContainer: false,
      backend: "gemini",
      model: "google/gemini-2.5-pro",
      thinkingLevel: "high",
      bootstrap: "coding",
      enhancements: [],
      apiKey: "AIza-x",
    });
  });

  it("rejects invalid agent names", () => {
    expect(() => buildNonInteractiveChoices({ agentName: "../etc" })).toThrow(/Invalid agent name/);
  });
});

describe("formatChoicesSummary", () => {
  it("renders every choice as a single block", () => {
    const summary = formatChoicesSummary({
      agentName: "demo",
      useContainer: true,
      backend: "local",
      model: "gemma3:4b",
      thinkingLevel: "high",
      bootstrap: "coding",
      enhancements: DEFAULT_ENHANCEMENTS,
    });
    const text = summary.join("\n");
    expect(text).toContain("Agent name:");
    expect(text).toContain("demo");
    expect(text).toContain("Container");
    expect(text).toContain("Local");
    expect(text).toContain("gemma3:4b");
    expect(text).toContain("high");
    expect(text).toContain("Coding helper");
    expect(text).toContain("external_delivery_receipt_verification");
  });
});

describe("formatNextSteps", () => {
  it("includes per-agent commands and gateway URL when provided", () => {
    const lines = formatNextSteps(
      {
        agentName: "tester",
        useContainer: false,
        backend: "local",
        model: "auto",
        thinkingLevel: "medium",
        bootstrap: "general",
        enhancements: DEFAULT_ENHANCEMENTS,
      },
      "http://127.0.0.1:8765/",
    );
    const text = lines.join("\n");
    expect(text).toContain("http://127.0.0.1:8765/");
    expect(text).toContain("--agent tester");
    expect(text).toContain("gemmaclaw tui tester");
    expect(text).toContain("Host-local agents open the terminal TUI directly.");
    expect(text).toContain("~/.gemmaclaw/workspaces/tester/AGENTS.md");
    expect(text).toContain("setup --advanced");
  });

  it("omits the chat URL when no gateway URL is provided", () => {
    const lines = formatNextSteps({
      agentName: "x",
      useContainer: true,
      backend: "gemini",
      model: "google/gemini-2.5-flash",
      thinkingLevel: "off",
      bootstrap: "minimal",
      enhancements: [],
    });
    const text = lines.join("\n");
    expect(text).not.toContain("Open the chat UI");
    expect(text).toContain("--agent x");
    expect(text).toContain("gemmaclaw tui x");
    expect(text).toContain("persistent per-agent 127.0.0.1 port");
  });
});

describe("gemmaclaw home path branding", () => {
  const choices = {
    agentName: "main",
    useContainer: false,
    backend: "local" as const,
    model: "auto",
    thinkingLevel: "medium" as const,
    bootstrap: "general" as const,
    enhancements: DEFAULT_ENHANCEMENTS,
  };

  it("formatNextSteps does not mention .openclaw", () => {
    const text = formatNextSteps(choices, "http://127.0.0.1:18789/").join("\n");
    expect(text).not.toContain(".openclaw");
  });

  it("formatNextSteps references .gemmaclaw for workspace paths", () => {
    const text = formatNextSteps(choices).join("\n");
    expect(text).not.toContain("/.openclaw/");
  });

  it("formatChoicesSummary does not mention .openclaw", () => {
    const text = formatChoicesSummary(choices).join("\n");
    expect(text).not.toContain(".openclaw");
  });
});
