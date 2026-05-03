import { describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import {
  createPackageManagerWarningMessage,
  detectLifecyclePackageManager,
  detectLifecyclePackageName,
  isExplicitSourceDevelopmentInstall,
  warnIfNonPnpmLifecycle,
} from "../../scripts/preinstall-package-manager-warning.mjs";

describe("detectLifecyclePackageManager", () => {
  it("prefers npm_config_user_agent when present", () => {
    expect(
      detectLifecyclePackageManager({
        npm_config_user_agent: "npm/11.4.1 node/v22.20.0 darwin arm64",
      }),
    ).toBe("npm");
  });

  it("falls back to npm_execpath when user agent is missing", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "/Users/test/.cache/node/corepack/v1/pnpm/10.32.1/bin/pnpm.cjs",
      }),
    ).toBe("pnpm");
  });

  it("ignores untrusted user-agent tokens with control characters", () => {
    expect(
      detectLifecyclePackageManager({
        npm_config_user_agent: "\u001bnpm/11.4.1 node/v22.20.0 darwin arm64",
        npm_execpath: "/Users/test/.cache/node/corepack/v1/pnpm/10.32.1/bin/pnpm.cjs",
      }),
    ).toBe("pnpm");
  });
});

describe("createPackageManagerWarningMessage", () => {
  it("returns null for pnpm", () => {
    expect(createPackageManagerWarningMessage("pnpm")).toBeNull();
  });

  it("stays quiet for Gemmaclaw npm installs by default", () => {
    expect(createPackageManagerWarningMessage("npm", { packageName: "gemmaclaw" })).toBeNull();
  });

  it("uses Gemmaclaw branding only for explicit source-development warnings", () => {
    const message = createPackageManagerWarningMessage("npm", {
      packageName: "gemmaclaw",
      explicitSourceDevelopmentInstall: true,
    });
    expect(message).toContain("[gemmaclaw]");
    expect(message).toContain("contributors should use pnpm");
    expect(message).not.toContain("[openclaw]");
  });

  it("preserves the OpenClaw source warning when used by the OpenClaw package", () => {
    const message = createPackageManagerWarningMessage("npm", { packageName: "openclaw" });
    expect(message).toContain("[openclaw] warning");
    expect(message).toContain("prefer: corepack pnpm install");
  });
});

describe("detectLifecyclePackageName", () => {
  it("uses npm_package_name when available", () => {
    expect(detectLifecyclePackageName({ npm_package_name: "gemmaclaw" })).toBe("gemmaclaw");
  });

  it("rejects unsafe package-name env values and falls back to package.json", () => {
    expect(detectLifecyclePackageName({ npm_package_name: "gemmaclaw\n[bad]" })).toBe("gemmaclaw");
  });
});

describe("isExplicitSourceDevelopmentInstall", () => {
  it("requires an explicit development warning opt-in", () => {
    expect(isExplicitSourceDevelopmentInstall({})).toBe(false);
    expect(isExplicitSourceDevelopmentInstall({ GEMMACLAW_DEVELOPMENT_INSTALL: "1" })).toBe(true);
  });
});

describe("warnIfNonPnpmLifecycle", () => {
  it("stays quiet for everyday Gemmaclaw npm lifecycle runs", () => {
    const warn = vi.fn();
    expect(
      warnIfNonPnpmLifecycle(
        {
          npm_config_user_agent: "npm/11.4.1 node/v22.20.0 darwin arm64",
          npm_package_name: "gemmaclaw",
        },
        warn,
      ),
    ).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once for explicit Gemmaclaw source-development npm lifecycle runs", () => {
    const warn = vi.fn();
    expect(
      warnIfNonPnpmLifecycle(
        {
          npm_config_user_agent: "npm/11.4.1 node/v22.20.0 darwin arm64",
          npm_package_name: "gemmaclaw",
          GEMMACLAW_DEVELOPMENT_INSTALL: "1",
        },
        warn,
      ),
    ).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[gemmaclaw]");
    expect(warn.mock.calls[0]?.[0]).not.toContain("[openclaw]");
  });

  it("stays quiet for pnpm", () => {
    const warn = vi.fn();
    expect(
      warnIfNonPnpmLifecycle(
        {
          npm_config_user_agent: "pnpm/10.32.1 npm/? node/v22.20.0 darwin arm64",
          npm_package_name: "gemmaclaw",
        },
        warn,
      ),
    ).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("package preinstall", () => {
  it("delegates to the Gemmaclaw-aware warning script", () => {
    expect(packageJson.scripts.preinstall).toBe(
      "node scripts/preinstall-package-manager-warning.mjs",
    );
  });
});
