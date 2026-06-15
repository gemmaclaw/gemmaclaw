// Covers appendCronStyleCurrentTimeLine refresh behavior (issue #44993).
// Adapted for Gemmaclaw's single-line time format:
//   `Current time: <formattedTime> (<userTimezone>) / YYYY-MM-DD HH:MM UTC`
import { describe, expect, it } from "vitest";
import { appendCronStyleCurrentTimeLine } from "./current-time.js";

const CFG = {
  agents: {
    defaults: {
      userTimezone: "UTC",
    },
  },
};

describe("appendCronStyleCurrentTimeLine", () => {
  it("returns the empty input unchanged", () => {
    expect(appendCronStyleCurrentTimeLine("", CFG, Date.now())).toBe("");
  });

  it("appends a Current time line when none is present", () => {
    const out = appendCronStyleCurrentTimeLine(
      "Heartbeat tick",
      CFG,
      Date.parse("2026-04-30T10:00:00Z"),
    );
    expect(out).toContain("Heartbeat tick");
    expect(out).toMatch(/2026-04-30 10:00 UTC/);
  });

  it("refreshes an existing Current time line on subsequent calls (#44993)", () => {
    const oldNow = Date.parse("2026-04-30T08:00:00Z");
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const firstPass = appendCronStyleCurrentTimeLine("Heartbeat tick", CFG, oldNow);
    expect(firstPass).toMatch(/2026-04-30 08:00 UTC/);

    const secondPass = appendCronStyleCurrentTimeLine(firstPass, CFG, newNow);
    expect(secondPass).toContain("Heartbeat tick");
    expect(secondPass).toMatch(/2026-04-30 10:00 UTC/);
    expect(secondPass).not.toMatch(/2026-04-30 08:00 UTC/);
    expect(secondPass.match(/Current time:/g)?.length).toBe(1);
  });

  it("collapses multiple Current time blocks into a single fresh entry", () => {
    const stale = [
      "Heartbeat tick",
      "Current time: Wednesday, January 1st, 2025 - 12:00 AM (UTC) / 2025-01-01 00:00 UTC",
      "Current time: Thursday, January 2nd, 2025 - 12:00 AM (UTC) / 2025-01-02 00:00 UTC",
    ].join("\n");
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const out = appendCronStyleCurrentTimeLine(stale, CFG, newNow);
    expect(out).toContain("Heartbeat tick");
    expect(out).toMatch(/2026-04-30 10:00 UTC/);
    expect(out).not.toMatch(/2025-01-01 00:00 UTC/);
    expect(out).not.toMatch(/2025-01-02 00:00 UTC/);
    expect(out.match(/Current time:/g)?.length).toBe(1);
  });

  it("matches helper blocks with natural-language formattedTime and non-UTC timezone (#44993)", () => {
    const helperShape =
      "Heartbeat tick\nCurrent time: Thursday, April 30th, 2026 - 10:00 AM (Asia/Seoul) / 2026-04-30 01:00 UTC";
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const out = appendCronStyleCurrentTimeLine(helperShape, CFG, newNow);
    expect(out).not.toMatch(/Asia\/Seoul/);
    expect(out.match(/Current time:/g)?.length).toBe(1);
    expect(out).toMatch(/2026-04-30 10:00 UTC/);
  });

  it("preserves user-authored content that starts with 'Current time:'", () => {
    const userContent = "Reminder from cron:\nCurrent time: please check the dashboard before EOD";
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const out = appendCronStyleCurrentTimeLine(userContent, CFG, newNow);
    expect(out).toContain("Reminder from cron:");
    expect(out).toContain("Current time: please check the dashboard before EOD");
    expect(out).toMatch(/Current time: .+? \(UTC\) \/ 2026-04-30 10:00 UTC/);
    expect(out.match(/Current time:/g)?.length).toBe(2);
  });
});
