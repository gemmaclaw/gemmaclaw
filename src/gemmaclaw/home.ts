import os from "node:os";
import path from "node:path";

/**
 * Resolve the Gemmaclaw state directory from environment variables.
 *
 * Returns the resolved absolute path to use as OPENCLAW_STATE_DIR, or null
 * if OPENCLAW_STATE_DIR is already set and GEMMACLAW_HOME is not overriding it.
 *
 * Precedence:
 *   1. GEMMACLAW_HOME — explicit Gemmaclaw override (always wins when set)
 *   2. OPENCLAW_STATE_DIR — already configured by caller; leave it alone
 *   3. Default: ~/.gemmaclaw
 */
export function resolveGemmaclawStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedirFn: () => string = os.homedir,
): string | null {
  const gemmaclawHome = env.GEMMACLAW_HOME?.trim();
  if (gemmaclawHome) {
    if (
      gemmaclawHome === "~" ||
      gemmaclawHome.startsWith("~/") ||
      gemmaclawHome.startsWith("~\\")
    ) {
      const osHome = env.HOME ?? env.USERPROFILE ?? homedirFn();
      return path.resolve(gemmaclawHome.replace(/^~(?=$|[\\/])/, osHome));
    }
    return path.resolve(gemmaclawHome);
  }

  if (env.OPENCLAW_STATE_DIR?.trim()) {
    return null;
  }

  const osHome = env.HOME ?? env.USERPROFILE ?? homedirFn();
  return path.join(osHome, ".gemmaclaw");
}
