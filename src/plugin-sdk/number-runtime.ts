// Public numeric/timestamp helpers for plugins that parse or validate numeric values.

export {
  asDateTimestampMs,
  asFiniteNumber,
  asFiniteNumberInRange,
  isFutureDateTimestampMs,
  MAX_DATE_TIMESTAMP_MS,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
  resolveExpiresAtMsFromDurationMs,
  timestampMsToIsoString,
} from "../shared/number-coercion.js";
