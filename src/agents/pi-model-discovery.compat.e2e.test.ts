import { afterEach, describe, expect, it, vi } from "vitest";

describe("pi-model-discovery module compatibility", () => {
  afterEach(() => {
    vi.doUnmock("@earendil-works/pi-coding-agent");
  });

  it("loads when InMemoryAuthStorageBackend is not exported", async () => {
    vi.resetModules();
    vi.doMock("@earendil-works/pi-coding-agent", () => {
      function MockAuthStorage() {}
      function MockModelRegistry() {}

      return {
        AuthStorage: MockAuthStorage,
        ModelRegistry: MockModelRegistry,
      };
    });

    await expect(import("./pi-model-discovery.js")).resolves.toMatchObject({
      discoverAuthStorage: expect.any(Function),
      discoverModels: expect.any(Function),
    });
  });
});
