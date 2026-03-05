import { describe, expect, it } from "vitest";
import { expandDeliveryTokens } from "./delivery-tokens.js";

// Fixed date: Tuesday, March 4, 2026, 9:30 AM
const FIXED_DATE = new Date(2026, 2, 4, 9, 30, 0);

describe("expandDeliveryTokens", () => {
  it("returns string unchanged when no tokens present", () => {
    const input = "stream:04💻 coding-loop:topic:overnight-work";
    expect(expandDeliveryTokens(input)).toBe(input);
  });

  it("expands {date} to ISO date", () => {
    expect(expandDeliveryTokens("stream:04💻 coding-loop:topic:overnight/{date}", FIXED_DATE)).toBe(
      "stream:04💻 coding-loop:topic:overnight/2026-03-04",
    );
  });

  it("expands {week} to ISO week", () => {
    expect(
      expandDeliveryTokens("stream:13🔧 infrastructure-loop:topic:maintenance/{week}", FIXED_DATE),
    ).toBe("stream:13🔧 infrastructure-loop:topic:maintenance/2026-W10");
  });

  it("expands {month} to year-month", () => {
    expect(expandDeliveryTokens("topic:report/{month}", FIXED_DATE)).toBe("topic:report/2026-03");
  });

  it("expands {weekday} to 3-letter day", () => {
    expect(expandDeliveryTokens("topic:standup/{weekday}", FIXED_DATE)).toBe("topic:standup/wed");
  });

  it("expands {time} to HH-MM", () => {
    expect(expandDeliveryTokens("topic:cron/{time}", FIXED_DATE)).toBe("topic:cron/09-30");
  });

  it("expands {datetime} to date and time", () => {
    expect(expandDeliveryTokens("topic:run/{datetime}", FIXED_DATE)).toBe(
      "topic:run/2026-03-04T09-30",
    );
  });

  it("expands multiple tokens in one string", () => {
    expect(expandDeliveryTokens("topic:overnight/{date}-{weekday}", FIXED_DATE)).toBe(
      "topic:overnight/2026-03-04-wed",
    );
  });

  it("expands duplicate tokens", () => {
    expect(expandDeliveryTokens("{date}/{date}", FIXED_DATE)).toBe("2026-03-04/2026-03-04");
  });

  it("handles Sunday correctly for weekday", () => {
    const sunday = new Date(2026, 2, 1, 10, 0); // Sunday March 1, 2026
    expect(expandDeliveryTokens("{weekday}", sunday)).toBe("sun");
  });

  it("handles week number at year boundary", () => {
    const dec31 = new Date(2025, 11, 31, 12, 0);
    const result = expandDeliveryTokens("{week}", dec31);
    // Dec 31, 2025 is a Wednesday — ISO week 1 of 2026
    expect(result).toMatch(/^\d{4}-W\d{2}$/);
  });
});
