import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { visitObjectContentBlocks } from "../../../shared/message-content-blocks.js";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
import { validateAnthropicTurns, validateGeminiTurns } from "../../pi-embedded-helpers.js";
import { sanitizeToolUseResultPairing } from "../../session-transcript-repair.js";
import {
  extractToolCallsFromAssistant,
  sanitizeToolCallIdsForCloudCodeAssist,
  type ToolCallIdMode,
} from "../../tool-call-id.js";
import { hasUnredactedSessionsSpawnAttachments } from "../../tool-call-shared.js";
import { normalizeToolName } from "../../tool-policy.js";
import { shouldAllowProviderOwnedThinkingReplay } from "../../transcript-policy.js";
import type { TranscriptPolicy } from "../../transcript-policy.js";
import { wrapStreamObjectEvents } from "./stream-wrapper.js";
import { randomUUID } from "node:crypto";
import { createStreamIteratorWrapper } from "../../stream-iterator-wrapper.js";
import { log } from "../logger.js";

type UnknownToolLoopGuardState = {
  lastUnknownToolName?: string;
  count: number;
  countedMessages: WeakSet<object>;
};

function resolveCaseInsensitiveAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  const folded = normalizeLowercaseStringOrEmpty(rawName);
  let caseInsensitiveMatch: string | null = null;
  for (const name of allowedToolNames) {
    if (normalizeLowercaseStringOrEmpty(name) !== folded) {
      continue;
    }
    if (caseInsensitiveMatch && caseInsensitiveMatch !== name) {
      return null;
    }
    caseInsensitiveMatch = name;
  }
  return caseInsensitiveMatch;
}

function resolveExactAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  if (allowedToolNames.has(rawName)) {
    return rawName;
  }
  const normalized = normalizeToolName(rawName);
  if (allowedToolNames.has(normalized)) {
    return normalized;
  }
  return (
    resolveCaseInsensitiveAllowedToolName(rawName, allowedToolNames) ??
    resolveCaseInsensitiveAllowedToolName(normalized, allowedToolNames)
  );
}

function buildStructuredToolNameCandidates(rawName: string): string[] {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return [];
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string) => {
    const candidate = value.trim();
    if (!candidate || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate);
  };

  addCandidate(trimmed);
  addCandidate(normalizeToolName(trimmed));

  const normalizedDelimiter = trimmed.replace(/\//g, ".");
  addCandidate(normalizedDelimiter);
  addCandidate(normalizeToolName(normalizedDelimiter));

  const segments = normalizedDelimiter
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length > 1) {
    for (let index = 1; index < segments.length; index += 1) {
      const suffix = segments.slice(index).join(".");
      addCandidate(suffix);
      addCandidate(normalizeToolName(suffix));
    }
  }

  return candidates;
}

function resolveStructuredAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }

  const candidateNames = buildStructuredToolNameCandidates(rawName);
  for (const candidate of candidateNames) {
    if (allowedToolNames.has(candidate)) {
      return candidate;
    }
  }

  for (const candidate of candidateNames) {
    const caseInsensitiveMatch = resolveCaseInsensitiveAllowedToolName(candidate, allowedToolNames);
    if (caseInsensitiveMatch) {
      return caseInsensitiveMatch;
    }
  }

  return null;
}

function inferToolNameFromToolCallId(
  rawId: string | undefined,
  allowedToolNames?: Set<string>,
): string | null {
  if (!rawId || !allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  const id = rawId.trim();
  if (!id) {
    return null;
  }

  const candidateTokens = new Set<string>();
  const addToken = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    candidateTokens.add(trimmed);
    candidateTokens.add(trimmed.replace(/[:._/-]\d+$/, ""));
    candidateTokens.add(trimmed.replace(/\d+$/, ""));

    const normalizedDelimiter = trimmed.replace(/\//g, ".");
    candidateTokens.add(normalizedDelimiter);
    candidateTokens.add(normalizedDelimiter.replace(/[:._-]\d+$/, ""));
    candidateTokens.add(normalizedDelimiter.replace(/\d+$/, ""));

    for (const prefixPattern of [/^functions?[._-]?/i, /^tools?[._-]?/i]) {
      const stripped = normalizedDelimiter.replace(prefixPattern, "");
      if (stripped !== normalizedDelimiter) {
        candidateTokens.add(stripped);
        candidateTokens.add(stripped.replace(/[:._-]\d+$/, ""));
        candidateTokens.add(stripped.replace(/\d+$/, ""));
      }
    }
  };

  const preColon = id.split(":")[0] ?? id;
  for (const seed of [id, preColon]) {
    addToken(seed);
  }

  let singleMatch: string | null = null;
  for (const candidate of candidateTokens) {
    const matched = resolveStructuredAllowedToolName(candidate, allowedToolNames);
    if (!matched) {
      continue;
    }
    if (singleMatch && singleMatch !== matched) {
      return null;
    }
    singleMatch = matched;
  }

  return singleMatch;
}

function looksLikeMalformedToolNameCounter(rawName: string): boolean {
  const normalizedDelimiter = rawName.trim().replace(/\//g, ".");
  return (
    /^(?:functions?|tools?)[._-]?/i.test(normalizedDelimiter) &&
    /(?:[:._-]\d+|\d+)$/.test(normalizedDelimiter)
  );
}

function normalizeToolCallNameForDispatch(
  rawName: string,
  allowedToolNames?: Set<string>,
  rawToolCallId?: string,
): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return inferToolNameFromToolCallId(rawToolCallId, allowedToolNames) ?? rawName;
  }
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return trimmed;
  }

  const exact = resolveExactAllowedToolName(trimmed, allowedToolNames);
  if (exact) {
    return exact;
  }
  const inferredFromName = inferToolNameFromToolCallId(trimmed, allowedToolNames);
  if (inferredFromName) {
    return inferredFromName;
  }

  if (looksLikeMalformedToolNameCounter(trimmed)) {
    return trimmed;
  }

  return resolveStructuredAllowedToolName(trimmed, allowedToolNames) ?? trimmed;
}

function isToolCallBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

const REPLAY_TOOL_CALL_NAME_MAX_CHARS = 64;

type ReplayToolCallBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
};

type ReplayToolCallSanitizeReport = {
  messages: AgentMessage[];
  droppedAssistantMessages: number;
};

type AnthropicToolResultContentBlock = {
  type?: unknown;
  toolUseId?: unknown;
  toolCallId?: unknown;
  tool_use_id?: unknown;
  tool_call_id?: unknown;
};

function isThinkingLikeReplayBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}

function isReplaySafeThinkingTurn(content: unknown[], allowedToolNames?: Set<string>): boolean {
  const seenToolCallIds = new Set<string>();
  for (const block of content) {
    if (!isReplayToolCallBlock(block)) {
      continue;
    }
    const replayBlock = block;
    const toolCallId = typeof replayBlock.id === "string" ? replayBlock.id.trim() : "";
    if (
      !replayToolCallHasInput(replayBlock) ||
      !toolCallId ||
      seenToolCallIds.has(toolCallId) ||
      hasUnredactedSessionsSpawnAttachments(replayBlock)
    ) {
      return false;
    }
    seenToolCallIds.add(toolCallId);
    const rawName = typeof replayBlock.name === "string" ? replayBlock.name : "";
    const resolvedName = resolveReplayToolCallName(rawName, toolCallId, allowedToolNames);
    if (!resolvedName || replayBlock.name !== resolvedName) {
      return false;
    }
  }
  return true;
}

function isReplayToolCallBlock(block: unknown): block is ReplayToolCallBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  return isToolCallBlockType((block as { type?: unknown }).type);
}

function replayToolCallHasInput(block: ReplayToolCallBlock): boolean {
  const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
  const hasArguments =
    "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
  return hasInput || hasArguments;
}

function replayToolCallNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveReplayToolCallName(
  rawName: string,
  rawId: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (rawName.length > REPLAY_TOOL_CALL_NAME_MAX_CHARS * 2) {
    return null;
  }
  const normalized = normalizeToolCallNameForDispatch(rawName, allowedToolNames, rawId);
  const trimmed = normalized.trim();
  if (!trimmed || trimmed.length > REPLAY_TOOL_CALL_NAME_MAX_CHARS || /\s/.test(trimmed)) {
    return null;
  }
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return trimmed;
  }
  return resolveExactAllowedToolName(trimmed, allowedToolNames);
}

function sanitizeReplayToolCallInputs(
  messages: AgentMessage[],
  allowedToolNames?: Set<string>,
  allowProviderOwnedThinkingReplay?: boolean,
): ReplayToolCallSanitizeReport {
  let changed = false;
  let droppedAssistantMessages = 0;
  const out: AgentMessage[] = [];
  const claimedReplaySafeToolCallIds = new Set<string>();

  for (const message of messages) {
    if (!message || typeof message !== "object" || message.role !== "assistant") {
      out.push(message);
      continue;
    }
    if (!Array.isArray(message.content)) {
      out.push(message);
      continue;
    }
    if (
      allowProviderOwnedThinkingReplay &&
      message.content.some((block) => isThinkingLikeReplayBlock(block)) &&
      message.content.some((block) => isReplayToolCallBlock(block))
    ) {
      const replaySafeToolCalls = extractToolCallsFromAssistant(message);
      if (
        isReplaySafeThinkingTurn(message.content, allowedToolNames) &&
        replaySafeToolCalls.every((toolCall) => !claimedReplaySafeToolCallIds.has(toolCall.id))
      ) {
        for (const toolCall of replaySafeToolCalls) {
          claimedReplaySafeToolCallIds.add(toolCall.id);
        }
        out.push(message);
      } else {
        changed = true;
        droppedAssistantMessages += 1;
      }
      continue;
    }

    const nextContent: typeof message.content = [];
    let messageChanged = false;

    for (const block of message.content) {
      if (!isReplayToolCallBlock(block)) {
        nextContent.push(block);
        continue;
      }
      const replayBlock = block as ReplayToolCallBlock;

      if (!replayToolCallHasInput(replayBlock) || !replayToolCallNonEmptyString(replayBlock.id)) {
        changed = true;
        messageChanged = true;
        continue;
      }

      const rawName = typeof replayBlock.name === "string" ? replayBlock.name : "";
      const resolvedName = resolveReplayToolCallName(rawName, replayBlock.id, allowedToolNames);
      if (!resolvedName) {
        changed = true;
        messageChanged = true;
        continue;
      }

      if (replayBlock.name !== resolvedName) {
        nextContent.push({ ...(block as object), name: resolvedName } as typeof block);
        changed = true;
        messageChanged = true;
        continue;
      }
      nextContent.push(block);
    }

    if (messageChanged) {
      changed = true;
      if (nextContent.length > 0) {
        out.push({ ...message, content: nextContent });
      } else {
        droppedAssistantMessages += 1;
      }
      continue;
    }

    out.push(message);
  }

  return {
    messages: changed ? out : messages,
    droppedAssistantMessages,
  };
}

