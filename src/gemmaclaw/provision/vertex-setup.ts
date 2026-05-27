/**
 * Vertex AI setup for gemmaclaw.
 *
 * Configures gemmaclaw to use Gemma models on Vertex AI via gcloud auth.
 * Works with both bare (host gcloud) and Docker (mounted ADC) modes.
 *
 * Prerequisites:
 *   - gcloud CLI installed
 *   - gcloud auth application-default login (or service account key)
 *   - A GCP project with Vertex AI API enabled
 *
 * Usage:
 *   gemmaclaw setup --vertex
 *   gemmaclaw setup --vertex --project my-project --region us-central1
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { GCP_VERTEX_CREDENTIALS_MARKER } from "../../agents/model-auth-markers.js";

export type VertexConfig = {
  project: string;
  region: string;
  model: string;
  /** API format: "native" for Gemini API, "openai" for OpenAI-compatible. */
  apiFormat?: "native" | "openai";
  /** Access token from gcloud (short-lived, refreshed per session). */
  accessToken?: string;
  /** Path to ADC credentials file. */
  adcPath?: string;
  /** Path to service account JSON key file. */
  serviceAccountKeyPath?: string;
  /** When true, use automated credentials marker for token refreshing. */
  useAutomatedCredentials?: boolean;
  /** Dedicated vLLM / Model Garden endpoint URL. */
  dedicatedUrl?: string;
  /** When true, disable Vertex safety filters. */
  disableSafety?: boolean;
};

export type VertexSetupResult = {
  ok: boolean;
  config?: VertexConfig;
  error?: string;
};

// Default Gemma models available on Vertex AI
export const VERTEX_GEMMA_MODELS = [
  { id: "gemma-4-31b-it", display: "Gemma 4 31B IT", params: "31B" },
  { id: "gemma-3-1b-it", display: "Gemma 3 1B IT", params: "1B" },
  { id: "gemma-3-4b-it", display: "Gemma 3 4B IT", params: "4B" },
  { id: "gemma-3-12b-it", display: "Gemma 3 12B IT", params: "12B" },
  { id: "gemma-3-27b-it", display: "Gemma 3 27B IT", params: "27B" },
  { id: "gemma-2-2b-it", display: "Gemma 2 2B IT", params: "2B" },
  { id: "gemma-2-9b-it", display: "Gemma 2 9B IT", params: "9B" },
  { id: "gemma-2-27b-it", display: "Gemma 2 27B IT", params: "27B" },
] as const;

