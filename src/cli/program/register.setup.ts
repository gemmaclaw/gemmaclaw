import type { Command } from "commander";
import { setupWizardCommand } from "../../commands/onboard.js";
import { setupCommand } from "../../commands/setup.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { hasExplicitOptions } from "../command-options.js";

export function registerSetupCommand(program: Command) {
  program
    .command("setup")
    .description("Set up a local Gemma backend (auto-detects hardware, provisions, and verifies)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/setup", "docs.openclaw.ai/cli/setup")}\n`,
    )
    .option(
      "--workspace <dir>",
      "Agent workspace directory (default: ~/.openclaw/workspace; stored as agents.defaults.workspace)",
    )
    .option(
      "--advanced",
      "Run interactive advanced setup with manual backend/model/port selection",
      false,
    )
    .option(
      "--no-container",
      "Run the gateway directly on the host instead of inside a Docker container",
    )
    .option("--workspace-only", "Only initialize workspace config (skip Gemma provisioning)", false)
    .option("--vertex", "Set up Vertex AI as the backend (requires gcloud CLI)", false)
    .option("--vertex-project <id>", "GCP project ID for Vertex AI")
    .option("--vertex-region <region>", "GCP region for Vertex AI (default: us-central1)")
    .option("--vertex-model <model>", "Gemma model on Vertex AI (e.g. gemma-3-27b-it)")
    .option("--wizard", "Run interactive onboarding (workspace config)", false)
    .option("--non-interactive", "Run onboarding without prompts", false)
    .option(
      "--accept-risk",
      "Acknowledge agent system-access risk (required for --non-interactive onboarding)",
      false,
    )
    .option("--mode <mode>", "Onboard mode: local|remote")
    .option("--remote-url <url>", "Remote Gateway WebSocket URL")
    .option("--remote-token <token>", "Remote Gateway token (optional)")
    .action(async (opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        // gemmaclaw: route to Gemma setup wizard by default.
        // Use --workspace-only or --wizard to get the original OpenClaw setup behavior.
        const hasWorkspaceOnlyFlags = hasExplicitOptions(command, [
          "wizard",
          "nonInteractive",
          "acceptRisk",
          "mode",
          "remoteUrl",
          "remoteToken",
        ]);
        if (opts.workspaceOnly || opts.wizard || hasWorkspaceOnlyFlags) {
          if (opts.wizard || hasWorkspaceOnlyFlags) {
            await setupWizardCommand(
              {
                workspace: opts.workspace as string | undefined,
                nonInteractive: Boolean(opts.nonInteractive),
                acceptRisk: Boolean(opts.acceptRisk),
                mode: opts.mode as "local" | "remote" | undefined,
                remoteUrl: opts.remoteUrl as string | undefined,
                remoteToken: opts.remoteToken as string | undefined,
              },
              defaultRuntime,
            );
          } else {
            await setupCommand({ workspace: opts.workspace as string | undefined }, defaultRuntime);
          }
          return;
        }

        // Vertex AI setup
        if (opts.vertex) {
          const { interactiveVertexSetup, buildVertexConfig } =
            await import("../../gemmaclaw/provision/vertex-setup.js");
          const { writeConfigFile } = await import("../../config/config.js");
          const fs = await import("node:fs");
          const path = await import("node:path");

          const result = await interactiveVertexSetup({
            project: opts.vertexProject as string | undefined,
            region: opts.vertexRegion as string | undefined,
            model: opts.vertexModel as string | undefined,
            nonInteractive: Boolean(opts.nonInteractive),
          });
          if (!result.ok || !result.config) {
            console.error(`\nVertex AI setup failed: ${result.error}`);
            process.exit(1);
          }

          // Write config
          const vertexConfigPatch = buildVertexConfig(result.config);
          await writeConfigFile(vertexConfigPatch);
          console.log("\nConfig updated with Vertex AI provider.");

          // Write auth profile with gcloud access token
          if (result.config.accessToken) {
            const homeDir = process.env.OPENCLAW_HOME ?? process.env.HOME ?? "/root";
            const authPath = path.join(homeDir, ".openclaw/agents/main/agent/auth-profiles.json");
            let existing: Record<string, unknown> = { version: 1, profiles: {} };
            try {
              existing = JSON.parse(fs.readFileSync(authPath, "utf-8"));
            } catch {
              /* first time */
            }
            const profiles = (existing.profiles ?? {}) as Record<string, unknown>;
            profiles["google-vertex:gcloud"] = {
              type: "token",
              provider: "google-vertex",
              token: result.config.accessToken,
            };
            existing.profiles = profiles;
            fs.mkdirSync(path.dirname(authPath), { recursive: true });
            fs.writeFileSync(authPath, JSON.stringify(existing, null, 2));
            console.log("Auth profile saved (google-vertex:gcloud).");
            console.log(
              "\nNote: Access tokens expire in ~1 hour. " +
                "Run 'gemmaclaw setup --vertex' again to refresh, " +
                "or set GOOGLE_APPLICATION_CREDENTIALS for auto-refresh.",
            );
          }

          console.log(
            `\nVertex AI ready: ${result.config.model} on ${result.config.project} (${result.config.region})`,
          );
          console.log("Test it: gemmaclaw agent --local --message 'Hello'");
          return;
        }

        // Default: Gemma setup wizard.
        const { setupGemmaCommand } = await import("../../commands/setup-gemma.js");
        await setupGemmaCommand(
          { advanced: Boolean(opts.advanced), noContainer: opts.container === false },
          defaultRuntime,
        );
      });
    });
}
