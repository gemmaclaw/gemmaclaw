import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };

describe("package install surface", () => {
  it("does not run a preinstall lifecycle for user installs", () => {
    expect((packageJson.scripts as Record<string, string | undefined>).preinstall).toBeUndefined();
  });

  it("does not package the removed preinstall warning script", () => {
    expect(packageJson.files).not.toContain("scripts/preinstall-package-manager-warning.mjs");
  });
});