function extractAnthropicReplayToolResultIds(block: AnthropicToolResultContentBlock): string[] {
  const ids: string[] = [];
  for (const value of [block.toolUseId, block.toolCallId, block.tool_use_id, block.tool_call_id]) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || ids.includes(trimmed)) {
      continue;
    }
    ids.push(trimmed);
  }
  return ids;
}

function isSignedThinkingReplayAssistantSpan(message: AgentMessage | undefined): boolean {
  if (!message || typeof message !== "object" || message.role !== "assistant") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return (
    content.some((block) => isThinkingLikeReplayBlock(block)) &&
    content.some((block) => isReplayToolCallBlock(block))
  );
}

function sanitizeAnthropicReplayToolResults(
  messages: AgentMessage[],
  options?: {
    disallowEmbeddedUserToolResultsForSignedThinkingReplay?: boolean;
  },
): AgentMessage[] {
  let changed = false;
  const out: AgentMessage[] = [];
  const disallowEmbeddedUserToolResultsForSignedThinkingReplay =
    options?.disallowEmbeddedUserToolResultsForSignedThinkingReplay === true;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || message.role !== "user") {
      out.push(message);
      continue;
    }
    if (!Array.isArray(message.content)) {
      out.push(message);
      continue;
    }

    const previous = messages[index - 1];
    const shouldStripEmbeddedToolResults =
      disallowEmbeddedUserToolResultsForSignedThinkingReplay &&
      isSignedThinkingReplayAssistantSpan(previous);
    const validToolUseIds = new Set<string>();
    if (previous && typeof previous === "object" && previous.role === "assistant") {
      const previousContent = (previous as { content?: unknown }).content;
      if (Array.isArray(previousContent)) {
        for (const block of previousContent) {
          if (!block || typeof block !== "object") {
            continue;
          }
          const typedBlock = block as { type?: unknown; id?: unknown };
          if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
            continue;
          }
          const trimmedId = typedBlock.id.trim();
          if (trimmedId) {
            validToolUseIds.add(trimmedId);
          }
        }
      }
    }

    const nextContent = message.content.filter((block) => {
      if (!block || typeof block !== "object") {
        return true;
      }
      const typedBlock = block as AnthropicToolResultContentBlock;
      if (typedBlock.type !== "toolResult" && typedBlock.type !== "tool") {
        return true;
      }
      if (shouldStripEmbeddedToolResults) {
        changed = true;
        return false;
      }
      const resultIds = extractAnthropicReplayToolResultIds(typedBlock);
      if (resultIds.length === 0) {
        changed = true;
        return false;
      }
      return validToolUseIds.size > 0 && resultIds.some((id) => validToolUseIds.has(id));
    });

    if (nextContent.length === message.content.length) {
      out.push(message);
      continue;
    }

    changed = true;
    if (nextContent.length > 0) {
      out.push({ ...message, content: nextContent });
      continue;
    }

    out.push({
      ...message,
      content: [{ type: "text", text: "[tool results omitted]" }],
    } as AgentMessage);
  }

  return changed ? out : messages;
}

function normalizeToolCallIdsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }

  const usedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
      continue;
    }
    const trimmedId = typedBlock.id.trim();
    if (!trimmedId) {
      continue;
    }
    usedIds.add(trimmedId);
  }

  let fallbackIndex = 1;
  const assignedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
      continue;
    }
    if (typeof typedBlock.id === "string") {
      const trimmedId = typedBlock.id.trim();
      if (trimmedId) {
        if (!assignedIds.has(trimmedId)) {
          if (typedBlock.id !== trimmedId) {
            typedBlock.id = trimmedId;
          }
          assignedIds.add(trimmedId);
          continue;
        }
      }
    }

    let fallbackId = "";
    while (!fallbackId || usedIds.has(fallbackId) || assignedIds.has(fallbackId)) {
      fallbackId = `call_auto_${fallbackIndex++}`;
    }
    typedBlock.id = fallbackId;
    usedIds.add(fallbackId);
    assignedIds.add(fallbackId);
  }
}

function trimWhitespaceFromToolCallNamesInMessage(
  message: unknown,
  allowedToolNames?: Set<string>,
): void {
  visitObjectContentBlocks(message, (block) => {
    const typedBlock = block as { type?: unknown; name?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
      return;
    }
    const rawId = typeof typedBlock.id === "string" ? typedBlock.id : undefined;
    if (typeof typedBlock.name === "string") {
      const normalized = normalizeToolCallNameForDispatch(typedBlock.name, allowedToolNames, rawId);
      if (normalized !== typedBlock.name) {
        typedBlock.name = normalized;
      }
      return;
    }
    const inferred = inferToolNameFromToolCallId(rawId, allowedToolNames);
    if (inferred) {
      typedBlock.name = inferred;
    }
  });
  normalizeToolCallIdsInMessage(message);
}

