import type { Api, Model } from "@mariozechner/pi-ai";

/**
 * Fully-resolved runtime model shape used after provider/plugin-owned
 * discovery, overrides, and compat normalization.
 */
export type ProviderRuntimeModel = Model<Api> & {
  contextTokens?: number;
  /** Provider-specific request/runtime parameters merged from provider config and model definition. */
  params?: Record<string, unknown>;
};
