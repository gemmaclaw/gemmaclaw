import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import { createCompatibilityNotice } from "../plugins/status.test-helpers.js";
import { requireValidConfigSnapshot } from "./config-validation.js";

const { readConfigFileSnapshot, buildPluginCompatibilitySnapshotNotices } = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  buildPluginCompatibilitySnapshotNotices: vi.fn<
    (_params?: unknown) => PluginCompatibilityNotice[]
  >(() => []),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilitySnapshotNotices,
  formatPluginCompatibilityNotice: (notice: { pluginId: string; message: string }) =>
    `${notice.pluginId} ${notice.message}`,
}));

describe("requireValidConfigSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createValidSnapshot() {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: { plugins: {} },
      issues: [],
    });
    buildPluginCompatibilitySnapshotNotices.mockReturnValue([
      createCompatibilityNotice({ pluginId: "legacy-plugin", code: "legacy-before-agent-start" }),
    ]);
  }

  function createRuntime() {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
  }

  it("returns config without emitting compatibility advice by default", async () => {
    createValidSnapshot();
    const runtime = createRuntime();

    const config = await requireValidConfigSnapshot(runtime);

    expect(config).toEqual({ plugins: {} });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(buildPluginCompatibilitySnapshotNotices).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("emits a non-blocking compatibility advisory when explicitly requested", async () => {
    createValidSnapshot();
    const runtime = createRuntime();

    const config = await requireValidConfigSnapshot(runtime, {
      includeCompatibilityAdvisory: true,
    });

    expect(config).toEqual({ plugins: {} });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(String(runtime.log.mock.calls[0]?.[0])).toContain("Plugin compatibility: 1 notice.");
    expect(String(runtime.log.mock.calls[0]?.[0])).toContain(
      "legacy-plugin still uses legacy before_agent_start",
    );
  });

  it("blocks invalid config before emitting compatibility advice", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      issues: [{ path: "routing.allowFrom", message: "Legacy key" }],
    });
    const runtime = createRuntime();

    const config = await requireValidConfigSnapshot(runtime, {
      includeCompatibilityAdvisory: true,
    });

    expect(config).toBeNull();
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("replaces doctor fix advice for plugin packaging compiled-output failures", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      issues: [
        {
          path: "plugins.slots.memory",
          message: "plugin not found: source-only-pack",
        },
      ],
      warnings: [
        {
          path: "plugins",
          message:
            "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js. This is a plugin packaging issue, not a local config problem.",
        },
      ],
      legacyIssues: [],
    });
    const runtime = createRuntime();

    const config = await requireValidConfigSnapshot(runtime);

    expect(config).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("plugin not found"));
    expect(runtime.error).toHaveBeenCalledWith(
      "Fix: This is a plugin packaging issue, not a local config problem.\nUpdate or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.",
    );
    expect(runtime.error).not.toHaveBeenCalledWith("Fix: openclaw doctor --fix");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps doctor fix advice for normal invalid config failures", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      issues: [{ path: "gateway.mode", message: "Expected 'local' or 'remote'" }],
      legacyIssues: [],
    });
    const runtime = createRuntime();

    const config = await requireValidConfigSnapshot(runtime);

    expect(config).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith("Fix: openclaw doctor --fix");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
