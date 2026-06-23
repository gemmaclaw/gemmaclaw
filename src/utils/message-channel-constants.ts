export const INTERNAL_MESSAGE_CHANNEL = "webchat" as const;
export type InternalMessageChannel = typeof INTERNAL_MESSAGE_CHANNEL;

// Internal pseudo-channels that never correspond to a real deliverable surface.
// Turns whose provider is one of these (heartbeat/cron ticks, webhook fires,
// voice, internal sessions_send) must not be treated as a cross-channel switch
// that resets a session's bound native channel identity.
const INTERNAL_NON_DELIVERY_CHANNELS = [
  "heartbeat",
  "cron",
  "webhook",
  "voice",
  "sessions_send",
] as const;

export function isInternalNonDeliveryChannel(
  value: string,
): value is (typeof INTERNAL_NON_DELIVERY_CHANNELS)[number] {
  return (INTERNAL_NON_DELIVERY_CHANNELS as readonly string[]).includes(value);
}
