import { describe, expect, it } from "vitest";
import {
  COMMITMENT_FOLLOWTHROUGH_LOOP_ID,
  EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID,
  GEMMACLAW_INSTRUCTIONS_CONTEXT_PATH,
  getDefaultGemmaclawEnhancementIds,
  listGemmaclawEnhancements,
  parseGemmaclawEnhancementSelection,
  renderGemmaclawInstructions,
  resolveGemmaclawEnhancementIds,
} from "./gemmaclaw_instructions.js";

describe("gemmaclaw instructions", () => {
  it("registers delivery receipt verification as a default enhancement", () => {
    const delivery = listGemmaclawEnhancements().find(
      (enhancement) => enhancement.id === EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID,
    );

    expect(GEMMACLAW_INSTRUCTIONS_CONTEXT_PATH).toBe("gemmaclaw_instructions.ts");
    expect(delivery).toMatchObject({
      id: EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID,
      defaultEnabled: true,
      docsPath: "docs/gemmaclaw/enhancements.md",
    });
    expect(delivery?.benchmarkIds).toContain("scheduled_media_delivery_verification");
    expect(getDefaultGemmaclawEnhancementIds()).toContain(
      EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID,
    );
  });

  it("registers commitment follow-through as a default enhancement", () => {
    const followThrough = listGemmaclawEnhancements().find(
      (enhancement) => enhancement.id === COMMITMENT_FOLLOWTHROUGH_LOOP_ID,
    );

    expect(followThrough).toMatchObject({
      id: COMMITMENT_FOLLOWTHROUGH_LOOP_ID,
      defaultEnabled: true,
      docsPath: "docs/gemmaclaw/enhancements.md",
    });
    expect(followThrough?.benchmarkIds).toContain("commitment_followthrough_verification");
    expect(getDefaultGemmaclawEnhancementIds()).toContain(COMMITMENT_FOLLOWTHROUGH_LOOP_ID);
  });

  it("renders runtime-injected instructions with receipt and scheduler verification rules", () => {
    const markdown = renderGemmaclawInstructions();

    expect(markdown).toContain("## Gemmaclaw Instructions");
    expect(markdown).toContain("not copied into AGENTS.md");
    expect(markdown).toContain("You are running as a Gemmaclaw agent");
    expect(markdown).toContain("https://github.com/gemmaclaw/gemmaclaw");
    expect(markdown).toContain("https://gemmaclaw.github.io/gemmaclaw/");
    expect(markdown).toContain("clone the repository to `~/gemmaclaw` if it is missing");
    expect(markdown).toContain("update it to the latest default branch");
    expect(markdown).toContain("external_delivery_receipt_verification");
    expect(markdown).toContain("scheduled_media_delivery_verification");
    expect(markdown).toContain("send receipt");
    expect(markdown).toContain("!= delivery proof");
    expect(markdown).toContain("active scheduler");
    expect(markdown).toContain("commitment_followthrough_loop");
    expect(markdown).toContain("commitment_followthrough_verification");
    expect(markdown).toContain("durable Gemmaclaw-native follow-up");
    expect(markdown).toContain("Reply only after completed work");
    expect(markdown).toContain("host crontab/systemd");
    expect(markdown).toContain("command runs");
    expect(markdown).toContain("explicit interpreter");
    expect(markdown).toContain("valid shebang/interpreter");
    expect(markdown).toContain("local work loop");
    expect(markdown).toContain("observable subtasks");
    expect(markdown).toContain("QA/read-back");
    expect(markdown).toContain("Idle trigger");
    expect(markdown).toContain("no active owner/subagent/session");
  });

  it("keeps default runtime enhancement injection concise for local model contexts", () => {
    const markdown = renderGemmaclawInstructions();
    const enhancementMarkdown =
      markdown.split("### External delivery receipt verification")[1] ?? "";

    expect(enhancementMarkdown.length).toBeLessThanOrEqual(1_650);
  });

  it("supports default, all, none, and explicit id selections", () => {
    expect(resolveGemmaclawEnhancementIds(undefined)).toEqual([
      EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID,
      COMMITMENT_FOLLOWTHROUGH_LOOP_ID,
    ]);
    expect(resolveGemmaclawEnhancementIds("default")).toEqual([
      EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID,
      COMMITMENT_FOLLOWTHROUGH_LOOP_ID,
    ]);
    expect(resolveGemmaclawEnhancementIds("all")).toEqual([
      EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID,
      COMMITMENT_FOLLOWTHROUGH_LOOP_ID,
    ]);
    expect(resolveGemmaclawEnhancementIds("none")).toEqual([]);
    expect(resolveGemmaclawEnhancementIds(EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID)).toEqual([
      EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID,
    ]);
    expect(resolveGemmaclawEnhancementIds(COMMITMENT_FOLLOWTHROUGH_LOOP_ID)).toEqual([
      COMMITMENT_FOLLOWTHROUGH_LOOP_ID,
    ]);
    expect(
      resolveGemmaclawEnhancementIds(
        `${EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID},${COMMITMENT_FOLLOWTHROUGH_LOOP_ID}`,
      ),
    ).toEqual([EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID, COMMITMENT_FOLLOWTHROUGH_LOOP_ID]);
  });

  it("parses workspace enhancement selections for runtime injection", () => {
    expect(parseGemmaclawEnhancementSelection('{"enhancements":[]}')).toEqual([]);
    expect(
      parseGemmaclawEnhancementSelection(
        `{"enhancements":["${EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID}"]}`,
      ),
    ).toEqual([EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID]);
    expect(
      parseGemmaclawEnhancementSelection(
        `{"enhancements":["${EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID}","${COMMITMENT_FOLLOWTHROUGH_LOOP_ID}"]}`,
      ),
    ).toEqual([EXTERNAL_DELIVERY_RECEIPT_VERIFICATION_ID, COMMITMENT_FOLLOWTHROUGH_LOOP_ID]);
  });

  it("rejects unknown enhancement ids loudly", () => {
    expect(() => resolveGemmaclawEnhancementIds("bogus")).toThrow(/Unknown Gemmaclaw enhancement/);
    expect(() => parseGemmaclawEnhancementSelection('{"enhancements":["bogus"]}')).toThrow(
      /Unknown Gemmaclaw enhancement/,
    );
    expect(() => parseGemmaclawEnhancementSelection('{"enhancements":[42]}')).toThrow(
      /string ids only/,
    );
  });
});
