import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const allowedLifecyclePackageManagers = new Set(["pnpm", "npm", "yarn", "bun"]);

function normalizeEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLifecyclePackageManagerName(value) {
  const normalized = normalizeEnvValue(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
    return null;
  }
  return allowedLifecyclePackageManagers.has(normalized) ? normalized : null;
}

function normalizePackageName(value) {
  const normalized = normalizeEnvValue(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
    return null;
  }
  return normalized;
}

function truthyEnvFlag(value) {
  return ["1", "true", "yes", "on"].includes(normalizeEnvValue(value).toLowerCase());
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export function detectLifecyclePackageManager(env = process.env) {
  const userAgent = normalizeEnvValue(env.npm_config_user_agent);
  const userAgentMatch = /^([A-Za-z0-9._-]+)\//u.exec(userAgent);
  if (userAgentMatch) {
    return normalizeLifecyclePackageManagerName(userAgentMatch[1]);
  }

  const execPath = normalizeEnvValue(env.npm_execpath).toLowerCase();
  if (execPath.includes("pnpm")) {
    return "pnpm";
  }
  if (execPath.includes("npm")) {
    return "npm";
  }
  if (execPath.includes("yarn")) {
    return "yarn";
  }
  if (execPath.includes("bun")) {
    return "bun";
  }

  return null;
}

export function detectLifecyclePackageName(env = process.env) {
  const fromEnv = normalizePackageName(env.npm_package_name);
  if (fromEnv) {
    return fromEnv;
  }

  try {
    const packageJson = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    return normalizePackageName(packageJson.name);
  } catch {
    return null;
  }
}

export function isExplicitSourceDevelopmentInstall(env = process.env) {
  return (
    truthyEnvFlag(env.GEMMACLAW_SOURCE_INSTALL_WARNING) ||
    truthyEnvFlag(env.GEMMACLAW_DEVELOPMENT_INSTALL) ||
    truthyEnvFlag(env.OPENCLAW_SOURCE_INSTALL_WARNING)
  );
}

export function createPackageManagerWarningMessage(packageManager, options = {}) {
  if (!packageManager || packageManager === "pnpm") {
    return null;
  }

  const packageName = normalizePackageName(options.packageName) ?? "openclaw";
  const explicitSourceDevelopmentInstall = options.explicitSourceDevelopmentInstall === true;

  if (packageName === "gemmaclaw" && !explicitSourceDevelopmentInstall) {
    return null;
  }

  if (packageName === "gemmaclaw") {
    return [
      `[gemmaclaw] development warning: detected ${packageManager} for a source-checkout install lifecycle.`,
      "[gemmaclaw] contributors should use pnpm when modifying Gemmaclaw from source.",
      "[gemmaclaw] development command: corepack enable && pnpm install",
    ].join("\n");
  }

  return [
    `[openclaw] warning: detected ${packageManager} for install lifecycle.`,
    "[openclaw] this repo works best with pnpm; npm-compatible installs are slower and much larger here.",
    "[openclaw] prefer: corepack pnpm install",
  ].join("\n");
}

export function warnIfNonPnpmLifecycle(env = process.env, warn = console.warn) {
  const message = createPackageManagerWarningMessage(detectLifecyclePackageManager(env), {
    packageName: detectLifecyclePackageName(env),
    explicitSourceDevelopmentInstall: isExplicitSourceDevelopmentInstall(env),
  });
  if (!message) {
    return false;
  }
  warn(message);
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  warnIfNonPnpmLifecycle();
}
