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
  // Detect OAuth tokens vs traditional API keys.
  // Google OAuth tokens typically start with 'ya29.' or 'v2.'.
  // Traditional Gemini API keys typically start with 'AIza'.
  if (apiKey.startsWith("ya29.") || apiKey.startsWith("v2.")) {
    return {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    };
  }

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
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to resolve Vertex AI credentials via gcloud: ${message}`, {
        cause: e,
      });
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
