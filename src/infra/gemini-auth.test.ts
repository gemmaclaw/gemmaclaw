import { execSync } from "node:child_process";
import { describe, expect, it, vi, afterEach } from "vitest";
import { parseGeminiAuth } from "./gemini-auth.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

describe("parseGeminiAuth", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns bearer auth for OAuth JSON tokens", () => {
    expect(parseGeminiAuth('{"token":"oauth-token","projectId":"demo"}')).toEqual({
      headers: {
        Authorization: "Bearer oauth-token",
        "Content-Type": "application/json",
      },
    });
  });

  it("resolves token via gcloud for gcp-vertex-credentials marker", () => {
    vi.mocked(execSync).mockReturnValue("mocked-token\n" as any);

    const result = parseGeminiAuth("gcp-vertex-credentials");

    expect(execSync).toHaveBeenCalledWith(
      "gcloud auth application-default print-access-token",
      expect.any(Object),
    );
    expect(result.headers.Authorization).toBe("Bearer mocked-token");
    expect(result.headers["Content-Type"]).toBe("application/json");
  });

  it("fails loudly when gcloud automated credentials cannot resolve a token", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("gcloud failed");
    });

    expect(() => parseGeminiAuth("gcp-vertex-credentials")).toThrow(
      "Failed to resolve Vertex AI credentials via gcloud",
    );
  });

  it.each(['{"token":"","projectId":"demo"}', "{not-json}", ' {"token":"oauth-token"}'])(
    "falls back to API key auth for %j",
    (value) => {
      expect(parseGeminiAuth(value)).toEqual({
        headers: {
          "x-goog-api-key": value,
          "Content-Type": "application/json",
        },
      });
    },
  );
});
