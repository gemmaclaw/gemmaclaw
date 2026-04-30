import type { Command } from "commander";
import { agentsListCommand } from "../../commands/agents.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerListCommand(program: Command) {
  program
    .command("list")
    .description("List configured Gemmaclaw instances (agents)")
    .option("--json", "Output JSON instead of text", false)
    .option("--bindings", "Include routing bindings", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Alias for 'gemmaclaw agents list'.")} ${theme.muted("Docs:")} ${formatDocsLink("/cli/list", "docs.openclaw.ai/cli/list")}\n`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await agentsListCommand(
          { json: Boolean(opts.json), bindings: Boolean(opts.bindings), configuredOnly: true },
          defaultRuntime,
        );
      });
    });
}
