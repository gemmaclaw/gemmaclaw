import { execSync } from "node:child_process";
import { parseGoogleOauthApiKey } from "./oauth-token-shared.js";

/** Marker for Vertex AI credentials that should be resolved via gcloud. */
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

export function parseGeminiAuth(apiKey: string): { headers: Record<string, string> } {
  if (apiKey === GCP_VERTEX_CREDENTIALS_MARKER) {
    try {
      const token = execSync("gcloud auth print-access-token", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      };
    } catch (e) {
      // In case gcloud fails, we log it and return empty headers (which will likely result in a 401).
      console.error("Failed to resolve Vertex AI credentials via gcloud:", e);
    }
  }

  const parsed = apiKey.startsWith("{") ? parseGoogleOauthApiKey(apiKey) : null;
  if (parsed?.token) {
    return {
      headers: {
        Authorization: `Bearer ${parsed.token}`,
        "Content-Type": "application/json",
      },
    };
  }

  return {
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
  };
}