/** Check if gcloud CLI is available. */
export function isGcloudInstalled(): boolean {
  try {
    execSync("gcloud --version", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Get the current gcloud project. */
export function getGcloudProject(): string | null {
  try {
    return (
      execSync("gcloud config get-value project", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5_000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** Get an access token from gcloud. */
export function getGcloudAccessToken(): string | null {
  try {
    return (
      execSync("gcloud auth application-default print-access-token", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** Check if ADC credentials file exists. */
export function getAdcPath(): string | null {
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    path.join(process.env.HOME ?? "/root", ".config/gcloud/application_default_credentials.json"),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/** Test Vertex AI connectivity with a simple model list request. */
export async function testVertexConnection(
  project: string,
  region: string,
  accessToken: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/models`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      return { ok: true };
    }
    const body = await resp.text();
    return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Build the gemmaclaw config for Vertex AI.
 * Returns the config object to merge into openclaw.json.
 */
export function buildVertexConfig(vertex: VertexConfig): Record<string, unknown> {
  const isNative = vertex.apiFormat === "native";

  let baseUrl = isNative
    ? `https://${vertex.region}-aiplatform.googleapis.com/v1/projects/${vertex.project}/locations/${vertex.region}/publishers/google`
    : `https://${vertex.region}-aiplatform.googleapis.com/v1beta1/projects/${vertex.project}/locations/${vertex.region}/endpoints/openapi`;

  if (vertex.dedicatedUrl) {
    baseUrl = vertex.dedicatedUrl;
  }

  const api = isNative ? "google-generative-ai" : "openai-completions";

  let modelId = vertex.model;
  if (!isNative && !modelId.startsWith("projects/") && !modelId.includes("/")) {
    modelId = `publishers/google/models/${vertex.model}`;
  }

  const providerConfig: Record<string, unknown> = {
    baseUrl,
    api,
    models: [
      {
        id: modelId,
        name: vertex.model,
        api,
      },
    ],
  };

  if (vertex.useAutomatedCredentials) {
    providerConfig.apiKey = GCP_VERTEX_CREDENTIALS_MARKER;
  }

  return {
    agents: {
      defaults: {
        model: {
          primary: `google-vertex/${modelId}`,
        },
      },
    },
    models: {
      providers: {
        "google-vertex": providerConfig,
      },
    },
  };
}

/**
 * Interactive Vertex AI setup.
 * Guides the user through project selection, region, model, and auth verification.
 */
export async function interactiveVertexSetup(opts?: {
  project?: string;
  region?: string;
  model?: string;
  apiFormat?: "native" | "openai";
  nonInteractive?: boolean;
  dedicatedUrl?: string;
  disableSafety?: boolean;
}): Promise<VertexSetupResult> {
  const log = console.log;

  // 1. Check auth method: service account key OR gcloud CLI
  const saKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const useServiceAccount = saKeyPath && fs.existsSync(saKeyPath);

  if (useServiceAccount) {
    log(`\nUsing service account key: ${saKeyPath}`);
  } else {
    log("\nChecking gcloud CLI...");
    if (!isGcloudInstalled()) {
      return {
        ok: false,
        error:
          "gcloud CLI not found and no GOOGLE_APPLICATION_CREDENTIALS set.\n" +
          "Either: install gcloud (https://cloud.google.com/sdk/docs/install)\n" +
          "Or: set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json",
      };
    }
    log("  gcloud found");
  }

  // 2. Get/verify project
  let project = opts?.project ?? getGcloudProject();
  if (!project) {
    if (opts?.nonInteractive) {
      return { ok: false, error: "No GCP project configured. Run: gcloud config set project <id>" };
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    project = await rl.question("GCP project ID: ");
    rl.close();
  }
  if (!project) {
    return { ok: false, error: "No project specified" };
  }
  log(`  Project: ${project}`);

  // 3. Region
  const region = opts?.region ?? "us-west1";
  log(`  Region: ${region}`);

  // 4. API Format
  let apiFormat = opts?.apiFormat ?? "native";
  if (!opts?.apiFormat && !opts?.nonInteractive) {
    log("\nSelect API Protocol:");
    log("  1) Native Gemini API (google-generative-ai)");
    log("  2) OpenAI Compatible API (openai-completions)");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const choice = await rl.question("Choice [1-2] (default: 1): ");
    rl.close();
    if (choice.trim() === "2") {
      apiFormat = "openai";
    }
  }
  log(`  Protocol: ${apiFormat}`);

  // 5. Get access token
  log("Getting access token...");
  let accessToken: string | null = null;

  if (useServiceAccount) {
    // Service accounts: use gcloud with the key file, or exchange JWT manually
    try {
      accessToken =
        execSync(
          `gcloud auth print-access-token --impersonate-service-account=$(python3 -c "import json; print(json.load(open('${saKeyPath}'))['client_email'])")`,
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 },
        ).trim() || null;
    } catch {
      // Fallback: try plain gcloud which might already be authed with the SA
      accessToken = getGcloudAccessToken();
    }
    if (!accessToken) {
      return {
        ok: false,
        error:
          "Failed to get access token from service account. " +
          "Ensure gcloud is installed and run: gcloud auth activate-service-account --key-file=" +
          saKeyPath,
      };
    }
  } else {
    accessToken = getGcloudAccessToken();
    if (!accessToken) {
      return {
        ok: false,
        error: "Failed to get access token. Run: gcloud auth application-default login",
      };
    }
  }
  log("  Access token obtained");

  // 6. Automated refresh?
  let useAutomatedCredentials = true;
  if (!opts?.nonInteractive && !useServiceAccount) {
    log("\nCredential Refresh:");
    log("  1) Automated (refresh short-lived tokens per session)");
    log("  2) Static (use current token, will expire in 1 hour)");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const choice = await rl.question("Choice [1-2] (default: 1): ");
    rl.close();
    if (choice.trim() === "2") {
      useAutomatedCredentials = false;
    }
  }

  // 7. Test connection
  log("Testing Vertex AI connection...");
  const test = await testVertexConnection(project, region, accessToken);
  if (!test.ok) {
    return {
      ok: false,
      error: `Vertex AI connection failed: ${test.error}. Check: project has Vertex AI API enabled, you have correct permissions.`,
    };
  }
  log("  Vertex AI connection OK");

  // 8. Model selection
  let model = opts?.model;
  if (!model) {
    if (opts?.nonInteractive) {
      model = "gemma-3-27b-it";
    } else {
      log("\nAvailable Gemma models on Vertex AI:");
      for (let i = 0; i < VERTEX_GEMMA_MODELS.length; i++) {
        const m = VERTEX_GEMMA_MODELS[i];
        log(`  ${i + 1}) ${m.display} (${m.params})`);
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const choice = await rl.question(
        `Select model [1-${VERTEX_GEMMA_MODELS.length}] (default: 6 for 27B): `,
      );
      rl.close();
      const idx = Number.parseInt(choice, 10) - 1;
      model =
        idx >= 0 && idx < VERTEX_GEMMA_MODELS.length
          ? VERTEX_GEMMA_MODELS[idx].id
          : "gemma-3-27b-it";
    }
  }
  log(`  Model: ${model}`);

  // 9. ADC path for Docker
  const adcPath = getAdcPath();
  if (adcPath) {
    log(`  ADC: ${adcPath} (will be mounted in Docker mode)`);
  }

  return {
    ok: true,
    config: {
      project,
      region,
      model,
      apiFormat,
      accessToken: accessToken ?? undefined,
      adcPath: adcPath ?? undefined,
      useAutomatedCredentials,
      dedicatedUrl: opts?.dedicatedUrl,
      disableSafety: opts?.disableSafety,
    },
  };
}

/**
 * Non-interactive Vertex AI setup from CLI flags.
 */
export async function setupVertex(opts: {
  project?: string;
  region?: string;
  model?: string;
  apiFormat?: "native" | "openai";
  dedicatedUrl?: string;
}): Promise<VertexSetupResult> {
  return interactiveVertexSetup({ ...opts, nonInteractive: !process.stdin.isTTY });
}
