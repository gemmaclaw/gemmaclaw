import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOOTSTRAP_PROFILES,
  applyBootstrapProfile,
  isBootstrapProfileId,
  listBootstrapProfiles,
} from "./bootstrap-profiles.js";

describe("bootstrap-profiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-profiles-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("listBootstrapProfiles", () => {
    it("returns three profiles in the expected order", () => {
      const ids = listBootstrapProfiles().map((p) => p.id);
      expect(ids).toEqual(["general", "coding", "minimal"]);
    });

    it("each profile has a label and description", () => {
      for (const profile of listBootstrapProfiles()) {
        expect(profile.label).toBeTruthy();
        expect(profile.description).toBeTruthy();
      }
    });
  });

  describe("isBootstrapProfileId", () => {
    it("accepts known ids", () => {
      expect(isBootstrapProfileId("general")).toBe(true);
      expect(isBootstrapProfileId("coding")).toBe(true);
      expect(isBootstrapProfileId("minimal")).toBe(true);
    });

    it("rejects unknown ids", () => {
      expect(isBootstrapProfileId("other")).toBe(false);
      expect(isBootstrapProfileId("")).toBe(false);
    });
  });

  describe("applyBootstrapProfile", () => {
    it("writes the general profile's AGENTS.md into the workspace", () => {
      const result = applyBootstrapProfile("general", tmpDir);
      expect(result.profile).toBe("general");
      expect(result.written).toContain("AGENTS.md");
      const written = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
      expect(written).toContain("AGENTS.md");
    });

    it("writes both AGENTS.md and TOOLS.md for the coding profile", () => {
      const result = applyBootstrapProfile("coding", tmpDir);
      expect(result.written.toSorted()).toEqual(["AGENTS.md", "TOOLS.md"]);
      expect(fs.existsSync(path.join(tmpDir, "AGENTS.md"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "TOOLS.md"))).toBe(true);
    });

    it("writes nothing for the minimal profile", () => {
      const result = applyBootstrapProfile("minimal", tmpDir);
      expect(result.written).toEqual([]);
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    });

    it("skips existing files by default", () => {
      const target = path.join(tmpDir, "AGENTS.md");
      fs.writeFileSync(target, "user-edits");
      const result = applyBootstrapProfile("general", tmpDir);
      expect(result.written).toEqual([]);
      expect(result.skipped).toContain("AGENTS.md");
      expect(fs.readFileSync(target, "utf-8")).toBe("user-edits");
    });

    it("overwrites existing files when overwrite is true", () => {
      const target = path.join(tmpDir, "AGENTS.md");
      fs.writeFileSync(target, "user-edits");
      const result = applyBootstrapProfile("general", tmpDir, { overwrite: true });
      expect(result.written).toContain("AGENTS.md");
      expect(fs.readFileSync(target, "utf-8")).not.toBe("user-edits");
    });

    it("creates the workspace directory if it does not exist", () => {
      const nested = path.join(tmpDir, "nested", "ws");
      const result = applyBootstrapProfile("general", nested);
      expect(fs.existsSync(nested)).toBe(true);
      expect(result.written).toContain("AGENTS.md");
    });

    it("adds Docker shared-folder guidance when container mode is enabled", () => {
      const result = applyBootstrapProfile("general", tmpDir, { useContainer: true });
      expect(result.written).toContain("AGENTS.md");
      const written = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
      expect(written).toContain("## Docker Sandbox Environment");
      expect(written).toContain("/workspace/shared");
      expect(written).toContain("apt-get -o APT::Sandbox::User=root install");
    });
  });

  describe("BOOTSTRAP_PROFILES", () => {
    it("exposes profiles by id for direct lookup", () => {
      expect(BOOTSTRAP_PROFILES.general.id).toBe("general");
      expect(BOOTSTRAP_PROFILES.coding.id).toBe("coding");
      expect(BOOTSTRAP_PROFILES.minimal.id).toBe("minimal");
    });
  });
});
