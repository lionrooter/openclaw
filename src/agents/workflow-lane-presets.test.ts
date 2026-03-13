import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyRecommendedWorkflowLaneConfig,
  applyRecommendedWorkflowLaneToAgentEntry,
  resolveRecommendedWorkflowLaneForAgent,
  resolveWorkflowLaneDomainForAgent,
} from "./workflow-lane-presets.js";

describe("workflow lane presets", () => {
  it("resolves known domain-agent mappings", () => {
    expect(resolveWorkflowLaneDomainForAgent("main")).toBe("ops");
    expect(resolveWorkflowLaneDomainForAgent("clawdy")).toBe("ops");
    expect(resolveWorkflowLaneDomainForAgent("cody")).toBe("coding");
    expect(resolveWorkflowLaneDomainForAgent("leo")).toBe("strategy");
    expect(resolveWorkflowLaneDomainForAgent("storie")).toBe("narrative");
    expect(resolveWorkflowLaneDomainForAgent("maclern")).toBe("research");
    expect(resolveWorkflowLaneDomainForAgent("mako")).toBe("maker");
    expect(resolveWorkflowLaneDomainForAgent("unknown")).toBeUndefined();
    expect(resolveWorkflowLaneDomainForAgent("toString")).toBeUndefined();
  });

  it("returns hard-mode recommendations per known agent", () => {
    expect(resolveRecommendedWorkflowLaneForAgent("cody")).toEqual({
      enabled: true,
      mode: "hard",
      domain: "coding",
      applyWhen: "dev-intent",
    });
    expect(resolveRecommendedWorkflowLaneForAgent("storie")).toEqual({
      enabled: true,
      mode: "hard",
      domain: "narrative",
      applyWhen: "always",
    });
    expect(resolveRecommendedWorkflowLaneForAgent("maclern")).toEqual({
      enabled: true,
      mode: "hard",
      domain: "research",
      applyWhen: "always",
    });
  });

  it("hydrates defaults and known agent entries when missing", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "cody" }, { id: "storie" }, { id: "maclern" }, { id: "custom" }],
      },
    };

    const next = applyRecommendedWorkflowLaneConfig(cfg);
    expect(next.agents?.defaults?.workflowLane).toEqual({
      enabled: true,
      mode: "hard",
      domain: "ops",
      applyWhen: "always",
    });
    expect(next.agents?.list?.find((entry) => entry.id === "cody")?.workflowLane).toEqual({
      enabled: true,
      mode: "hard",
      domain: "coding",
      applyWhen: "dev-intent",
    });
    expect(next.agents?.list?.find((entry) => entry.id === "storie")?.workflowLane).toEqual({
      enabled: true,
      mode: "hard",
      domain: "narrative",
      applyWhen: "always",
    });
    expect(next.agents?.list?.find((entry) => entry.id === "maclern")?.workflowLane).toEqual({
      enabled: true,
      mode: "hard",
      domain: "research",
      applyWhen: "always",
    });
    expect(next.agents?.list?.find((entry) => entry.id === "custom")?.workflowLane).toBeUndefined();
  });

  it("preserves explicit workflow lane overrides", () => {
    const entry = applyRecommendedWorkflowLaneToAgentEntry({
      id: "leo",
      workflowLane: { domain: "growth", mode: "soft" },
    });
    expect(entry.workflowLane).toEqual({ domain: "growth", mode: "soft" });
  });

  it("returns original config when nothing needs to change", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workflowLane: { enabled: true, mode: "hard", domain: "ops", applyWhen: "always" },
        },
        list: [
          {
            id: "cody",
            workflowLane: {
              enabled: true,
              mode: "hard",
              domain: "coding",
              applyWhen: "dev-intent",
            },
          },
        ],
      },
    };
    const next = applyRecommendedWorkflowLaneConfig(cfg);
    expect(next).toBe(cfg);
  });
});
