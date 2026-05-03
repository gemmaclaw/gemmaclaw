#!/usr/bin/env node

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

/**
 * Resolve the Gemmaclaw state directory for this invocation.
 *
 * Precedence (highest to lowest):
 *   1. GEMMACLAW_HOME — explicit Gemmaclaw override (wins over everything else
 *      when running as `gemmaclaw`; OPENCLAW_HOME / OPENCLAW_STATE_DIR are
 *      intentionally ignored so power users only need one variable to know).
 *   2. OPENCLAW_STATE_DIR — already set by the caller (e.g. a wrapper script
 *      that manually configured the OpenClaw internals).
 *   3. Default: ~/.gemmaclaw (the Gemmaclaw product home).
 *
 * The resolved value is forwarded to the OpenClaw runtime via
 * OPENCLAW_STATE_DIR so the internals (config, sessions, agents, logs) land
 * under the Gemmaclaw home without the user ever knowing about OpenClaw.
 */
function resolveGemmaclawhome() {
  const gemmaclawHome = process.env.GEMMACLAW_HOME?.trim();
  if (gemmaclawHome) {
    // Expand ~/ prefix using the OS home dir, not OPENCLAW_HOME, so the
    // variable is self-contained even when run from unusual environments.
    if (
      gemmaclawHome === "~" ||
      gemmaclawHome.startsWith("~/") ||
      gemmaclawHome.startsWith("~\\")
    ) {
      const osHome = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
      return path.resolve(gemmaclawHome.replace(/^~(?=$|[\\/])/, osHome));
    }
    return path.resolve(gemmaclawHome);
  }

  if (process.env.OPENCLAW_STATE_DIR?.trim()) {
    // Caller already configured the state dir; honour it but do not override.
    return null;
  }

  // Default: ~/.gemmaclaw
  const osHome = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(osHome, ".gemmaclaw");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const openclawEntrypoint = path.join(here, "openclaw.mjs");

const gemmaclawStateDir = resolveGemmaclawhome();
const childEnv = { ...process.env };
if (gemmaclawStateDir !== null) {
  childEnv.OPENCLAW_STATE_DIR = gemmaclawStateDir;
}

const child = spawn(process.execPath, [openclawEntrypoint, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: childEnv,
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
    return;
  }
  process.exit(code ?? 1);
});

child.once("error", (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`gemmaclaw: failed to launch openclaw.mjs: ${msg}\n`);
  process.exit(1);
});
