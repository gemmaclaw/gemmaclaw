import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import {
  mergeProviders,
  mergeWithExistingProviderSecrets,
  type ExistingProviderConfig,
} from "./models-config.merge.js";
import {
  applyNativeStreamingUsageCompat,
  enforceSourceManagedProviderSecrets,
  normalizeProviders,
  resolveImplicitProviders,
  type ProviderConfig,
} from "./models-config.providers.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
export type ResolveImplicitProvidersForModelsJson = (params: {
  agentDir: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  explicitProviders: Record<string, ProviderConfig>;
}) => Promise<Record<string, ProviderConfig>>;

export type ModelsJsonPlan =
  | {
      action: "skip";
    }
  | {
      action: "noop";
    }
  | {
      action: "write";
      contents: string;
    };

export async function resolveProvidersForModelsJsonWithDeps(
  params: {
    cfg: OpenClawConfig;
    agentDir: string;
    env: NodeJS.ProcessEnv;
  },
  deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
  },
): Promise<Record<string, ProviderConfig>> {
  const { agentDir, env } = params;
  const explicitProviders = stripBlankProviderBaseUrls(params.cfg.models?.providers ?? {});
  const cfg = params.cfg.models?.providers
    ? { ...params.cfg, models: { ...params.cfg.models, providers: explicitProviders } }
    : params.cfg;
  const resolveImplicitProvidersImpl = deps?.resolveImplicitProviders ?? resolveImplicitProviders;
  const implicitProviders = await resolveImplicitProvidersImpl({
    agentDir,
    config: cfg,
    env,
    explicitProviders,
  });
  return mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
  });
}

// A provider entry with a blank baseUrl ("" or whitespace) would otherwise
// override the bundled transport URL, fail the writable-provider check, and get
// dropped from models.json — erasing bundled catalogs (e.g. the Gemini catalog).
// Strip blank baseUrl so the bundled default URL is preserved.
function stripBlankProviderBaseUrls(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  let mutated = false;
  const next: Record<string, ProviderConfig> = {};
  for (const [key, provider] of Object.entries(providers)) {
    if (typeof provider?.baseUrl === "string" && provider.baseUrl.trim() === "") {
      const { baseUrl: _blank, ...rest } = provider;
      next[key] = rest as ProviderConfig;
      mutated = true;
      continue;
    }
    next[key] = provider;
  }
  return mutated ? next : providers;
}

function resolveProvidersForMode(params: {
  mode: NonNullable<ModelsConfig["mode"]>;
  existingParsed: unknown;
  providers: Record<string, ProviderConfig>;
  secretRefManagedProviders: ReadonlySet<string>;
}): Record<string, ProviderConfig> {
  if (params.mode !== "merge") {
    return params.providers;
  }
  const existing = params.existingParsed;
  if (!isRecord(existing) || !isRecord(existing.providers)) {
    return params.providers;
  }
  const existingProviders = existing.providers as Record<
    string,
    NonNullable<ModelsConfig["providers"]>[string]
  >;
  return mergeWithExistingProviderSecrets({
    nextProviders: params.providers,
    existingProviders: existingProviders as Record<string, ExistingProviderConfig>,
    secretRefManagedProviders: params.secretRefManagedProviders,
  });
}

export async function planOpenClawModelsJsonWithDeps(
  params: {
    cfg: OpenClawConfig;
    sourceConfigForSecrets?: OpenClawConfig;
    agentDir: string;
    env: NodeJS.ProcessEnv;
    existingRaw: string;
    existingParsed: unknown;
  },
  deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
  },
): Promise<ModelsJsonPlan> {
  const { cfg, agentDir, env } = params;
  const providers = await resolveProvidersForModelsJsonWithDeps({ cfg, agentDir, env }, deps);

  if (Object.keys(providers).length === 0) {
    return { action: "skip" };
  }

  const mode = cfg.models?.mode ?? "merge";
  const secretRefManagedProviders = new Set<string>();
  const normalizedProviders =
    normalizeProviders({
      providers,
      agentDir,
      env,
      secretDefaults: cfg.secrets?.defaults,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? providers;
  const mergedProviders = resolveProvidersForMode({
    mode,
    existingParsed: params.existingParsed,
    providers: normalizedProviders,
    secretRefManagedProviders,
  });
  const secretEnforcedProviders =
    enforceSourceManagedProviderSecrets({
      providers: mergedProviders,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? mergedProviders;
  const finalProviders = applyNativeStreamingUsageCompat(secretEnforcedProviders);
  const nextContents = `${JSON.stringify({ providers: finalProviders }, null, 2)}\n`;

  if (params.existingRaw === nextContents) {
    return { action: "noop" };
  }

  return {
    action: "write",
    contents: nextContents,
  };
}

export async function planOpenClawModelsJson(
  params: Parameters<typeof planOpenClawModelsJsonWithDeps>[0],
): Promise<ModelsJsonPlan> {
  return planOpenClawModelsJsonWithDeps(params);
}
