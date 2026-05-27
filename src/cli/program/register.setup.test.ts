import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSetupCommand } from "./register.setup.js";

const mocks = vi.hoisted(() => ({
  setupCommandMock: vi.fn(),
  setupWizardCommandMock: vi.fn(),
  setupGemmaCommandMock: vi.fn(),
  runVertexSetupCommandMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const setupCommandMock = mocks.setupCommandMock;
const setupWizardCommandMock = mocks.setupWizardCommandMock;
const setupGemmaCommandMock = mocks.setupGemmaCommandMock;
const runVertexSetupCommandMock = mocks.runVertexSetupCommandMock;
const runtime = mocks.runtime;

vi.mock("../../commands/setup.js", () => ({
  setupCommand: mocks.setupCommandMock,
}));

vi.mock("../../commands/onboard.js", () => ({
  setupWizardCommand: mocks.setupWizardCommandMock,
}));

vi.mock("../../commands/setup-gemma.js", () => ({
  setupGemmaCommand: mocks.setupGemmaCommandMock,
}));

vi.mock("../../gemmaclaw/provision/vertex-command.js", () => ({
  runVertexSetupCommand: mocks.runVertexSetupCommandMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerSetupCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSetupCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupCommandMock.mockResolvedValue(undefined);
    setupWizardCommandMock.mockResolvedValue(undefined);
    setupGemmaCommandMock.mockResolvedValue(undefined);
    runVertexSetupCommandMock.mockResolvedValue(undefined);
  });

  it("runs Gemma setup wizard by default", async () => {
    await runCli(["setup"]);

    expect(setupGemmaCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ advanced: false }),
      runtime,
    );
    expect(setupCommandMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("passes dryRun: false when --dry-run flag is absent (env-var override handled inside setupGemmaCommand)", async () => {
    await runCli(["setup"]);

    expect(setupGemmaCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false }),
      runtime,
    );
  });

  it("runs Gemma setup wizard in advanced mode with --advanced", async () => {
    await runCli(["setup", "--advanced"]);

    expect(setupGemmaCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ advanced: true }),
      runtime,
    );
  });

  it("runs workspace-only setup with --workspace-only", async () => {
    await runCli(["setup", "--workspace-only", "--workspace", "/tmp/ws"]);

    expect(setupCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/tmp/ws" }),
      runtime,
    );
    expect(setupGemmaCommandMock).not.toHaveBeenCalled();
  });

  it("runs setup wizard command when --wizard is set", async () => {
    await runCli(["setup", "--wizard", "--mode", "remote", "--remote-url", "wss://example"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "remote",
        remoteUrl: "wss://example",
      }),
      runtime,
    );
    expect(setupCommandMock).not.toHaveBeenCalled();
    expect(setupGemmaCommandMock).not.toHaveBeenCalled();
  });

  it("runs setup wizard command when wizard-only flags are passed explicitly", async () => {
    await runCli(["setup", "--mode", "remote", "--non-interactive", "--accept-risk"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "remote",
        nonInteractive: true,
        acceptRisk: true,
      }),
      runtime,
    );
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("reports Gemma setup errors through runtime", async () => {
    setupGemmaCommandMock.mockRejectedValueOnce(new Error("setup failed"));

    await runCli(["setup"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: setup failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("forwards onboarding flags to the Gemma setup command", async () => {
    await runCli([
      "setup",
      "--agent-name",
      "ci-bot",
      "--setup-mode",
      "gemini",
      "--model",
      "google/gemini-2.5-pro",
      "--thinking",
      "high",
      "--bootstrap",
      "coding",
      "--enhancements",
      "external_delivery_receipt_verification",
      "--dry-run",
    ]);

    expect(setupGemmaCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "ci-bot",
        setupMode: "gemini",
        model: "google/gemini-2.5-pro",
        thinking: "high",
        bootstrap: "coding",
        enhancements: "external_delivery_receipt_verification",
        dryRun: true,
      }),
      runtime,
    );
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("routes to Gemma setup when --non-interactive is combined with onboarding flags", async () => {
    await runCli(["setup", "--non-interactive", "--setup-mode", "local", "--bootstrap", "minimal"]);

    expect(setupGemmaCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        setupMode: "local",
        bootstrap: "minimal",
      }),
      runtime,
    );
    // Workspace wizard must not be invoked when gemma flags are present.
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("forwards --no-enhancements as an explicit disabled enhancement selection", async () => {
    await runCli(["setup", "--non-interactive", "--setup-mode", "local", "--no-enhancements"]);

    expect(setupGemmaCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nonInteractive: true,
        setupMode: "local",
        enhancements: "none",
      }),
      runtime,
    );
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("routes direct Vertex setup through the Gemmaclaw Vertex command helper", async () => {
    await runCli([
      "setup",
      "--vertex",
      "--agent-name",
      "vertex-bot",
      "--vertex-project",
      "proj",
      "--vertex-region",
      "us-central1",
      "--vertex-model",
      "gemma-4-31b-it",
      "--vertex-api-format",
      "openai",
      "--vertex-dedicated-url",
      "https://vertex.example/v1",
      "--non-interactive",
      "--no-enhancements",
    ]);

    expect(runVertexSetupCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "vertex-bot",
        nonInteractive: true,
        enhancements: "none",
      }),
      expect.objectContaining({
        project: "proj",
        region: "us-central1",
        model: "gemma-4-31b-it",
        apiFormat: "openai",
        dedicatedUrl: "https://vertex.example/v1",
      }),
      runtime,
    );
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expect(setupGemmaCommandMock).not.toHaveBeenCalled();
  });

  it("ignores invalid enum values for --thinking / --bootstrap / --setup-mode", async () => {
    await runCli(["setup", "--setup-mode", "bogus", "--thinking", "ultra", "--bootstrap", "weird"]);

    expect(setupGemmaCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        setupMode: undefined,
        thinking: undefined,
        bootstrap: undefined,
      }),
      runtime,
    );
  });
});
