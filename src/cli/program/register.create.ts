import type { Command } from "commander";
import { createCommand } from "../../commands/create.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { hasExplicitOptions } from "../command-options.js";
import { formatHelpExamples } from "../help-format.js";

export function registerCreateCommand(program: Command) {
  program
    .command("create [name]")
    .description("Create a new Gemmaclaw instance (named, isolated agent)")
    .option("--name <id>", "Agent name/id (alternative to the positional argument)")
    .option(
      "--workspace <dir>",
      "Workspace directory for this instance (default: ~/.openclaw/workspace/<name>)",
    )
    .option("--model <id>", "Model id for this instance (e.g. ollama/gemma3:4b)")
    .option("--agent-dir <dir>", "Agent state directory")
    .option("--non-interactive", "Disable prompts. Requires --name (or positional name).", false)
    .option("--json", "Output JSON summary", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["gemmaclaw create work", "Create a 'work' instance interactively."],
          [
            "gemmaclaw create dev --model ollama/gemma3:4b --workspace ~/.openclaw/workspace/dev",
            "Non-interactive create with explicit model + workspace.",
          ],
          [
            "gemmaclaw create play --non-interactive",
            "Create using all defaults (workspace defaults to ~/.openclaw/workspace/<name>).",
          ],
        ])}\n\n${theme.muted(
          "Each instance gets its own workspace, sessions, and auth profiles. Provision the Gemma backend first with 'gemmaclaw setup' if you have not already.",
        )}\n${theme.muted("Docs:")} ${formatDocsLink("/cli/create", "docs.openclaw.ai/cli/create")}\n`,
    )
    .action(async (name: string | undefined, opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const hasFlags = hasExplicitOptions(command, [
          "name",
          "workspace",
          "model",
          "agentDir",
          "nonInteractive",
          "json",
        ]);
        const resolvedName =
          (typeof name === "string" && name.trim()) ||
          (typeof opts.name === "string" && opts.name.trim()) ||
          undefined;
        await createCommand(
          {
            name: resolvedName,
            workspace: opts.workspace as string | undefined,
            model: opts.model as string | undefined,
            agentDir: opts.agentDir as string | undefined,
            nonInteractive: Boolean(opts.nonInteractive),
            json: Boolean(opts.json),
          },
          defaultRuntime,
          { hasFlags },
        );
      });
    });
}
