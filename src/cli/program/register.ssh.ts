import type { Command } from "commander";
import { agentsSshCommand } from "../../commands/agents.commands.ssh.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

export function registerSshCommand(program: Command) {
  program
    .command("ssh [agent]")
    .description("Open an interactive shell inside a container-backed agent's sandbox")
    .option("--non-interactive", "Fail with usage text if no agent is specified", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["gemmaclaw ssh", "Interactively pick from registered agents (TTY required)."],
          ["gemmaclaw ssh main", "Open a shell in the 'main' agent's running sandbox container."],
          [
            "gemmaclaw ssh work --non-interactive",
            "Non-interactive; fails if no container is running.",
          ],
        ])}\n\n${theme.muted(
          "This opens a container shell via 'docker exec' or 'podman exec', not a network SSH connection.",
        )}\n${theme.muted("Docs:")} ${formatDocsLink("/cli/ssh", "docs.openclaw.ai/cli/ssh")}\n`,
    )
    .action(async (agent: string | undefined, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await agentsSshCommand(
          {
            agent: typeof agent === "string" && agent.trim() ? agent.trim() : undefined,
            nonInteractive: Boolean(opts.nonInteractive),
          },
          defaultRuntime,
        );
      });
    });
}
