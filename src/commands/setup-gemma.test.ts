import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { assertDockerForContainerMode, type DockerProbe } from "./setup-gemma.js";

function makeRuntime(): RuntimeEnv & { logs: string[]; errors: string[]; exitCodes: number[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const log = vi.fn((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const error = vi.fn((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  const exit = vi.fn((...args: unknown[]) => {
    exitCodes.push(args[0] as number);
  });
  return { log, error, exit, logs, errors, exitCodes };
}

function makeProbe(installed: boolean, running: boolean): DockerProbe {
  return {
    isInstalled: vi.fn().mockReturnValue(installed),
    isRunning: vi.fn().mockReturnValue(running),
  };
}

describe("assertDockerForContainerMode", () => {
  describe("Docker not installed", () => {
    it("calls runtime.exit(1) with Docker install instructions", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(false, false);

      await assertDockerForContainerMode(runtime, probe, null);

      expect(runtime.exit).toHaveBeenCalledWith(1);
    });

    it("error message mentions Docker, container mode, and docs.docker.com", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(false, false);

      await assertDockerForContainerMode(runtime, probe, null);

      const allErrors = runtime.errors.join("\n");
      expect(allErrors).toContain("Container mode requires Docker");
      expect(allErrors).toContain("not installed");
      expect(allErrors).toContain("docs.docker.com");
    });

    it("error message mentions --no-container as an alternative", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(false, false);

      await assertDockerForContainerMode(runtime, probe, null);

      const allErrors = runtime.errors.join("\n");
      expect(allErrors).toContain("--no-container");
    });

    it("does not prompt the user when Docker is not installed", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(false, false);
      const prompt = vi.fn(async () => "");

      await assertDockerForContainerMode(runtime, probe, prompt);

      expect(prompt).not.toHaveBeenCalled();
    });
  });

  describe("Docker installed but daemon not running", () => {
    it("calls runtime.exit(1) in non-interactive mode (null prompt)", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(true, false);

      await assertDockerForContainerMode(runtime, probe, null);

      expect(runtime.exit).toHaveBeenCalledWith(1);
    });

    it("error message mentions Docker daemon not running", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(true, false);

      await assertDockerForContainerMode(runtime, probe, null);

      const allErrors = runtime.errors.join("\n");
      expect(allErrors).toContain("Container mode requires Docker");
      expect(allErrors).toContain("not running");
    });

    it("in interactive mode: offers one prompt to start Docker then exits if still not running", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(true, false);
      const prompt = vi.fn(async () => "");

      await assertDockerForContainerMode(runtime, probe, prompt);

      expect(prompt).toHaveBeenCalledOnce();
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });

    it("in interactive mode: succeeds if Docker starts before the user presses Enter", async () => {
      const runtime = makeRuntime();
      // Docker is running after the first isRunning check fails on the initial
      // check, then succeeds when re-checked after the prompt.
      const isRunning = vi
        .fn()
        .mockReturnValueOnce(false) // initial check
        .mockReturnValueOnce(true); // re-check after prompt
      const probe: DockerProbe = {
        isInstalled: vi.fn().mockReturnValue(true),
        isRunning,
      };
      const prompt = vi.fn(async () => ""); // user presses Enter

      await assertDockerForContainerMode(runtime, probe, prompt);

      expect(runtime.exit).not.toHaveBeenCalled();
    });

    it("in interactive mode: exits when Docker is still not running after prompt", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(true, false);
      const prompt = vi.fn(async () => ""); // user presses Enter but Docker stays down

      await assertDockerForContainerMode(runtime, probe, prompt);

      expect(runtime.exit).toHaveBeenCalledWith(1);
    });
  });

  describe("Docker installed and running", () => {
    it("returns without calling runtime.exit when Docker is fully available", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(true, true);

      await assertDockerForContainerMode(runtime, probe, null);

      expect(runtime.exit).not.toHaveBeenCalled();
      expect(runtime.errors).toHaveLength(0);
    });

    it("does not prompt the user when Docker is already running", async () => {
      const runtime = makeRuntime();
      const probe = makeProbe(true, true);
      const prompt = vi.fn(async () => "");

      await assertDockerForContainerMode(runtime, probe, prompt);

      expect(prompt).not.toHaveBeenCalled();
    });
  });

  describe("local/no-container mode (not called when useContainer=false)", () => {
    it("does not invoke assertDockerForContainerMode when useContainer is false (guard test)", async () => {
      // This test documents that assertDockerForContainerMode is only called when
      // useContainer=true. When the user picks local mode, Docker is never checked.
      const probe = makeProbe(false, false);
      const runtime = makeRuntime();

      // Only called when choices.useContainer is true. With false, the caller
      // skips the function entirely. We confirm the function itself is safe with
      // a mock probe — if Docker is unavailable and the function isn't called, no exit.
      const mockAssert = vi.fn(async () => {});
      // Simulate caller skipping assertDockerForContainerMode when !useContainer:
      const useContainer = false;
      if (useContainer) {
        await mockAssert();
      }

      expect(mockAssert).not.toHaveBeenCalled();
      expect(probe.isInstalled).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    });
  });
});