function classifyToolCallMessage(
  message: unknown,
  allowedToolNames?: Set<string>,
):
  | { kind: "none" }
  | { kind: "allowed" }
  | { kind: "incomplete" }
  | { kind: "unknown"; toolName: string } {
  if (!message || typeof message !== "object" || !allowedToolNames || allowedToolNames.size === 0) {
    return { kind: "none" };
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return { kind: "none" };
  }

  let unknownToolName: string | undefined;
  let sawToolCall = false;
  let sawAllowedToolCall = false;
  let sawIncompleteToolCall = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; name?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
      continue;
    }
    sawToolCall = true;
    const rawName = typeof typedBlock.name === "string" ? typedBlock.name.trim() : "";
    if (!rawName) {
      sawIncompleteToolCall = true;
      continue;
    }
    if (resolveExactAllowedToolName(rawName, allowedToolNames)) {
      sawAllowedToolCall = true;
      continue;
    }
    const normalizedUnknownToolName = normalizeToolName(rawName);
    if (!unknownToolName) {
      unknownToolName = normalizedUnknownToolName;
      continue;
    }
    if (unknownToolName !== normalizedUnknownToolName) {
      sawIncompleteToolCall = true;
    }
  }

  if (!sawToolCall) {
    return { kind: "none" };
  }
  if (sawAllowedToolCall) {
    return { kind: "allowed" };
  }
  if (sawIncompleteToolCall) {
    return { kind: "incomplete" };
  }
  return unknownToolName ? { kind: "unknown", toolName: unknownToolName } : { kind: "incomplete" };
}

function rewriteUnknownToolLoopMessage(message: unknown, toolName: string): void {
  if (!message || typeof message !== "object") {
    return;
  }
  (message as { content?: unknown }).content = [
    {
      type: "text",
      text: `I can't use the tool "${toolName}" here because it isn't available. I need to stop retrying it and answer without that tool.`,
    },
  ];
}

function guardUnknownToolLoopInMessage(
  message: unknown,
  state: UnknownToolLoopGuardState,
  params: {
    allowedToolNames?: Set<string>;
    threshold?: number;
    countAttempt: boolean;
    resetOnAllowedTool?: boolean;
    resetOnMissingUnknownTool?: boolean;
  },
): boolean {
  const threshold = params.threshold;
  if (threshold === undefined || threshold <= 0) {
    return false;
  }

  const toolCallState = classifyToolCallMessage(message, params.allowedToolNames);
  if (toolCallState.kind === "allowed") {
    if (params.resetOnAllowedTool === true) {
      state.lastUnknownToolName = undefined;
      state.count = 0;
    }
    return false;
  }
  if (toolCallState.kind !== "unknown") {
    if (params.countAttempt && params.resetOnMissingUnknownTool !== false) {
      state.lastUnknownToolName = undefined;
      state.count = 0;
    }
    return false;
  }
  const unknownToolName = toolCallState.toolName;

  if (!params.countAttempt) {
    if (state.lastUnknownToolName === unknownToolName && state.count > threshold) {
      rewriteUnknownToolLoopMessage(message, unknownToolName);
    }
    return false;
  }

  if (message && typeof message === "object") {
    if (state.countedMessages.has(message)) {
      if (state.lastUnknownToolName === unknownToolName && state.count > threshold) {
        rewriteUnknownToolLoopMessage(message, unknownToolName);
      }
      return true;
    }
    state.countedMessages.add(message);
  }

  if (state.lastUnknownToolName === unknownToolName) {
    state.count += 1;
  } else {
    state.lastUnknownToolName = unknownToolName;
    state.count = 1;
  }

  if (state.count > threshold) {
    rewriteUnknownToolLoopMessage(message, unknownToolName);
  }
  return true;
}

function wrapStreamTrimToolCallNames(
  stream: ReturnType<typeof streamSimple>,
  allowedToolNames?: Set<string>,
  options?: { unknownToolThreshold?: number; state?: UnknownToolLoopGuardState },
): ReturnType<typeof streamSimple> {
  const unknownToolGuardState = options?.state ?? {
    count: 0,
    countedMessages: new WeakSet<object>(),
  };
  let streamAttemptAlreadyCounted = false;
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    trimWhitespaceFromToolCallNamesInMessage(message, allowedToolNames);
    guardUnknownToolLoopInMessage(message, unknownToolGuardState, {
      allowedToolNames,
      threshold: options?.unknownToolThreshold,
      countAttempt: !streamAttemptAlreadyCounted,
      resetOnAllowedTool: true,
    });
    return message;
  };

  wrapStreamObjectEvents(stream, (event) => {
    trimWhitespaceFromToolCallNamesInMessage(event.partial, allowedToolNames);
    trimWhitespaceFromToolCallNamesInMessage(event.message, allowedToolNames);
    if (event.message && typeof event.message === "object") {
      const countedStreamAttempt = guardUnknownToolLoopInMessage(
        event.message,
        unknownToolGuardState,
        {
          allowedToolNames,
          threshold: options?.unknownToolThreshold,
          countAttempt: !streamAttemptAlreadyCounted,
          resetOnAllowedTool: true,
          resetOnMissingUnknownTool: false,
        },
      );
      streamAttemptAlreadyCounted ||= countedStreamAttempt;
    }
    guardUnknownToolLoopInMessage(event.partial, unknownToolGuardState, {
      allowedToolNames,
      threshold: options?.unknownToolThreshold,
      countAttempt: false,
    });
  });

  return stream;
}

export function wrapStreamFnTrimToolCallNames(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
  guardOptions?: { unknownToolThreshold?: number },
): StreamFn {
  const unknownToolGuardState: UnknownToolLoopGuardState = {
    count: 0,
    countedMessages: new WeakSet<object>(),
  };
  return (model, context, streamOptions) => {
    const maybeStream = baseFn(model, context, streamOptions);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamTrimToolCallNames(stream, allowedToolNames, {
          unknownToolThreshold: guardOptions?.unknownToolThreshold,
          state: unknownToolGuardState,
        }),
      );
    }
    return wrapStreamTrimToolCallNames(maybeStream, allowedToolNames, {
      unknownToolThreshold: guardOptions?.unknownToolThreshold,
      state: unknownToolGuardState,
    });
  };
}

