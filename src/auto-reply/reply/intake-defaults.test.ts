import { describe, expect, it } from "vitest";
import { buildAgentIntakeDefaultSystemPrompt } from "./intake-defaults.js";

describe("buildAgentIntakeDefaultSystemPrompt", () => {
  it("returns Cody runtime guidance", () => {
    expect(buildAgentIntakeDefaultSystemPrompt("cody")).toContain("repo/workflow-fit analysis");
  });

  it("returns life-domain guidance for Liev", () => {
    expect(buildAgentIntakeDefaultSystemPrompt("liev")).toContain("coaching inputs");
  });

  it("returns empty string for unknown agents", () => {
    expect(buildAgentIntakeDefaultSystemPrompt("unknown")).toBe("");
  });
});
