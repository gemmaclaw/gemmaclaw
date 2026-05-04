import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareBundledPluginRuntimeRoot } from "./bundled-runtime-root.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-root-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("prepareBundledPluginRuntimeRoot", () => {
  it("mirrors package.json into external runtime roots for plugin-sdk subpath aliases", () => {
    const packageRoot = makeTempDir();
    const stageRoot = makeTempDir();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "feishu");
    fs.mkdirSync(path.join(packageRoot, "dist", "plugin-sdk"), { recursive: true });
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "gemmaclaw",
          version: "2026.4.22",
          bin: { openclaw: "openclaw.mjs" },
          exports: {
            "./plugin-sdk": { default: "./dist/plugin-sdk/index.js" },
            "./plugin-sdk/account-id": { default: "./dist/plugin-sdk/account-id.js" },
          },
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(path.join(packageRoot, "dist", "plugin-sdk", "root-alias.cjs"), "");
    fs.writeFileSync(path.join(packageRoot, "dist", "plugin-sdk", "index.js"), "");
    fs.writeFileSync(path.join(packageRoot, "dist", "plugin-sdk", "account-id.js"), "");
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      `${JSON.stringify({ name: "@openclaw/feishu", version: "1.0.0" }, null, 2)}\n`,
    );
    const modulePath = path.join(pluginRoot, "index.js");
    fs.writeFileSync(modulePath, "");

    const result = prepareBundledPluginRuntimeRoot({
      pluginId: "feishu",
      pluginRoot,
      modulePath,
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageRoot },
    });

    const stagedPackageRoot = path.dirname(path.dirname(path.dirname(result.pluginRoot)));
    expect(stagedPackageRoot).toContain(stageRoot);
    expect(fs.existsSync(path.join(stagedPackageRoot, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(stagedPackageRoot, "dist", "plugin-sdk", "account-id.js"))).toBe(
      true,
    );
    expect(result.modulePath).toBe(path.join(result.pluginRoot, "index.js"));
  });
});