export function sanitizeReplayToolCallIdsForStream(params: {
  messages: AgentMessage[];
  mode: ToolCallIdMode;
  allowedToolNames?: Set<string>;
  preserveNativeAnthropicToolUseIds?: boolean;
  preserveReplaySafeThinkingToolCallIds?: boolean;
  repairToolUseResultPairing?: boolean;
}): AgentMessage[] {
  const sanitized = sanitizeToolCallIdsForCloudCodeAssist(params.messages, params.mode, {
    preserveNativeAnthropicToolUseIds: params.preserveNativeAnthropicToolUseIds,
    preserveReplaySafeThinkingToolCallIds: params.preserveReplaySafeThinkingToolCallIds,
    allowedToolNames: params.allowedToolNames,
  });
  if (!params.repairToolUseResultPairing) {
    return sanitized;
  }
  return sanitizeToolUseResultPairing(sanitized);
}

export function wrapStreamFnSanitizeMalformedToolCalls(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
  transcriptPolicy?: Pick<
    TranscriptPolicy,
    "validateGeminiTurns" | "validateAnthropicTurns" | "preserveSignatures" | "dropThinkingBlocks"
  >,
): StreamFn {
  return (model, context, options) => {
    const ctx = context as unknown as { messages?: unknown };
    const messages = ctx?.messages;
    if (!Array.isArray(messages)) {
      return baseFn(model, context, options);
    }
    const allowProviderOwnedThinkingReplay = shouldAllowProviderOwnedThinkingReplay({
      modelApi: (model as { api?: unknown })?.api as string | null | undefined,
      policy: {
        validateAnthropicTurns: transcriptPolicy?.validateAnthropicTurns === true,
        preserveSignatures: transcriptPolicy?.preserveSignatures === true,
        dropThinkingBlocks: transcriptPolicy?.dropThinkingBlocks === true,
      },
    });
    const sanitized = sanitizeReplayToolCallInputs(
      messages as AgentMessage[],
      allowedToolNames,
      allowProviderOwnedThinkingReplay,
    );
    const replayInputsChanged = sanitized.messages !== messages;
    let nextMessages = replayInputsChanged
      ? sanitizeToolUseResultPairing(sanitized.messages)
      : sanitized.messages;
    if (transcriptPolicy?.validateAnthropicTurns) {
      nextMessages = sanitizeAnthropicReplayToolResults(nextMessages, {
        disallowEmbeddedUserToolResultsForSignedThinkingReplay: allowProviderOwnedThinkingReplay,
      });
    }
    if (nextMessages === messages) {
      return baseFn(model, context, options);
    }
    if (sanitized.droppedAssistantMessages > 0 || transcriptPolicy?.validateAnthropicTurns) {
      if (transcriptPolicy?.validateGeminiTurns) {
        nextMessages = validateGeminiTurns(nextMessages);
      }
      if (transcriptPolicy?.validateAnthropicTurns) {
        nextMessages = validateAnthropicTurns(nextMessages);
      }
    }
    const nextContext = {
      ...(context as unknown as Record<string, unknown>),
      messages: nextMessages,
    } as unknown;
    return baseFn(model, nextContext as typeof context, options);
  };
}

