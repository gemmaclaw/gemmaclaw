import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeGoogleModelId } from "./model-id.js";
import { GOOGLE_GEMINI_DEFAULT_MODEL, applyGoogleGeminiModelDefault } from "./onboard.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";
import {
  normalizeGoogleProviderConfig,
  resolveGoogleGenerativeAiTransport,
} from "./provider-policy.js";
import { createGoogleGenerativeAiTransportStreamFn } from "./transport-stream.js";

export function buildGoogleProvider(): ProviderPlugin {
  return {
    id: "google",
    label: "Google AI Studio",
    docsPath: "/providers/models",
    hookAliases: [],
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: "google",
        methodId: "api-key",
        label: "Google Gemini API key",
        hint: "AI Studio / Gemini API key",
        optionKey: "geminiApiKey",
        flagName: "--gemini-api-key",
        envVar: "GEMINI_API_KEY",
        promptMessage: "Enter Gemini API key",
        defaultModel: GOOGLE_GEMINI_DEFAULT_MODEL,
        expectedProviders: ["google"],
        applyConfig: (cfg) => applyGoogleGeminiModelDefault(cfg).next,
        wizard: {
          choiceId: "gemini-api-key",
          choiceLabel: "Google Gemini API key",
          groupId: "google",
          groupLabel: "Google",
          groupHint: "Gemini API key + OAuth",
        },
      }),
    ],
    normalizeTransport: ({ api, baseUrl }) => resolveGoogleGenerativeAiTransport({ api, baseUrl }),
    normalizeConfig: ({ provider, providerConfig }) =>
      normalizeGoogleProviderConfig(provider, providerConfig),
    normalizeModelId: ({ modelId }) => normalizeGoogleModelId(modelId),
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({
        providerId: ctx.provider,
        ctx,
      }),
    createStreamFn: ({ model }) =>
      model.api === "google-generative-ai"
        ? createGoogleGenerativeAiTransportStreamFn()
        : undefined,
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
  };
}

export function buildGoogleVertexProvider(): ProviderPlugin {
  return {
    id: "google-vertex",
    label: "Google Cloud Vertex AI",
    docsPath: "/providers/models",
    envVars: ["GOOGLE_APPLICATION_CREDENTIALS"],
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: "google-vertex",
        methodId: "gcloud-adc",
        label: "gcloud Application Default Credentials",
        hint: "Vertex AI via gcloud auth",
        optionKey: "vertexCredentials",
        flagName: "--vertex-credentials",
        envVar: "GOOGLE_APPLICATION_CREDENTIALS",
        promptMessage: "Enter path to service account key (or leave blank for gcloud ADC)",
        defaultModel: "gemma-4-31b-it",
        expectedProviders: ["google-vertex"],
        applyConfig: (cfg) => applyGoogleGeminiModelDefault(cfg).next,
        wizard: {
          choiceId: "vertex-adc",
          choiceLabel: "Google Cloud Vertex AI (gcloud)",
          groupId: "google",
          groupLabel: "Google",
          groupHint: "Vertex AI via gcloud ADC or service account",
        },
      }),
    ],
    normalizeTransport: ({ api, baseUrl }) => resolveGoogleGenerativeAiTransport({ api, baseUrl }),
    normalizeConfig: ({ provider, providerConfig }) =>
      normalizeGoogleProviderConfig(provider, providerConfig),
    normalizeModelId: ({ modelId }) => normalizeGoogleModelId(modelId),
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({
        providerId: ctx.provider,
        ctx,
      }),
    createStreamFn: ({ model }) =>
      model.api === "google-generative-ai"
        ? createGoogleGenerativeAiTransportStreamFn()
        : undefined,
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
  };
}

export function registerGoogleProvider(api: OpenClawPluginApi) {
  api.registerProvider(buildGoogleProvider());
  api.registerProvider(buildGoogleVertexProvider());
}
