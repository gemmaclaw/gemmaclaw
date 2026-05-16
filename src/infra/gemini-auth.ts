import { execSync } from "node:child_process";

/**
 * Shared Gemini authentication utilities.
 *
 * Supports both traditional API keys and OAuth JSON format.
 */

/** Marker for Vertex AI credentials that should be resolved via gcloud. */
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

/**
 * Parse Gemini API key and return appropriate auth headers.
 *
 * OAuth format: `{"token": "...", "projectId": "..."}`
 *
 * @param apiKey - Either a traditional API key string or OAuth JSON
 * @returns Headers object with appropriate authentication
 */
export function parseGeminiAuth(apiKey: string): { headers: Record<string, string> } {
  if (apiKey === GCP_VERTEX_CREDENTIALS_MARKER) {
    try {
      const token = execSync("gcloud auth application-default print-access-token", {
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
      console.error("Failed to resolve Vertex AI credentials via gcloud", e);
    }
  }

  // Try parsing as OAuth JSON format
  if (apiKey.startsWith("{")) {
    try {
      const parsed = JSON.parse(apiKey) as { token?: string; projectId?: string };
      if (typeof parsed.token === "string" && parsed.token) {
        return {
          headers: {
            Authorization: `Bearer ${parsed.token}`,
            "Content-Type": "application/json",
          },
        };
      }
    } catch {
      // Parse failed, fallback to API key mode
    }
  }

  // Default: traditional API key
  return {
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
  };
}
