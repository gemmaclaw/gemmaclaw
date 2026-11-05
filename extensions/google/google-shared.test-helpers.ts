import type { Model } from "@earendil-works/pi-ai";
import { expect } from "vitest";

function makeZeroUsageSnapshot() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export const asRecord = (value: unknown): Record<string, unknown> => {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
};

type ConvertedTools = ReadonlyArray<{
  functionDeclarations?: ReadonlyArray<{
    parametersJsonSchema?: unknown;
    parameters?: unknown;
  }>;
}>;

export const getFirstToolParameters = (converted: ConvertedTools): Record<string, unknown> => {
  const functionDeclaration = asRecord(converted?.[0]?.functionDeclarations?.[0]);
  return asRecord(functionDeclaration.parametersJsonSchema ?? functionDeclaration.parameters);
};

export const makeModel = (id: string): Model<"google-generative-ai"> =>
  ({
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<"google-generative-ai">;

export const makeVertexModel = (id: string): Model<"google-vertex"> =>
  ({
    id,
    name: id,
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<"google-vertex">;

export function makeGoogleAssistantMessage(model: string, content: unknown) {
  return {
    role: "assistant",
    content,
    api: "google-generative-ai",
    provider: "google",
    model,
    usage: makeZeroUsageSnapshot(),
    stopReason: "stop",
    timestamp: 0,
  };
}

export function makeVertexAssistantMessage(model: string, content: unknown) {
  return {
    role: "assistant",
    content,
    api: "google-vertex",
    provider: "google-vertex",
    model,
    usage: makeZeroUsageSnapshot(),
    stopReason: "stop",
    timestamp: 0,
  };
}

export function expectConvertedRoles(contents: Array<{ role?: string }>, expectedRoles: string[]) {
  expect(contents).toHaveLength(expectedRoles.length);
  for (const [index, role] of expectedRoles.entries()) {
    expect(contents[index]?.role).toBe(role);
  }
}
