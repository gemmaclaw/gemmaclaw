import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { buildGroupDisplayName, resolveGroupSessionKey } from "./group.js";
import type { GroupKeyResolution, SessionEntry, SessionOrigin } from "./types.js";

function isSystemEventProvider(provider?: string): boolean {
  return provider === "heartbeat" || provider === "cron-event" || provider === "exec-event";
}

const mergeOrigin = (
  existing: SessionOrigin | undefined,
  next: SessionOrigin | undefined,
): SessionOrigin | undefined => {
  if (!existing && !next) {
    return undefined;
  }
  const merged: SessionOrigin = existing ? { ...existing } : {};
  // A provider/surface/account change is a fresh channel identity (e.g. a dmScope:"main" session
  // moving Slack -> Telegram, or between Slack accounts). Channel-keyed fields belong to the prior
  // channel; drop them so an inbound that omits them does not keep reactions, native threading, and
  // status reads pointed at the previous channel.
  // Only a real, deliverable channel switch should reset the bound identity. A
  // non-delivery turn (gateway webchat send, heartbeat/cron/webhook tick,
  // voice, internal sessions_send, or a system-event provider) derives its
  // origin provider as an internal channel and must not wipe the session's live
  // native channel/thread identity even though the session never left it.
  const nextProvider = next?.provider;
  const nextIsDeliverableChannel =
    nextProvider != null &&
    nextProvider !== INTERNAL_MESSAGE_CHANNEL &&
    !isInternalNonDeliveryChannel(nextProvider) &&
    !isSystemEventProvider(nextProvider);
  const channelChanged =
    existing != null &&
    nextIsDeliverableChannel &&
    ((existing.provider != null && nextProvider !== existing.provider) ||
      (existing.surface != null && next?.surface != null && next.surface !== existing.surface) ||
      (existing.accountId != null &&
        next?.accountId != null &&
        next.accountId !== existing.accountId));
  if (channelChanged) {
    delete merged.nativeChannelId;
    delete merged.nativeDirectUserId;
    delete merged.accountId;
    delete merged.threadId;
  }
  if (next?.label) {
    merged.label = next.label;
  }
  if (next?.provider) {
    merged.provider = next.provider;
  }
  if (next?.surface) {
    merged.surface = next.surface;
  }
  if (next?.chatType) {
    merged.chatType = next.chatType;
  }
  if (next?.from) {
    merged.from = next.from;
  }
  if (next?.to) {
    merged.to = next.to;
  }
  if (next?.nativeChannelId) {
    merged.nativeChannelId = next.nativeChannelId;
  }
  if (next?.nativeDirectUserId) {
    merged.nativeDirectUserId = next.nativeDirectUserId;
  }
  if (next?.accountId) {
    merged.accountId = next.accountId;
  }
  if (next?.threadId != null && next.threadId !== "") {
    merged.threadId = next.threadId;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
};

export function deriveSessionOrigin(
  ctx: MsgContext,
  opts?: { skipSystemEventOrigin?: boolean },
): SessionOrigin | undefined {
  if (opts?.skipSystemEventOrigin && isSystemEventProvider(ctx.Provider)) {
    return undefined;
  }
  const label = normalizeOptionalString(resolveConversationLabel(ctx));
  const providerRaw =
    (typeof ctx.OriginatingChannel === "string" && ctx.OriginatingChannel) ||
    ctx.Surface ||
    ctx.Provider;
  const provider = normalizeMessageChannel(providerRaw);
  const surface = normalizeOptionalLowercaseString(ctx.Surface);
  const chatType = normalizeChatType(ctx.ChatType) ?? undefined;
  const from = normalizeOptionalString(ctx.From);
  const to = normalizeOptionalString(
    typeof ctx.OriginatingTo === "string" ? ctx.OriginatingTo : ctx.To,
  );
  const nativeChannelId = normalizeOptionalString(ctx.NativeChannelId);
  const nativeDirectUserId = normalizeOptionalString(ctx.NativeDirectUserId);
  const accountId = normalizeOptionalString(ctx.AccountId);
  const threadId = ctx.MessageThreadId ?? undefined;

  const origin: SessionOrigin = {};
  if (label) {
    origin.label = label;
  }
  if (provider) {
    origin.provider = provider;
  }
  if (surface) {
    origin.surface = surface;
  }
  if (chatType) {
    origin.chatType = chatType;
  }
  if (from) {
    origin.from = from;
  }
  if (to) {
    origin.to = to;
  }
  if (nativeChannelId) {
    origin.nativeChannelId = nativeChannelId;
  }
  if (nativeDirectUserId) {
    origin.nativeDirectUserId = nativeDirectUserId;
  }
  if (accountId) {
    origin.accountId = accountId;
  }
  if (threadId != null && threadId !== "") {
    origin.threadId = threadId;
  }

  return Object.keys(origin).length > 0 ? origin : undefined;
}

export function snapshotSessionOrigin(entry?: SessionEntry): SessionOrigin | undefined {
  if (!entry?.origin) {
    return undefined;
  }
  return { ...entry.origin };
}

export function deriveGroupSessionPatch(params: {
  ctx: MsgContext;
  sessionKey: string;
  existing?: SessionEntry;
  groupResolution?: GroupKeyResolution | null;
}): Partial<SessionEntry> | null {
  const resolution = params.groupResolution ?? resolveGroupSessionKey(params.ctx);
  if (!resolution?.channel) {
    return null;
  }

  const channel = resolution.channel;
  const subject = params.ctx.GroupSubject?.trim();
  const space = params.ctx.GroupSpace?.trim();
  const explicitChannel = params.ctx.GroupChannel?.trim();
  const subjectLooksChannel = Boolean(subject?.startsWith("#"));
  const normalizedChannel =
    subjectLooksChannel && resolution.chatType !== "channel" ? normalizeChannelId(channel) : null;
  const isChannelProvider = Boolean(
    normalizedChannel &&
    getChannelPlugin(normalizedChannel)?.capabilities.chatTypes.includes("channel"),
  );
  const nextGroupChannel =
    explicitChannel ??
    (subjectLooksChannel && subject && (resolution.chatType === "channel" || isChannelProvider)
      ? subject
      : undefined);
  const nextSubject = nextGroupChannel ? undefined : subject;

  const patch: Partial<SessionEntry> = {
    chatType: resolution.chatType ?? "group",
    channel,
    groupId: resolution.id,
  };
  if (nextSubject) {
    patch.subject = nextSubject;
  }
  if (nextGroupChannel) {
    patch.groupChannel = nextGroupChannel;
  }
  if (space) {
    patch.space = space;
  }

  const displayName = buildGroupDisplayName({
    provider: channel,
    subject: nextSubject ?? params.existing?.subject,
    groupChannel: nextGroupChannel ?? params.existing?.groupChannel,
    space: space ?? params.existing?.space,
    id: resolution.id,
    key: params.sessionKey,
  });
  if (displayName) {
    patch.displayName = displayName;
  }

  return patch;
}

export function deriveSessionMetaPatch(params: {
  ctx: MsgContext;
  sessionKey: string;
  existing?: SessionEntry;
  groupResolution?: GroupKeyResolution | null;
  skipSystemEventOrigin?: boolean;
}): Partial<SessionEntry> | null {
  const groupPatch = deriveGroupSessionPatch(params);
  const origin = deriveSessionOrigin(params.ctx, {
    skipSystemEventOrigin: params.skipSystemEventOrigin,
  });
  if (!groupPatch && !origin) {
    return null;
  }

  const patch: Partial<SessionEntry> = groupPatch ? { ...groupPatch } : {};
  const mergedOrigin = mergeOrigin(params.existing?.origin, origin);
  if (mergedOrigin) {
    patch.origin = mergedOrigin;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
