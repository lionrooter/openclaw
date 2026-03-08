import { describe, expect, it } from "vitest";
import { shouldIgnoreIMessageInboundAttachment } from "./monitor-provider.js";

describe("shouldIgnoreIMessageInboundAttachment", () => {
  it("ignores opaque .pluginPayloadAttachment files", () => {
    expect(
      shouldIgnoreIMessageInboundAttachment(
        "/Users/lionheart/Library/Messages/Attachments/x/y/z/FILE.pluginPayloadAttachment",
      ),
    ).toBe(true);
  });

  it("keeps normal inbound attachments", () => {
    expect(shouldIgnoreIMessageInboundAttachment("/tmp/photo.jpg")).toBe(false);
    expect(shouldIgnoreIMessageInboundAttachment("/tmp/note.pdf")).toBe(false);
  });

  it("returns false for empty paths", () => {
    expect(shouldIgnoreIMessageInboundAttachment(undefined)).toBe(false);
    expect(shouldIgnoreIMessageInboundAttachment(null)).toBe(false);
    expect(shouldIgnoreIMessageInboundAttachment("   ")).toBe(false);
  });
});
