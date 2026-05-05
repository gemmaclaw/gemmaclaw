import type { Command } from "commander";
import { backupRestoreCommand } from "../../commands/backup-restore.js";
import { backupVerifyCommand } from "../../commands/backup-verify.js";
import { backupCreateCommand } from "../../commands/backup.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

export function registerBackupCommand(program: Command) {
  const cliName = resolveCliName();
  const productName = cliName === "openclaw" ? "OpenClaw" : "Gemmaclaw";
  const cmd = (command: string) => replaceCliName(command, cliName);
  const docsLink =
    cliName === "openclaw"
      ? formatDocsLink("/cli/backup", "docs.openclaw.ai/cli/backup")
      : formatDocsLink(
          "https://gemmaclaw.github.io/gemmaclaw/setup.html#cmd-backup",
          "gemmaclaw.github.io/gemmaclaw/setup.html#cmd-backup",
        );
  const backup = program
    .command("backup")
    .description(`Create and verify local backup archives for ${productName} state`)
    .addHelpText("after", () => `\n${theme.muted("Docs:")} ${docsLink}\n`);

  backup
    .command("create")
    .description("Write a backup archive for config, credentials, sessions, and workspaces")
    .option("--output <path>", "Archive path or destination directory")
    .option("--json", "Output JSON", false)
    .option("--dry-run", "Print the backup plan without writing the archive", false)
    .option("--verify", "Verify the archive after writing it", false)
    .option("--only-config", "Back up only the active JSON config file", false)
    .option("--no-include-workspace", "Exclude workspace directories from the backup")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [cmd("openclaw backup create"), "Create a timestamped backup in the current directory."],
          [
            cmd("openclaw backup create --output ~/Backups"),
            "Write the archive into an existing backup directory.",
          ],
          [
            cmd("openclaw backup create --dry-run --json"),
            "Preview the archive plan without writing any files.",
          ],
          [
            cmd("openclaw backup create --verify"),
            "Create the archive and immediately validate its manifest and payload layout.",
          ],
          [
            cmd("openclaw backup create --no-include-workspace"),
            "Back up state/config without agent workspace files.",
          ],
          [
            cmd("openclaw backup create --only-config"),
            "Back up only the active JSON config file.",
          ],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupCreateCommand(defaultRuntime, {
          output: opts.output as string | undefined,
          json: Boolean(opts.json),
          dryRun: Boolean(opts.dryRun),
          verify: Boolean(opts.verify),
          onlyConfig: Boolean(opts.onlyConfig),
          includeWorkspace: opts.includeWorkspace as boolean,
        });
      });
    });

  backup
    .command("verify <archive>")
    .description("Validate a backup archive and its embedded manifest")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            cmd("openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz"),
            "Check that the archive structure and manifest are intact.",
          ],
          [
            cmd("openclaw backup verify ~/Backups/latest.tar.gz --json"),
            "Emit machine-readable verification output.",
          ],
        ])}`,
    )
    .action(async (archive, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupVerifyCommand(defaultRuntime, {
          archive: archive as string,
          json: Boolean(opts.json),
        });
      });
    });

  backup
    .command("restore <archive>")
    .alias("recover")
    .description(`Restore a backup archive into a ${productName} state directory`)
    .option("--target <path>", "State directory to restore into (default: active state directory)")
    .option("--force", "Move an existing non-empty target aside before restoring", false)
    .option(
      "--dry-run",
      "Validate the archive and print the restore plan without writing files",
      false,
    )
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            cmd("openclaw backup restore ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz"),
            "Restore into the active state directory when it is empty.",
          ],
          [
            cmd("openclaw backup restore ./backup.tar.gz --target ~/.gemmaclaw-restored"),
            `Restore into a new ${productName} state directory for inspection.`,
          ],
          [
            cmd("openclaw backup restore ./backup.tar.gz --force"),
            "Move the existing active state aside, then restore atomically.",
          ],
          [
            cmd("openclaw backup restore ./backup.tar.gz --dry-run --json"),
            "Validate the archive and emit the restore plan without writing files.",
          ],
        ])}`,
    )
    .action(async (archive, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupRestoreCommand(defaultRuntime, {
          archive: archive as string,
          target: opts.target as string | undefined,
          force: Boolean(opts.force),
          dryRun: Boolean(opts.dryRun),
          json: Boolean(opts.json),
        });
      });
    });
}
