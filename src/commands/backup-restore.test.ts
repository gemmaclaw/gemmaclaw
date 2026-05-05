import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { backupRestoreCommand } from "./backup-restore.js";
import { backupCreateCommand } from "./backup.js";

function createBackupTestRuntime(): RuntimeEnv {
  return {
    log: () => {},
    error: () => {},
    exit: () => {},
  } satisfies RuntimeEnv;
}

describe("backupRestoreCommand", () => {
  let tempHome: TempHomeEnv;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-restore-test-");
  });

  beforeEach(async () => {
    await fs.rm(tempHome.home, { recursive: true, force: true });
    await fs.mkdir(path.join(tempHome.home, ".openclaw"), { recursive: true });
    process.env.OPENCLAW_STATE_DIR = path.join(tempHome.home, ".openclaw");
    delete process.env.OPENCLAW_CONFIG_PATH;
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  async function createSourceArchive() {
    const sourceState = path.join(tempHome.home, ".openclaw");
    const workspaceDir = path.join(sourceState, "workspaces", "main");
    const sharedDir = path.join(sourceState, "shared");
    const credentialsDir = path.join(sourceState, "credentials");
    const archiveDir = path.join(tempHome.home, "archives");

    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceState, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "# agent\n", "utf8");
    await fs.writeFile(path.join(sharedDir, "shared.txt"), "shared-data\n", "utf8");
    await fs.writeFile(path.join(credentialsDir, "oauth.json"), '{"ok":true}\n', "utf8");

    return await backupCreateCommand(createBackupTestRuntime(), {
      output: archiveDir,
      includeWorkspace: true,
      nowMs: Date.UTC(2026, 4, 5, 1, 0, 0),
    });
  }

  it("restores a full state archive into a new target directory", async () => {
    const archive = await createSourceArchive();
    const target = path.join(tempHome.home, ".gemmaclaw-restored");
    await fs.rm(path.join(tempHome.home, ".openclaw"), { recursive: true, force: true });

    const result = await backupRestoreCommand(createBackupTestRuntime(), {
      archive: archive.archivePath,
      target,
    });

    expect(result.ok).toBe(true);
    expect(result.targetDir).toBe(target);
    expect(result.restoredAssets.map((asset) => asset.kind)).toContain("state");
    expect(await fs.readFile(path.join(target, "openclaw.json"), "utf8")).toContain("workspaces");
    expect(await fs.readFile(path.join(target, "workspaces", "main", "AGENTS.md"), "utf8")).toBe(
      "# agent\n",
    );
    expect(await fs.readFile(path.join(target, "shared", "shared.txt"), "utf8")).toBe(
      "shared-data\n",
    );
    expect(await fs.readFile(path.join(target, "credentials", "oauth.json"), "utf8")).toBe(
      '{"ok":true}\n',
    );
  });

  it("dry-runs restore without writing the target", async () => {
    const archive = await createSourceArchive();
    const target = path.join(tempHome.home, ".dry-run-restored");

    const result = await backupRestoreCommand(createBackupTestRuntime(), {
      archive: archive.archivePath,
      target,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("refuses to overwrite a non-empty target unless --force is set", async () => {
    const archive = await createSourceArchive();
    const target = path.join(tempHome.home, ".occupied-restored");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "existing.txt"), "existing\n", "utf8");

    await expect(
      backupRestoreCommand(createBackupTestRuntime(), {
        archive: archive.archivePath,
        target,
      }),
    ).rejects.toThrow(/already exists and is not empty/i);

    const result = await backupRestoreCommand(createBackupTestRuntime(), {
      archive: archive.archivePath,
      target,
      force: true,
    });

    expect(result.previousTargetPath).toBeDefined();
    expect(await fs.readFile(path.join(target, "shared", "shared.txt"), "utf8")).toBe(
      "shared-data\n",
    );
    expect(await fs.readFile(path.join(result.previousTargetPath!, "existing.txt"), "utf8")).toBe(
      "existing\n",
    );
  });
});