function parseGemma4Args(argsStr: string): Record<string, unknown> {
  argsStr = argsStr.trim();
  if (argsStr.startsWith('{') && argsStr.endsWith('}')) {
    argsStr = argsStr.slice(1, -1).trim();
  }
  
  const keyRegex = /(?:^|,)\s*(\w+)\s*:/g;
  const keys: { name: string; index: number; valueStartIndex: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(argsStr)) !== null) {
    keys.push({
      name: match[1],
      index: match.index,
      valueStartIndex: match.index + match[0].length
    });
  }
  
  if (keys.length === 0) {
    return {};
  }
  
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i++) {
    const currentKey = keys[i];
    const nextKey = keys[i + 1];
    let valStr = argsStr.slice(currentKey.valueStartIndex, nextKey ? nextKey.index : argsStr.length).trim();
    
    if (valStr.endsWith(',')) {
      valStr = valStr.slice(0, -1).trim();
    }
    
    let parsedVal: unknown;
    if (valStr.startsWith('<|"|>') && valStr.endsWith('<|"|>')) {
      const inner = valStr.slice(5, -5);
      parsedVal = inner.replace(/<\|"\|>/g, '"');
    } else if (valStr.startsWith('"') && valStr.endsWith('"')) {
      try {
        parsedVal = JSON.parse(valStr);
      } catch {
        parsedVal = valStr.slice(1, -1);
      }
    } else {
      if (valStr === 'true') parsedVal = true;
      else if (valStr === 'false') parsedVal = false;
      else if (valStr === 'null') parsedVal = null;
      else if (!isNaN(Number(valStr)) && valStr !== '') parsedVal = Number(valStr);
      else {
        parsedVal = valStr.replace(/<\|"\|>/g, '"');
      }
    }
    obj[currentKey.name] = parsedVal;
  }
  return obj;
}

export function wrapStreamParseGemma4ToolCalls(
  stream: ReturnType<typeof streamSimple>
): ReturnType<typeof streamSimple> {
  console.log("[ASD_DEBUG] wrapStreamParseGemma4ToolCalls instantiated");
  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  
  (stream as any)[Symbol.asyncIterator] = function () {
    const iterator = originalAsyncIterator();
    
    let status:
      | "TEXT"
      | "BUFFERING_PREFIX"
      | "BUFFERING_FALLBACK_PREFIX"
      | "BUFFERING_TOOL_NAME"
      | "PARSING_TOOL_CALL" = "TEXT";
    let prefixBuffer = "";
    let fallbackPrefixBuffer = "";
    let toolCallBuffer = "";
    let currentTextContentIndex = -1;
    let toolCallContentIndex = -1;
    let currentToolName = "";
    let currentToolCallId = "";
    const pendingEvents: any[] = [];
    
    const PREFIX = "<|tool_call>";
    const FALLBACK_PREFIX = "call:";
    const SUFFIX = "<tool_call|>";
    
    const wrapper = createStreamIteratorWrapper({
      iterator,
      next: async (streamIterator) => {
        if (pendingEvents.length > 0) {
          const ev = pendingEvents.shift();
          console.log("[ASD_DEBUG] Yielding pending event:", ev.type);
          return { done: false, value: ev };
        }
        
        while (true) {
          const result = await streamIterator.next();
          if (result.done) {
            console.log("[ASD_DEBUG] Inner stream done");
            if (pendingEvents.length > 0) {
              const ev = pendingEvents.shift();
              console.log("[ASD_DEBUG] Yielding pending event on stream end:", ev.type);
              return { done: false, value: ev };
            }
            if (prefixBuffer) {
              console.log("[ASD_DEBUG] Flushing prefixBuffer on stream end:", prefixBuffer);
              const flushedEvent = {
                type: "text_delta",
                contentIndex: currentTextContentIndex,
                delta: prefixBuffer,
                partial: null
              };
              prefixBuffer = "";
              return { done: false, value: flushedEvent };
            }
            if (fallbackPrefixBuffer) {
              console.log("[ASD_DEBUG] Flushing fallbackPrefixBuffer on stream end:", fallbackPrefixBuffer);
              const flushedEvent = {
                type: "text_delta",
                contentIndex: currentTextContentIndex,
                delta: fallbackPrefixBuffer,
                partial: null
              };
              fallbackPrefixBuffer = "";
              return { done: false, value: flushedEvent };
            }
            if (status === "BUFFERING_TOOL_NAME" || status === "PARSING_TOOL_CALL") {
              if (toolCallBuffer) {
                console.log("[ASD_DEBUG] Flushing toolCallBuffer on stream end:", toolCallBuffer);
                const flushedEvent = {
                  type: "text_delta",
                  contentIndex: currentTextContentIndex,
                  delta: toolCallBuffer,
                  partial: null
                };
                toolCallBuffer = "";
                status = "TEXT";
                return { done: false, value: flushedEvent };
              }
            }
            return result;
          }
          
          const event = result.value as any;
          if (!event || typeof event !== "object") {
            return result;
          }
          
          if (event.type !== "text_delta") {
            if (event.type === "text_start") {
              currentTextContentIndex = event.contentIndex;
            }
            return result;
          }
          
          let delta = event.delta || "";
          const partialOutput = event.partial;
          currentTextContentIndex = event.contentIndex;
          
          let processing = true;
          while (processing) {
            processing = false;
            
            if (status === "TEXT") {
              const prefixIdx = delta.indexOf(PREFIX);
              const fallbackIdx = delta.indexOf(FALLBACK_PREFIX);

              if (prefixIdx !== -1 && (fallbackIdx === -1 || prefixIdx < fallbackIdx)) {
                console.log("[ASD_DEBUG] PREFIX found fully in delta at index", prefixIdx);
                const textPart = delta.slice(0, prefixIdx);
                const postPrefixPart = delta.slice(prefixIdx + PREFIX.length);
                
                if (textPart) {
                  pendingEvents.push({ ...event, delta: textPart });
                }
                
                status = "PARSING_TOOL_CALL";
                prefixBuffer = "";
                toolCallBuffer = "";
                currentToolName = "";
                currentToolCallId = "";
                
                if (partialOutput && currentTextContentIndex !== -1) {
                  const textBlock = partialOutput.content[currentTextContentIndex];
                  if (textBlock && textBlock.type === "text" && typeof textBlock.text === "string") {
                    if (textBlock.text.endsWith(PREFIX)) {
                      console.log("[ASD_DEBUG] Stripping PREFIX from partial textBlock");
                      textBlock.text = textBlock.text.slice(0, -PREFIX.length);
                    }
                  }
                }
                
                delta = postPrefixPart;
                processing = true;
                continue;
              }

              if (fallbackIdx !== -1 && (prefixIdx === -1 || fallbackIdx < prefixIdx)) {
                console.log("[ASD_DEBUG] FALLBACK_PREFIX found fully in delta at index", fallbackIdx);
                const textPart = delta.slice(0, fallbackIdx);
                const postPrefixPart = delta.slice(fallbackIdx + FALLBACK_PREFIX.length);
                
                if (textPart) {
                  pendingEvents.push({ ...event, delta: textPart });
                }
                
                status = "BUFFERING_TOOL_NAME";
                fallbackPrefixBuffer = "";
                toolCallBuffer = FALLBACK_PREFIX;
                currentToolName = "";
                currentToolCallId = "";
                
                delta = postPrefixPart;
                processing = true;
                continue;
              }
              
              let matchedPrefixLen = 0;
              for (let i = PREFIX.length - 1; i > 0; i--) {
                const prefixPart = PREFIX.slice(0, i);
                if (delta.endsWith(prefixPart)) {
                  matchedPrefixLen = i;
                  break;
                }
              }

              let matchedFallbackPrefixLen = 0;
              for (let i = FALLBACK_PREFIX.length - 1; i > 0; i--) {
                const prefixPart = FALLBACK_PREFIX.slice(0, i);
                if (delta.endsWith(prefixPart)) {
                  matchedFallbackPrefixLen = i;
                  break;
                }
              }
              
              if (matchedPrefixLen > 0) {
                const textPart = delta.slice(0, delta.length - matchedPrefixLen);
                console.log("[ASD_DEBUG] Suffix of delta matches prefix of PREFIX. matchedPrefixLen=", matchedPrefixLen, "textPart=", JSON.stringify(textPart));
                if (textPart) {
                  pendingEvents.push({ ...event, delta: textPart });
                }
                prefixBuffer = PREFIX.slice(0, matchedPrefixLen);
                status = "BUFFERING_PREFIX";
              } else if (matchedFallbackPrefixLen > 0) {
                const textPart = delta.slice(0, delta.length - matchedFallbackPrefixLen);
                console.log("[ASD_DEBUG] Suffix of delta matches prefix of FALLBACK_PREFIX. matchedFallbackPrefixLen=", matchedFallbackPrefixLen, "textPart=", JSON.stringify(textPart));
                if (textPart) {
                  pendingEvents.push({ ...event, delta: textPart });
                }
                fallbackPrefixBuffer = FALLBACK_PREFIX.slice(0, matchedFallbackPrefixLen);
                status = "BUFFERING_FALLBACK_PREFIX";
              } else {
                if (pendingEvents.length > 0) {
                  const ev = pendingEvents.shift();
                  console.log("[ASD_DEBUG] Yielding pending event from TEXT else:", ev.type);
                  return { done: false, value: ev };
                }
                
                if (delta === event.delta) {
                  return result;
                } else if (delta !== "") {
                  return { done: false, value: { ...event, delta } };
                } else {
                  processing = false;
                }
              }
            }

            else if (status === "BUFFERING_FALLBACK_PREFIX") {
              const expectedRemaining = FALLBACK_PREFIX.slice(fallbackPrefixBuffer.length);
              if (delta.startsWith(expectedRemaining)) {
                console.log("[ASD_DEBUG] Completed fallback prefix with delta start:", expectedRemaining);
                const postPrefixPart = delta.slice(expectedRemaining.length);
                
                status = "BUFFERING_TOOL_NAME";
                fallbackPrefixBuffer = "";
                toolCallBuffer = FALLBACK_PREFIX;
                currentToolName = "";
                currentToolCallId = "";
                
                delta = postPrefixPart;
                processing = true;
                continue;
              } else if (expectedRemaining.startsWith(delta)) {
                fallbackPrefixBuffer += delta;
                console.log("[ASD_DEBUG] Appended to fallbackPrefixBuffer. New fallbackPrefixBuffer=", fallbackPrefixBuffer);
              } else {
                console.log("[ASD_DEBUG] Fallback prefix mismatch in BUFFERING_FALLBACK_PREFIX. Flushing fallbackPrefixBuffer=", fallbackPrefixBuffer, "and reprocessing delta=", delta);
                const flushedDelta = fallbackPrefixBuffer;
                fallbackPrefixBuffer = "";
                status = "TEXT";
                
                pendingEvents.push({ ...event, delta: flushedDelta });
                processing = true;
                continue;
              }
            }

            else if (status === "BUFFERING_TOOL_NAME") {
              let i = 0;
              let aborted = false;
              for (; i < delta.length; i++) {
                const char = delta[i];
                if (char === "{") {
                  console.log("[ASD_DEBUG] Found '{' in BUFFERING_TOOL_NAME. Transitioning to PARSING_TOOL_CALL");
                  currentToolName = toolCallBuffer.slice(FALLBACK_PREFIX.length);
                  currentToolCallId = "call_" + randomUUID().replace(/-/g, "");
                  status = "PARSING_TOOL_CALL";
                  toolCallBuffer += "{";
                  delta = delta.slice(i + 1);
                  processing = true;
                  break;
                } else if (/[a-zA-Z0-9_.]/.test(char)) {
                  toolCallBuffer += char;
                } else {
                  console.log(`[ASD_DEBUG] Invalid char '${char}' for tool name. Aborting fallback buffering.`);
                  aborted = true;
                  break;
                }
              }
              
              if (aborted) {
                const flushed = toolCallBuffer + delta[i];
                toolCallBuffer = "";
                status = "TEXT";
                pendingEvents.push({ ...event, delta: flushed });
                delta = delta.slice(i + 1);
                processing = true;
                continue;
              }
            }
            
            else if (status === "BUFFERING_PREFIX") {
              const expectedRemaining = PREFIX.slice(prefixBuffer.length);
              if (delta.startsWith(expectedRemaining)) {
                console.log("[ASD_DEBUG] Completed prefix with delta start:", expectedRemaining);
                const postPrefixPart = delta.slice(expectedRemaining.length);
                
                status = "PARSING_TOOL_CALL";
                prefixBuffer = "";
                toolCallBuffer = "";
                currentToolName = "";
                currentToolCallId = "";
                
                if (partialOutput && currentTextContentIndex !== -1) {
                  const textBlock = partialOutput.content[currentTextContentIndex];
                  if (textBlock && textBlock.type === "text" && typeof textBlock.text === "string") {
                    const alreadyAppended = PREFIX.slice(0, PREFIX.length - expectedRemaining.length);
                    if (textBlock.text.endsWith(alreadyAppended)) {
                      console.log("[ASD_DEBUG] Stripping already appended prefix from textBlock:", alreadyAppended);
                      textBlock.text = textBlock.text.slice(0, -alreadyAppended.length);
                    }
                  }
                }
                
                delta = postPrefixPart;
                processing = true;
                continue;
              } else if (expectedRemaining.startsWith(delta)) {
                prefixBuffer += delta;
                console.log("[ASD_DEBUG] Appended to prefixBuffer. New prefixBuffer=", prefixBuffer);
              } else {
                console.log("[ASD_DEBUG] Prefix mismatch in BUFFERING_PREFIX. Flushing prefixBuffer=", prefixBuffer, "and reprocessing delta=", delta);
                const flushedDelta = prefixBuffer;
                prefixBuffer = "";
                status = "TEXT";
                
                pendingEvents.push({ ...event, delta: flushedDelta });
                processing = true;
                continue;
              }
            }
            
            else if (status === "PARSING_TOOL_CALL") {
              toolCallBuffer += delta;
              console.log("[ASD_DEBUG] Buffering tool call. toolCallBuffer=", JSON.stringify(toolCallBuffer));
              
              if (!currentToolName) {
                const match = /call:([a-zA-Z0-9_.]+)\{/.exec(toolCallBuffer);
                if (match) {
                  currentToolName = match[1];
                  currentToolCallId = "call_" + randomUUID().replace(/-/g, "");
                  console.log("[ASD_DEBUG] Resolved tool name:", currentToolName, "id:", currentToolCallId);
                }
              }
              
              const suffixIdx = toolCallBuffer.indexOf(SUFFIX);
              if (suffixIdx !== -1) {
                const fullToolCallStr = toolCallBuffer.slice(0, suffixIdx);
                const remainingText = toolCallBuffer.slice(suffixIdx + SUFFIX.length);
                console.log("[ASD_DEBUG] Suffix matched! fullToolCallStr=", JSON.stringify(fullToolCallStr), "remainingText=", JSON.stringify(remainingText));
                
                if (!currentToolName) {
                  const match = /call:([a-zA-Z0-9_.]+)\{/.exec(fullToolCallStr);
                  if (match) {
                    currentToolName = match[1];
                    console.log("[ASD_DEBUG] Resolved tool name on suffix match:", currentToolName);
                  }
                }
                
                const openBraceIdx = fullToolCallStr.indexOf('{');
                let parsedArgs = {};
                if (openBraceIdx !== -1) {
                  const argsStr = fullToolCallStr.slice(openBraceIdx);
                  try {
                    console.log("[ASD_DEBUG] Parsing argsStr:", argsStr);
                    parsedArgs = parseGemma4Args(argsStr);
                    console.log("[ASD_DEBUG] Parsed args successfully:", parsedArgs);
                  } catch (e: any) {
                    console.error("[ASD_DEBUG] Failed to parse Gemma 4 args:", e);
                    log("error", `Failed to parse Gemma 4 args: ${e?.message || e}`);
                  }
                }
                
                if (partialOutput && currentTextContentIndex !== -1) {
                  const textBlock = partialOutput.content[currentTextContentIndex];
                  if (textBlock && textBlock.type === "text" && typeof textBlock.text === "string") {
                    const toRemoveWithPrefix = PREFIX + fullToolCallStr + SUFFIX;
                    const toRemoveWithoutPrefix = fullToolCallStr + SUFFIX;
                    console.log("[ASD_DEBUG] Stripping full tool call block from textBlock");
                    
                    let pos = textBlock.text.lastIndexOf(toRemoveWithPrefix);
                    if (pos !== -1) {
                      textBlock.text = textBlock.text.slice(0, pos) + textBlock.text.slice(pos + toRemoveWithPrefix.length);
                    } else {
                      pos = textBlock.text.lastIndexOf(toRemoveWithoutPrefix);
                      if (pos !== -1) {
                        textBlock.text = textBlock.text.slice(0, pos) + textBlock.text.slice(pos + toRemoveWithoutPrefix.length);
                      } else {
                        textBlock.text = textBlock.text.replace(toRemoveWithPrefix, "").replace(toRemoveWithoutPrefix, "");
                      }
                    }
                  }
                  
                  const toolCallBlock = {
                    type: "toolCall",
                    id: currentToolCallId || ("call_" + randomUUID().replace(/-/g, "")),
                    name: currentToolName || "unknown",
                    arguments: parsedArgs,
                    partialJson: JSON.stringify(parsedArgs)
                  };
                  partialOutput.content.push(toolCallBlock);
                  toolCallContentIndex = partialOutput.content.length - 1;
                  console.log("[ASD_DEBUG] Appended toolCall block to partialOutput. index=", toolCallContentIndex);
                }
                
                pendingEvents.push({
                  type: "toolcall_start",
                  contentIndex: toolCallContentIndex,
                  partial: partialOutput
                });
                
                pendingEvents.push({
                  type: "toolcall_end",
                  contentIndex: toolCallContentIndex,
                  toolCall: {
                    type: "toolCall",
                    id: currentToolCallId,
                    name: currentToolName,
                    arguments: parsedArgs
                  },
                  partial: partialOutput
                });
                
                if (remainingText) {
                  pendingEvents.push({
                    ...event,
                    delta: remainingText
                  });
                }

                status = "TEXT";
                toolCallBuffer = "";
                currentToolName = "";
                currentToolCallId = "";
                
                delta = "";
                processing = true;
                continue;
              }
            }
          }
        }
      }
    });
    
    return wrapper;
  };
  
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    console.log("[ASD_DEBUG] wrapStreamParseGemma4ToolCalls final message content:", JSON.stringify(message?.content));
    return message;
  };
  
  return stream;
}

export function wrapStreamFnParseGemma4ToolCalls(baseFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamParseGemma4ToolCalls(stream)
      );
    }
    return wrapStreamParseGemma4ToolCalls(maybeStream);
  };
}
