import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });

export function createGoogleProvider(): ProviderPlugin {
  return {
    id: "google",
    label: "Google AI Studio",
    docsPath: "/providers/models",
    hookAliases: [],
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: "Google Gemini API key",
        hint: "AI Studio / Gemini API key",
        run: noopAuth,
        wizard: {
          choiceId: "gemini-api-key",
          choiceLabel: "Google Gemini API key",
          groupId: "google",
          groupLabel: "Google",
          groupHint: "Gemini API key + OAuth",
        },
      },
    ],
  };
}

export function createGoogleVertexProvider(): ProviderPlugin {
  return {
    id: "google-vertex",
    label: "Google Cloud Vertex AI",
    docsPath: "/providers/models",
    envVars: ["GOOGLE_APPLICATION_CREDENTIALS"],
    auth: [
      {
        id: "gcloud-adc",
        kind: "api_key",
        label: "gcloud Application Default Credentials",
        hint: "Vertex AI via gcloud auth",
        run: noopAuth,
        wizard: {
          choiceId: "vertex-adc",
          choiceLabel: "Google Cloud Vertex AI (gcloud)",
          groupId: "google",
          groupLabel: "Google",
          groupHint: "Vertex AI via gcloud ADC or service account",
        },
      },
    ],
  };
}

export function createGoogleGeminiCliProvider(): ProviderPlugin {
  return {
    id: "google-gemini-cli",
    label: "Gemini CLI OAuth",
    docsPath: "/providers/models",
    aliases: ["gemini-cli"],
    envVars: [
      "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
      "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
      "GEMINI_CLI_OAUTH_CLIENT_ID",
      "GEMINI_CLI_OAUTH_CLIENT_SECRET",
    ],
    auth: [
      {
        id: "oauth",
        kind: "oauth",
        label: "Google OAuth",
        hint: "PKCE + localhost callback",
        run: noopAuth,
      },
    ],
    wizard: {
      setup: {
        choiceId: "google-gemini-cli",
        choiceLabel: "Gemini CLI OAuth",
        choiceHint: "Google OAuth with project-aware token payload",
        methodId: "oauth",
      },
    },
  };
}
