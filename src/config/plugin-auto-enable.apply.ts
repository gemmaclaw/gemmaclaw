import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  materializePluginAutoEnableCandidatesInternal,
  resolveConfiguredPluginAutoEnableCandidates,
  resolvePluginAutoEnableManifestRegistry,
  resolvePluginAutoEnableReadiness,
} from "./plugin-auto-enable.shared.js";
import type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function materializePluginAutoEnableCandidates(params: {
  config?: OpenClawConfig;
  candidates: readonly PluginAutoEnableCandidate[];
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult {
  const env = params.env ?? process.env;
  const config = params.config ?? {};
  const manifestRegistry = resolvePluginAutoEnableManifestRegistry({
    config,
    env,
    manifestRegistry: params.manifestRegistry,
  });
  return materializePluginAutoEnableCandidatesInternal({
    config,
    candidates: params.candidates,
    env,
    manifestRegistry,
  });
}

export function applyPluginAutoEnable(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult {
  const env = params.env ?? process.env;
  const config = params.config ?? {};
  const readiness = resolvePluginAutoEnableReadiness(config, env);
  if (!readiness.mayNeedAutoEnable) {
    return { config, changes: [], autoEnabledReasons: {} };
  }
  const manifestRegistry = resolvePluginAutoEnableManifestRegistry({
    config,
    env,
    manifestRegistry: params.manifestRegistry,
  });
  const candidates = resolveConfiguredPluginAutoEnableCandidates({
    config,
    env,
    registry: manifestRegistry,
    configuredChannelIds: readiness.configuredChannelIds,
  });
  return materializePluginAutoEnableCandidates({
    config,
    candidates,
    env,
    manifestRegistry,
  });
}
