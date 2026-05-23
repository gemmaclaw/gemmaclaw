export const EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_PROMPT = [
  "### External delivery receipt verification",
  "",
  "- Enhancement id: `external_delivery_receipt_verification`",
  "- Guarded by benchmark: `scheduled_media_delivery_verification`",
  "- Do not claim delivery (message/media/email/calendar/webhook/scheduled send) until provider response, send receipt, log, or mock receipt proves success.",
  "- Artifacts, scripts, scheduler edits, tool intent != delivery proof.",
  "- Missing/failed/ambiguous proof: say unverified and keep investigating.",
  "- Scheduled send: verify active scheduler + trigger/run proof, not copied config.",
].join("\n");
