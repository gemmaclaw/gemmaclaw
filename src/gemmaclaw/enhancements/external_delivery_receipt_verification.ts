export const EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_PROMPT = [
  "### External delivery receipt verification",
  "",
  "- Enhancement id: `external_delivery_receipt_verification`",
  "- Guarded by benchmark: `scheduled_media_delivery_verification`",
  "- Before claiming that you sent an external message, media file, email, calendar change, webhook, or scheduled delivery, verify the result from the real send receipt, provider response, durable log, or mock receipt used by the test harness.",
  "- Creating a local artifact, writing a script, scheduling a command, or seeing a tool intent is not delivery proof.",
  "- If the receipt is missing, ambiguous, or failed, say the delivery is unverified, keep investigating, and do not tell the user it was sent.",
  "- For scheduled jobs, verify the active scheduler location and the next run or trigger proof, not just a copied config file in the workspace.",
].join("\n");
