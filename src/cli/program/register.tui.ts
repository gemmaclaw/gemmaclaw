import type { Command } from "commander";
import { launchTuiAgent } from "../../commands/agents.commands.tui.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";

async function defaultPickAgent(agents: string[]): Promise<string | undefined> {
  const prompter = createClackPrompter();
  const choice = await prompter.select({
    message: "Pick a Gemmaclaw instance to open",
    options: agents.map((id) => ({ value: id, label: id })),
  });
  return typeof choice === "string" ? choice : undefined;
}

export function registerTuiCommand(program: Command) {
  program
    .command("tui [agent]")
    .description("Open a local TUI/chat for a named Gemmaclaw agent")
    .option("--agent <id>", "Agent id (alias for the positional argument)")
    .option(
      "--port <port>",
      "Host port for container-backed agents (default: derived from agent id)",
    )
    .option("--no-open", "For container agents: print URL but do not open browser automatically")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Examples:")}\n` +
        `  ${theme.muted("gemmaclaw tui work              # terminal TUI for host-local agent 'work'")}\n` +
        `  ${theme.muted("gemmaclaw tui                   # interactive picker (when multiple agents configured)")}\n` +
        `  ${theme.muted("gemmaclaw tui play --port 9120  # override container localhost port for 'play'")}\n\n` +
        `  ${theme.muted("Host-local agents open the terminal TUI; Docker-backed agents open browser chat on 127.0.0.1.")}\n` +
        `  ${theme.muted("Separate agents get persistent ports in ~/.gemmaclaw/state/tui-ports.json.")}\n` +
        `\n${theme.muted("Docs:")} ${formatDocsLink("https://gemmaclaw.github.io/gemmaclaw/#cmd-tui", "gemmaclaw.github.io/gemmaclaw/#cmd-tui")}\n`,
    )
    .action(async (positionalAgent: string | undefined, opts) => {
      try {
        // Accept positional arg OR --agent flag.
        const rawAgent =
          (typeof positionalAgent === "string" && positionalAgent.trim()
            ? positionalAgent.trim()
            : undefined) ??
          (typeof opts.agent === "string" && opts.agent.trim() ? opts.agent.trim() : undefined);

        const overridePort = opts.port ? Number.parseInt(String(opts.port), 10) : undefined;
        if (opts.port !== undefined && (overridePort === undefined || Number.isNaN(overridePort))) {
          defaultRuntime.error(`Invalid --port: "${String(opts.port)}"`);
          defaultRuntime.exit(1);
          return;
        }

        const isTty = (process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false);

        await launchTuiAgent({
          agentArg: rawAgent,
          port: overridePort,
          openBrowser: opts.open !== false,
          deps: { isTty, pickAgent: defaultPickAgent },
        });
      } catch (err) {
        const msg = String(err);
        // Surface user-friendly hints for common errors.
        if (msg.includes("No agents configured")) {
          defaultRuntime.error(msg);
          defaultRuntime.error("  Run: gemmaclaw setup");
          defaultRuntime.error("  Or:  gemmaclaw create <name>");
        } else if (
          msg.includes("Pass --agent") ||
          msg.includes("Multiple agents") ||
          msg.includes("No agent specified")
        ) {
          defaultRuntime.error(msg);
          defaultRuntime.error("  Run: gemmaclaw list  to see available agents");
        } else {
          defaultRuntime.error(msg);
        }
        defaultRuntime.exit(1);
      }
    });
}
