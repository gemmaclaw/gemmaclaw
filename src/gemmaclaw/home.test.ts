import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGemmaclawStateDir } from "./home.js";

const HOME = "/home/testuser";
const homedir = () => HOME;

describe("resolveGemmaclawStateDir", () => {
  it("defaults to ~/.gemmaclaw when no env vars are set", () => {
    const result = resolveGemmaclawStateDir({}, homedir);
    expect(result).toBe(path.join(HOME, ".gemmaclaw"));
  });

  it("uses HOME env var for the default path", () => {
    const result = resolveGemmaclawStateDir({ HOME: "/custom/home" }, homedir);
    expect(result).toBe("/custom/home/.gemmaclaw");
  });

  it("uses USERPROFILE as fallback on Windows-like envs", () => {
    const result = resolveGemmaclawStateDir({ USERPROFILE: "/users/frank" }, homedir);
    expect(result).toBe("/users/frank/.gemmaclaw");
  });

  it("returns null when OPENCLAW_STATE_DIR is set (no GEMMACLAW_HOME)", () => {
    const result = resolveGemmaclawStateDir(
      { HOME: HOME, OPENCLAW_STATE_DIR: "/custom/state" },
      homedir,
    );
    expect(result).toBeNull();
  });

  it("returns null when OPENCLAW_STATE_DIR has only whitespace", () => {
    const result = resolveGemmaclawStateDir({ HOME: HOME, OPENCLAW_STATE_DIR: "  " }, homedir);
    expect(result).toBe(path.join(HOME, ".gemmaclaw"));
  });

  it("honors GEMMACLAW_HOME as an absolute path", () => {
    const result = resolveGemmaclawStateDir(
      { HOME: HOME, GEMMACLAW_HOME: "/custom/gemmaclaw" },
      homedir,
    );
    expect(result).toBe("/custom/gemmaclaw");
  });

  it("expands GEMMACLAW_HOME with tilde prefix", () => {
    const result = resolveGemmaclawStateDir(
      { HOME: "/home/frank", GEMMACLAW_HOME: "~/.my-gemmaclaw" },
      () => "/home/frank",
    );
    expect(result).toBe("/home/frank/.my-gemmaclaw");
  });

  it("GEMMACLAW_HOME wins over OPENCLAW_STATE_DIR", () => {
    const result = resolveGemmaclawStateDir(
      {
        HOME: HOME,
        GEMMACLAW_HOME: "/my/gemmaclaw",
        OPENCLAW_STATE_DIR: "/my/openclaw",
      },
      homedir,
    );
    expect(result).toBe("/my/gemmaclaw");
  });

  it("default path does not contain .openclaw", () => {
    const result = resolveGemmaclawStateDir({}, homedir);
    expect(result).not.toContain(".openclaw");
    expect(result).toContain(".gemmaclaw");
  });

  it("uses os.homedir as ultimate fallback when HOME and USERPROFILE are missing", () => {
    const customHomedir = () => "/os/homedir";
    const result = resolveGemmaclawStateDir({}, customHomedir);
    expect(result).toBe("/os/homedir/.gemmaclaw");
  });
});
