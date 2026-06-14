import { describe, expect, it, vi } from "vitest";
import { runGemmaclawSetupSteps, type ExistingConfigAction } from "./merged-setup.gemmaclaw.js";
import { askBackend, buildNonInteractiveChoices, type WizardIO } from "./onboarding-wizard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// askBackend — "extended" backend option
// ---------------------------------------------------------------------------

describe("askBackend — extended option", () => {
  it("returns 'extended' when the user picks option 4 and includeExtended=true", async () => {
    const { io } = makeScriptedIO(["4"]);
    const backend = await askBackend(io, undefined, true);
    expect(backend).toBe("extended");
  });

  it("returns 'extended' when the user types 'extended'", async () => {
    const { io } = makeScriptedIO(["extended"]);
    const backend = await askBackend(io, undefined, true);
    expect(backend).toBe("extended");
  });

  it("does NOT present option 4 when includeExtended=false", async () => {
    // Option 4 with includeExtended=false → invalid, triggers re-prompt.
    // We provide an invalid answer first, then a valid one to avoid infinite loop.
    const { io, logs } = makeScriptedIO(["4", "1"]);
    const backend = await askBackend(io, undefined, false);
    // Should have re-prompted (logged an error or re-asked) and resolved to "local"
    expect(backend).toBe("local");
    const joined = logs.join("\n");
    expect(joined).not.toContain("Extended options");
  });

  it("still shows options 1-3 when includeExtended=true", async () => {
    const { io, logs } = makeScriptedIO(["1"]);
    await askBackend(io, undefined, true);
    const joined = logs.join("\n");
    expect(joined).toContain("1)");
    expect(joined).toContain("2)");
    expect(joined).toContain("3)");
    expect(joined).toContain("4)");
  });
});

// ---------------------------------------------------------------------------
// buildNonInteractiveChoices — handles "extended"
// ---------------------------------------------------------------------------

describe("buildNonInteractiveChoices — extended backend", () => {
  it("includes 'extended' as a valid backend", () => {
    const choices = buildNonInteractiveChoices({ backend: "extended" });
    expect(choices.backend).toBe("extended");
    expect(choices.model).toBe("");
  });
});

// ---------------------------------------------------------------------------
// runGemmaclawSetupSteps — no existing config
// ---------------------------------------------------------------------------

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: vi.fn().mockResolvedValue({ exists: false, valid: false, config: null }),
}));

describe("runGemmaclawSetupSteps — no existing config", () => {
  it("walks the user through all Gemmaclaw prompts (local backend)", async () => {
    const { io } = makeScriptedIO([
      "", // agent name → main
      "", // container → yes
      "", // backend → 1 (local)
      "", // model → auto
      "", // thinking → medium
      "", // bootstrap → general
      "", // enhancements → defaults
    ]);

    const result = await runGemmaclawSetupSteps(io, {}, { skipExistingConfigCheck: true });

    expect(result.existingConfigAction).toBeNull();
    expect(result.choices).toMatchObject({
      agentName: "main",
      useContainer: true,
      backend: "local",
      thinkingLevel: "medium",
      bootstrap: "general",
    });
  });

  it("returns 'extended' backend when user picks option 4", async () => {
    const { io } = makeScriptedIO([
      "myagent", // agent name
      "2", // host (no container)
      "4", // extended backend
      "", // thinking → medium
      "", // bootstrap → general
      "", // enhancements → defaults
    ]);

    const result = await runGemmaclawSetupSteps(
      io,
      {},
      {
        skipExistingConfigCheck: true,
        includeExtended: true,
      },
    );

    expect(result.choices.backend).toBe("extended");
    expect(result.choices.model).toBe(""); // no model prompt for extended
    expect(result.choices.agentName).toBe("myagent");
  });

  it("skips prompts for fields where preset defaults are provided", async () => {
    // When backend preset is set, askBackend skips the prompt entirely.
    const { io, prompts } = makeScriptedIO([
      // name, container, backend prompts skipped by presets
      "", // model
      "", // thinking
      "", // bootstrap
      "", // enhancements
    ]);

    const result = await runGemmaclawSetupSteps(
      io,
      { agentName: "main", backend: "vertex", useContainer: true },
      { skipExistingConfigCheck: true },
    );

    expect(result.choices.backend).toBe("vertex");
    // 4 prompts: model, thinking, bootstrap, enhancements
    // (name, container, backend all skipped because presets were supplied)
    expect(prompts).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// runGemmaclawSetupSteps — existing config: "keep"
// ---------------------------------------------------------------------------

describe("runGemmaclawSetupSteps — existing config action", () => {
  it("skips wizard prompts when user chooses 'keep'", async () => {
    // First prompt = existing config action (keep=1), then no more prompts.
    const { io } = makeScriptedIO(["1"]);

    const fakeExistingConfig = { gateway: { mode: "local" as const } };
    const result = await runGemmaclawSetupSteps(
      io,
      {},
      {
        existingConfig: fakeExistingConfig as import("../../config/config.js").OpenClawConfig,
      },
    );

    expect(result.existingConfigAction).toBe<ExistingConfigAction>("keep");
    // Should have used non-interactive defaults without asking wizard questions.
    expect(result.choices.agentName).toBe("main");
    expect(result.choices.backend).toBe("local");
  });

  it("re-runs wizard with 'update' and re-prompts the user", async () => {
    // answer "2" to keep/update/reset → then wizard prompts
    const { io } = makeScriptedIO([
      "2", // update
      "", // agent name → main
      "", // container → yes
      "", // backend → local
      "", // model
      "", // thinking
      "", // bootstrap
      "", // enhancements
    ]);

    const fakeExistingConfig = { gateway: { mode: "local" as const } };
    const result = await runGemmaclawSetupSteps(
      io,
      {},
      {
        existingConfig: fakeExistingConfig as import("../../config/config.js").OpenClawConfig,
      },
    );

    expect(result.existingConfigAction).toBe<ExistingConfigAction>("update");
    expect(result.choices.backend).toBe("local");
  });

  it("starts fresh on 'reset'", async () => {
    const { io } = makeScriptedIO([
      "3", // reset
      "", // agent name
      "", // container
      "", // backend
      "", // model
      "", // thinking
      "", // bootstrap
      "", // enhancements
    ]);

    const fakeExistingConfig = { gateway: { mode: "local" as const } };
    const result = await runGemmaclawSetupSteps(
      io,
      {},
      {
        existingConfig: fakeExistingConfig as import("../../config/config.js").OpenClawConfig,
      },
    );

    expect(result.existingConfigAction).toBe<ExistingConfigAction>("reset");
    expect(result.choices.agentName).toBe("main");
  });

  it("returns null existingConfigAction when there is no existing config", async () => {
    const { io } = makeScriptedIO(["", "", "", "", "", "", ""]);
    const result = await runGemmaclawSetupSteps(io, {}, { existingConfig: null });
    expect(result.existingConfigAction).toBeNull();
  });
});
