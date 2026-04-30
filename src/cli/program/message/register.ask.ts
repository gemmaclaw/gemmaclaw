import { Command } from "commander";
import { messageAskCommand } from "../../../commands/message-ask.js";
import { defaultRuntime } from "../../../runtime.js";
import { theme } from "../../../terminal/theme.js";
import { runCommandWithRuntime } from "../../cli-utils.js";
import { createDefaultDeps } from "../../deps.js";
import { formatHelpExamples } from "../../help-format.js";

export function buildMessageAskCommand(): Command {
  const ask = new Command("ask");
  ask
    .description("Send a message to a Gemmaclaw agent and print the response")
    .argument("[text...]", "Message text (alternative to --text or stdin)")
    .option("--agent <id>", "Target agent id (required if multiple agents are configured)")
    .option("--name <id>", "Alias for --agent")
    .option("--text <text>", "Message body (alternative to positional argument or stdin)")
    .option("--session-id <id>", "Use an explicit session id")
    .option(
      "--thinking <level>",
      "Thinking level: off | minimal | low | medium | high | xhigh | adaptive | max where supported",
    )
    .option("--json", "Output result as JSON", false)
    .option(
      "--timeout <seconds>",
      "Override agent command timeout (seconds, default 600 or config value)",
    )
    .option("--local", "Run the embedded agent locally instead of via the gateway", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ['gemmaclaw message --agent dev "Summarize today\'s news"', "Send a one-shot message."],
          ['echo "what is 2+2?" | gemmaclaw message --agent dev', "Pipe message via stdin."],
          ['gemmaclaw message --agent dev --text "hi" --json', "Get JSON response."],
        ])}\n`,
    )
    .action(async (textArgs: string[] | undefined, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const positional = Array.isArray(textArgs) ? textArgs : [];
        const agent =
          (typeof opts.agent === "string" && opts.agent.trim()) ||
          (typeof opts.name === "string" && opts.name.trim()) ||
          undefined;
        const deps = createDefaultDeps();
        await messageAskCommand(
          {
            text: opts.text as string | undefined,
            agent,
            sessionId: opts.sessionId as string | undefined,
            thinking: opts.thinking as string | undefined,
            json: Boolean(opts.json),
            timeout: opts.timeout as string | undefined,
            local: Boolean(opts.local),
          },
          defaultRuntime,
          { positional },
          deps,
        );
      });
    });
  return ask;
}

export function registerMessageAskCommand(message: Command): Command {
  const ask = buildMessageAskCommand();
  message.addCommand(ask, { isDefault: true });
  return ask;
}
