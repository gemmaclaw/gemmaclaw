import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { resolveStateDir } from "../config/config.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { readStringValue } from "../shared/string-coerce.js";
import { isRecord, resolveUserPath, shortenHomePath } from "../utils.js";
import { isPathWithin } from "./cleanup-utils.js";

const WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE = /^[A-Za-z]:[\\/]/;

type BackupManifestAsset = {
  kind: string;
  sourcePath: string;
  archivePath: string;
};

type BackupManifest = {
  schemaVersion: number;
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: string;
  nodeVersion: string;
  options?: {
    includeWorkspace?: boolean;
    onlyConfig?: boolean;
  };
  paths?: {
    stateDir?: string;
    configPath?: string;
    oauthDir?: string;
    workspaceDirs?: string[];
  };
  assets: BackupManifestAsset[];
};

export type BackupRestoreOptions = {
  archive: string;
  target?: string;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

export type BackupRestoreResult = {
  ok: true;
  archivePath: string;
  archiveRoot: string;
  createdAt: string;
  targetDir: string;
  dryRun: boolean;
  forced: boolean;
  previousTargetPath?: string;
  restoredAssets: Array<{
    kind: string;
    sourcePath: string;
    archivePath: string;
    targetPath: string;
  }>;
};

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizeArchivePath(entryPath: string, label: string): string {
  const trimmed = stripTrailingSlashes(entryPath.trim());
  if (!trimmed) {
    throw new Error(`${label} is empty.`);
  }
  if (trimmed.startsWith("/") || WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE.test(trimmed)) {
    throw new Error(`${label} must be relative: ${entryPath}`);
  }
  if (trimmed.includes("\\")) {
    throw new Error(`${label} must use forward slashes: ${entryPath}`);
  }
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} contains path traversal segments: ${entryPath}`);
  }

  const normalized = stripTrailingSlashes(path.posix.normalize(trimmed));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} resolves outside the archive root: ${entryPath}`);
  }
  return normalized;
}

function normalizeArchiveRoot(rootName: string): string {
  const normalized = normalizeArchivePath(rootName, "Backup manifest archiveRoot");
  if (normalized.includes("/")) {
    throw new Error(`Backup manifest archiveRoot must be a single path segment: ${rootName}`);
  }
  return normalized;
}

function isArchivePathWithin(child: string, parent: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === "" || (!relative.startsWith("../") && relative !== "..");
}

function parseManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Backup manifest is not valid JSON: ${String(err)}`, { cause: err });
  }

  if (!isRecord(parsed)) {
    throw new Error("Backup manifest must be an object.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported backup manifest schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (typeof parsed.archiveRoot !== "string" || !parsed.archiveRoot.trim()) {
    throw new Error("Backup manifest is missing archiveRoot.");
  }
  if (typeof parsed.createdAt !== "string" || !parsed.createdAt.trim()) {
    throw new Error("Backup manifest is missing createdAt.");
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error("Backup manifest is missing assets.");
  }

  const assets: BackupManifestAsset[] = [];
  for (const asset of parsed.assets) {
    if (!isRecord(asset)) {
      throw new Error("Backup manifest contains a non-object asset.");
    }
    if (typeof asset.kind !== "string" || !asset.kind.trim()) {
      throw new Error("Backup manifest asset is missing kind.");
    }
    if (typeof asset.sourcePath !== "string" || !asset.sourcePath.trim()) {
      throw new Error("Backup manifest asset is missing sourcePath.");
    }
    if (typeof asset.archivePath !== "string" || !asset.archivePath.trim()) {
      throw new Error("Backup manifest asset is missing archivePath.");
    }
    assets.push({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
    });
  }

  return {
    schemaVersion: 1,
    archiveRoot: parsed.archiveRoot,
    createdAt: parsed.createdAt,
    runtimeVersion:
      typeof parsed.runtimeVersion === "string" && parsed.runtimeVersion.trim()
        ? parsed.runtimeVersion
        : "unknown",
    platform: typeof parsed.platform === "string" ? parsed.platform : "unknown",
    nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : "unknown",
    options: isRecord(parsed.options)
      ? {
          includeWorkspace: parsed.options.includeWorkspace as boolean | undefined,
          onlyConfig: parsed.options.onlyConfig as boolean | undefined,
        }
      : undefined,
    paths: isRecord(parsed.paths)
      ? {
          stateDir: readStringValue(parsed.paths.stateDir),
          configPath: readStringValue(parsed.paths.configPath),
          oauthDir: readStringValue(parsed.paths.oauthDir),
          workspaceDirs: Array.isArray(parsed.paths.workspaceDirs)
            ? parsed.paths.workspaceDirs.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : undefined,
        }
      : undefined,
    assets,
  };
}

async function listArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push(entry.path);
    },
  });
  return entries;
}

async function extractManifest(params: {
  archivePath: string;
  manifestEntryPath: string;
}): Promise<string> {
  let manifestContentPromise: Promise<string> | undefined;
  await tar.t({
    file: params.archivePath,
    gzip: true,
    onentry: (entry) => {
      if (entry.path !== params.manifestEntryPath) {
        entry.resume();
        return;
      }

      manifestContentPromise = new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        entry.on("error", reject);
        entry.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      });
    },
  });

  if (!manifestContentPromise) {
    throw new Error(`Archive is missing manifest entry: ${params.manifestEntryPath}`);
  }
  return await manifestContentPromise;
}

function isRootManifestEntry(entryPath: string): boolean {
  const parts = entryPath.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] === "manifest.json";
}

function findDuplicateNormalizedEntryPath(
  entries: Array<{ normalized: string }>,
): string | undefined {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.normalized)) {
      return entry.normalized;
    }
    seen.add(entry.normalized);
  }
  return undefined;
}

async function readArchiveManifest(archivePath: string): Promise<{
  manifest: BackupManifest;
  entries: Set<string>;
}> {
  const rawEntries = await listArchiveEntries(archivePath);
  if (rawEntries.length === 0) {
    throw new Error("Backup archive is empty.");
  }

  const entries = rawEntries.map((entry) => ({
    raw: entry,
    normalized: normalizeArchivePath(entry, "Archive entry"),
  }));
  const duplicateEntryPath = findDuplicateNormalizedEntryPath(entries);
  if (duplicateEntryPath) {
    throw new Error(`Archive contains duplicate entry path: ${duplicateEntryPath}`);
  }

  const manifestMatches = entries.filter((entry) => isRootManifestEntry(entry.normalized));
  if (manifestMatches.length !== 1) {
    throw new Error(`Expected exactly one backup manifest entry, found ${manifestMatches.length}.`);
  }

  const manifestEntryPath = manifestMatches[0]?.raw;
  if (!manifestEntryPath) {
    throw new Error("Backup archive manifest entry could not be resolved.");
  }

  const manifestRaw = await extractManifest({ archivePath, manifestEntryPath });
  const manifest = parseManifest(manifestRaw);
  const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
  const normalizedEntrySet = new Set(entries.map((entry) => entry.normalized));
  const manifestEntryNormalized = path.posix.join(archiveRoot, "manifest.json");
  if (!normalizedEntrySet.has(manifestEntryNormalized)) {
    throw new Error(`Archive is missing manifest entry: ${manifestEntryNormalized}`);
  }
  for (const entry of normalizedEntrySet) {
    if (!isArchivePathWithin(entry, archiveRoot)) {
      throw new Error(`Archive entry is outside the declared archive root: ${entry}`);
    }
  }

  const payloadRoot = path.posix.join(archiveRoot, "payload");
  for (const asset of manifest.assets) {
    const assetArchivePath = normalizeArchivePath(asset.archivePath, "Backup manifest asset path");
    if (!isArchivePathWithin(assetArchivePath, payloadRoot)) {
      throw new Error(`Manifest asset path is outside payload root: ${asset.archivePath}`);
    }
    const exact = normalizedEntrySet.has(assetArchivePath);
    const nested = [...normalizedEntrySet].some(
      (entry) => entry !== assetArchivePath && isArchivePathWithin(entry, assetArchivePath),
    );
    if (!exact && !nested) {
      throw new Error(`Archive is missing payload for manifest asset: ${assetArchivePath}`);
    }
  }

  return { manifest, entries: normalizedEntrySet };
}

async function assertTargetPathSafe(targetDir: string): Promise<string> {
  const resolved = path.resolve(targetDir);
  const home = os.homedir();
  if (resolved === path.parse(resolved).root) {
    throw new Error(`Refusing to restore over filesystem root: ${resolved}`);
  }
  if (home && resolved === path.resolve(home)) {
    throw new Error(`Refusing to restore over the home directory: ${resolved}`);
  }
  return resolved;
}

async function directoryExistsAndIsNonEmpty(targetDir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(targetDir);
    return entries.length > 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function resolveAssetTarget(params: {
  asset: BackupManifestAsset;
  originalStateDir?: string;
  targetDir: string;
}): string {
  const sourcePath = path.resolve(params.asset.sourcePath);
  const originalStateDir = params.originalStateDir ? path.resolve(params.originalStateDir) : "";
  if (params.asset.kind === "state") {
    return params.targetDir;
  }
  if (originalStateDir && isPathWithin(sourcePath, originalStateDir)) {
    return path.join(params.targetDir, path.relative(originalStateDir, sourcePath));
  }
  if (params.asset.kind === "config") {
    return path.join(params.targetDir, "openclaw.json");
  }
  if (params.asset.kind === "credentials") {
    return path.join(params.targetDir, "credentials");
  }
  if (params.asset.kind === "workspace") {
    return path.join(params.targetDir, "workspaces", path.basename(sourcePath));
  }
  return path.join(
    params.targetDir,
    "restored-assets",
    params.asset.kind,
    path.basename(sourcePath),
  );
}

async function uniquePreviousTargetPath(targetDir: string): Promise<string> {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const candidate = `${targetDir}.pre-restore-${stamp}${suffix}`;
    try {
      await fs.access(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        return candidate;
      }
      throw err;
    }
  }
  throw new Error(`Could not find an unused previous-target path for ${targetDir}`);
}

async function moveTargetAsideIfNeeded(params: {
  targetDir: string;
  force: boolean;
}): Promise<string | undefined> {
  const nonEmpty = await directoryExistsAndIsNonEmpty(params.targetDir);
  if (!nonEmpty) {
    await fs.rm(params.targetDir, { recursive: true, force: true });
    return undefined;
  }
  if (!params.force) {
    throw new Error(
      `Restore target already exists and is not empty: ${params.targetDir}. Rerun with --force to move it aside before restoring.`,
    );
  }

  const previousTargetPath = await uniquePreviousTargetPath(params.targetDir);
  await fs.rename(params.targetDir, previousTargetPath);
  return previousTargetPath;
}

async function restoreArchiveToTarget(params: {
  archivePath: string;
  manifest: BackupManifest;
  targetDir: string;
  force: boolean;
}): Promise<BackupRestoreResult["restoredAssets"] & { previousTargetPath?: string }> {
  const archiveRoot = normalizeArchiveRoot(params.manifest.archiveRoot);
  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-restore-"));
  const stageDir = `${params.targetDir}.restore-${randomUUID()}.tmp`;
  let previousTargetPath: string | undefined;
  try {
    await tar.x({
      file: params.archivePath,
      gzip: true,
      cwd: extractDir,
      filter: (entryPath) => {
        const normalized = normalizeArchivePath(entryPath, "Archive entry");
        return isArchivePathWithin(normalized, archiveRoot);
      },
    });

    const originalStateDir = params.manifest.paths?.stateDir;
    const restoredAssets: BackupRestoreResult["restoredAssets"] = [];
    for (const asset of params.manifest.assets) {
      const archivePath = normalizeArchivePath(asset.archivePath, "Backup manifest asset path");
      const payloadPath = path.join(extractDir, archivePath);
      const targetPath = resolveAssetTarget({
        asset,
        originalStateDir,
        targetDir: stageDir,
      });
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.cp(payloadPath, targetPath, { recursive: true, force: false });
      restoredAssets.push({
        kind: asset.kind,
        sourcePath: asset.sourcePath,
        archivePath,
        targetPath: targetPath.replace(stageDir, params.targetDir),
      });
    }

    await fs.mkdir(path.dirname(params.targetDir), { recursive: true });
    previousTargetPath = await moveTargetAsideIfNeeded({
      targetDir: params.targetDir,
      force: params.force,
    });
    await fs.rename(stageDir, params.targetDir);
    return Object.assign(restoredAssets, { previousTargetPath });
  } catch (err) {
    if (previousTargetPath) {
      await fs.rename(previousTargetPath, params.targetDir).catch(() => undefined);
    }
    throw err;
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function formatBackupRestoreSummary(result: BackupRestoreResult): string[] {
  const lines = [
    `Backup restored: ${result.archivePath}`,
    `Target: ${result.targetDir}`,
    `Restored ${result.restoredAssets.length} asset${
      result.restoredAssets.length === 1 ? "" : "s"
    }:`,
  ];
  for (const asset of result.restoredAssets) {
    lines.push(`- ${asset.kind}: ${shortenHomePath(asset.targetPath)}`);
  }
  if (result.previousTargetPath) {
    lines.push(`Previous target moved to: ${result.previousTargetPath}`);
  }
  if (result.dryRun) {
    lines.push("Dry run only; no files were restored.");
  }
  return lines;
}

export async function backupRestoreCommand(
  runtime: RuntimeEnv,
  opts: BackupRestoreOptions,
): Promise<BackupRestoreResult> {
  const archivePath = resolveUserPath(opts.archive);
  const targetDir = await assertTargetPathSafe(
    opts.target ? resolveUserPath(opts.target) : resolveStateDir(),
  );
  const { manifest } = await readArchiveManifest(archivePath);
  const force = Boolean(opts.force);
  const dryRun = Boolean(opts.dryRun);
  const restoredAssets = manifest.assets.map((asset) => ({
    kind: asset.kind,
    sourcePath: asset.sourcePath,
    archivePath: normalizeArchivePath(asset.archivePath, "Backup manifest asset path"),
    targetPath: resolveAssetTarget({
      asset,
      originalStateDir: manifest.paths?.stateDir,
      targetDir,
    }),
  }));

  const result: BackupRestoreResult = {
    ok: true,
    archivePath,
    archiveRoot: normalizeArchiveRoot(manifest.archiveRoot),
    createdAt: manifest.createdAt,
    targetDir,
    dryRun,
    forced: force,
    restoredAssets,
  };

  if (!dryRun) {
    const writeResult = await restoreArchiveToTarget({
      archivePath,
      manifest,
      targetDir,
      force,
    });
    result.restoredAssets = [...writeResult];
    if (writeResult.previousTargetPath) {
      result.previousTargetPath = writeResult.previousTargetPath;
    }
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatBackupRestoreSummary(result).join("\n"));
  }
  return result;
}
