import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { __testing, evaluateWorkflowLaneGuard } from "./workflow-lane-policy.js";

function configWithLane(params: {
  agentId?: string;
  defaults?: OpenClawConfig["agents"];
}): OpenClawConfig {
  const agentId = params.agentId ?? "main";
  return {
    agents: {
      ...params.defaults,
      list: [{ id: agentId }],
    },
  };
}

describe("workflow lane guard", () => {
  beforeEach(() => {
    __testing.resetWorkflowLaneState();
  });

  it("blocks coding mutations before ANCHOR", () => {
    const cfg = configWithLane({ agentId: "cody" });
    const result = evaluateWorkflowLaneGuard({
      toolName: "write",
      params: { path: "src/main.ts", content: "x" },
      ctx: { agentId: "cody", sessionKey: "agent:cody:main" },
      config: cfg,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("missing ANCHOR before mutation");
  });

  it("allows coding mutations after ANCHOR", () => {
    const cfg = configWithLane({ agentId: "cody" });
    const ctx = { agentId: "cody", sessionKey: "agent:cody:main" };

    expect(
      evaluateWorkflowLaneGuard({
        toolName: "exec",
        params: { command: 'rp-cli context_builder task="x"' },
        ctx,
        config: cfg,
      }).blocked,
    ).toBe(false);

    const result = evaluateWorkflowLaneGuard({
      toolName: "write",
      params: { path: "src/main.ts", content: "updated" },
      ctx,
      config: cfg,
    });

    expect(result.blocked).toBe(false);
  });

  it("blocks coding finalization until REVIEW and VERIFY happen after the latest mutation", () => {
    const cfg = configWithLane({ agentId: "cody" });
    const ctx = { agentId: "cody", sessionKey: "agent:cody:finalize" };

    evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: 'rp-cli context_builder task="x"' },
      ctx,
      config: cfg,
    });
    evaluateWorkflowLaneGuard({
      toolName: "write",
      params: { path: "src/main.ts", content: "updated" },
      ctx,
      config: cfg,
    });

    const beforeReview = evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: "git commit -m test" },
      ctx,
      config: cfg,
    });
    expect(beforeReview.blocked).toBe(true);
    expect(beforeReview.reason).toContain("missing REVIEW after last mutation before finalizing");

    evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: "rp-cli review" },
      ctx,
      config: cfg,
    });

    const beforeVerify = evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: "git commit -m test" },
      ctx,
      config: cfg,
    });
    expect(beforeVerify.blocked).toBe(true);
    expect(beforeVerify.reason).toContain("missing VERIFY after last mutation before finalizing");

    evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: "pnpm test" },
      ctx,
      config: cfg,
    });

    const allowed = evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: "git commit -m test" },
      ctx,
      config: cfg,
    });
    expect(allowed.blocked).toBe(false);
  });

  it("invalidates earlier review and verify after a later coding mutation", () => {
    const cfg = configWithLane({ agentId: "cody" });
    const ctx = { agentId: "cody", sessionKey: "agent:cody:stale-review" };

    evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: 'rp-cli context_builder task="x"' },
      ctx,
      config: cfg,
    });
    evaluateWorkflowLaneGuard({
      toolName: "write",
      params: { path: "src/main.ts", content: "first" },
      ctx,
      config: cfg,
    });
    evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: "rp-cli review" },
      ctx,
      config: cfg,
    });
    evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: "pnpm test" },
      ctx,
      config: cfg,
    });
    evaluateWorkflowLaneGuard({
      toolName: "write",
      params: { path: "src/main.ts", content: "second" },
      ctx,
      config: cfg,
    });

    const result = evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: "git commit -m test" },
      ctx,
      config: cfg,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("missing REVIEW after last mutation before finalizing");
  });

  it("translates legacy mutationPolicy so review and verify block finalization, not mutation", () => {
    const cfg = {
      agents: {
        defaults: {
          workflowLane: {
            domain: "coding",
            mode: "hard",
            applyWhen: "dev-intent",
            mutationPolicy: {
              blockBeforeAnchor: true,
              blockBeforeReview: true,
              blockBeforeVerify: true,
            },
          },
        },
        list: [{ id: "cody" }],
      },
    } satisfies OpenClawConfig;
    const ctx = { agentId: "cody", sessionKey: "agent:cody:legacy-policy" };

    evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: 'rp-cli context_builder task="x"' },
      ctx,
      config: cfg,
    });

    const writeResult = evaluateWorkflowLaneGuard({
      toolName: "write",
      params: { path: "src/main.ts", content: "updated" },
      ctx,
      config: cfg,
    });
    expect(writeResult.blocked).toBe(false);

    const commitResult = evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: "git commit -m test" },
      ctx,
      config: cfg,
    });
    expect(commitResult.blocked).toBe(true);
    expect(commitResult.reason).toContain("missing REVIEW after last mutation before finalizing");
  });

  it("enforces the narrative lane for high-impact cross-session sends", () => {
    const cfg = {
      agents: {
        defaults: {
          workflowLane: {
            domain: "narrative",
            applyWhen: "always",
            mode: "hard",
          },
        },
        list: [{ id: "storie" }],
      },
    } satisfies OpenClawConfig;
    const ctx = { agentId: "storie", sessionKey: "agent:storie:main" };

    const blocked = evaluateWorkflowLaneGuard({
      toolName: "sessions_send",
      params: { sessionKey: "agent:main:main", message: "status" },
      ctx,
      config: cfg,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain("missing ANCHOR");
  });

  it("treats review as enough verify for non-mutating non-coding runs", () => {
    const cfg = {
      agents: {
        defaults: {
          workflowLane: {
            domain: "growth",
            applyWhen: "always",
            mode: "hard",
          },
        },
        list: [{ id: "grove" }],
      },
    } satisfies OpenClawConfig;
    const ctx = { agentId: "grove", sessionKey: "agent:grove:main" };

    evaluateWorkflowLaneGuard({
      toolName: "read",
      params: { path: "/Users/lionheart/clawd/agents/grove/workflows/grove_Context.md" },
      ctx,
      config: cfg,
    });
    evaluateWorkflowLaneGuard({
      toolName: "read",
      params: { path: "/Users/lionheart/clawd/agents/grove/workflows/grove_Review-Checklist.md" },
      ctx,
      config: cfg,
    });

    const result = evaluateWorkflowLaneGuard({
      toolName: "sessions_send",
      params: { sessionKey: "agent:main:main", message: "daily pulse" },
      ctx,
      config: cfg,
    });
    expect(result.blocked).toBe(false);
  });

  it("does not let mutating exec satisfy verify for non-coding lanes", () => {
    const cfg = {
      agents: {
        defaults: {
          workflowLane: {
            domain: "strategy",
            applyWhen: "always",
            mode: "hard",
          },
        },
        list: [{ id: "leo" }],
      },
    } satisfies OpenClawConfig;
    const ctx = { agentId: "leo", sessionKey: "agent:leo:mutating-checkout" };

    evaluateWorkflowLaneGuard({
      toolName: "read",
      params: { path: "/Users/lionheart/clawd/agents/leo/workflows/leo_Workflow-SKILL.md" },
      ctx,
      config: cfg,
    });
    evaluateWorkflowLaneGuard({
      toolName: "read",
      params: { path: "/Users/lionheart/clawd/agents/leo/workflows/leo_Review-Checklist.md" },
      ctx,
      config: cfg,
    });

    const result = evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: "git checkout feature/sweep" },
      ctx,
      config: cfg,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("missing VERIFY before high-impact mutation");
  });

  it("ignores blank stage checks instead of auto-matching everything", () => {
    const cfg = {
      agents: {
        defaults: {
          workflowLane: {
            domain: "strategy",
            applyWhen: "always",
            mode: "hard",
            stageChecks: {
              anchor: ["   "],
            },
            requiredStages: {
              anchor: true,
              review: false,
              verify: false,
              gate: false,
            },
            actionRequirements: {
              finalize: {
                anchor: true,
                review: false,
                verify: false,
                gate: false,
              },
            },
          },
        },
        list: [{ id: "leo" }],
      },
    } satisfies OpenClawConfig;
    const ctx = { agentId: "leo", sessionKey: "agent:leo:blank-stage-checks" };

    const result = evaluateWorkflowLaneGuard({
      toolName: "sessions_send",
      params: { sessionKey: "agent:main:main", message: "status" },
      ctx,
      config: cfg,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("missing ANCHOR");
  });

  it("preserves global requiredStages when agent overrides one nested field", () => {
    const cfg = {
      agents: {
        defaults: {
          workflowLane: {
            domain: "strategy",
            applyWhen: "always",
            mode: "hard",
            requiredStages: {
              anchor: false,
              review: true,
              verify: false,
              gate: false,
            },
          },
        },
        list: [
          {
            id: "leo",
            workflowLane: {
              requiredStages: {
                anchor: true,
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;
    const ctx = { agentId: "leo", sessionKey: "agent:leo:required-stages-merge" };

    const blocked = evaluateWorkflowLaneGuard({
      toolName: "sessions_send",
      params: { sessionKey: "agent:main:main", message: "status" },
      ctx,
      config: cfg,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain("missing ANCHOR");
  });

  it("preserves global actionRequirements when agent overrides one nested field", () => {
    const cfg = {
      agents: {
        defaults: {
          workflowLane: {
            domain: "coding",
            applyWhen: "dev-intent",
            mode: "hard",
            actionRequirements: {
              mutation: {
                anchor: false,
                review: false,
                verify: false,
                gate: false,
              },
              finalize: {
                anchor: true,
                review: true,
                verify: false,
                gate: false,
              },
            },
          },
        },
        list: [
          {
            id: "cody",
            workflowLane: {
              actionRequirements: {
                mutation: {
                  anchor: true,
                },
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;
    const ctx = { agentId: "cody", sessionKey: "agent:cody:action-requirements-merge" };

    const blocked = evaluateWorkflowLaneGuard({
      toolName: "write",
      params: { path: "src/main.ts", content: "updated" },
      ctx,
      config: cfg,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain("missing ANCHOR before mutation");
  });

  it("falls back safely when workflow lane domain is invalid", () => {
    const cfg = {
      agents: {
        defaults: {
          workflowLane: {
            domain: "toString" as unknown as "ops",
            applyWhen: "always",
            mode: "hard",
          },
        },
        list: [{ id: "leo" }],
      },
    } satisfies OpenClawConfig;
    const ctx = { agentId: "leo", sessionKey: "agent:leo:invalid-domain" };

    const result = evaluateWorkflowLaneGuard({
      toolName: "sessions_send",
      params: { sessionKey: "agent:main:main", message: "status" },
      ctx,
      config: cfg,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("missing ANCHOR");
  });

  it("falls back safely when mode or applyWhen are invalid", () => {
    const cfg = {
      agents: {
        defaults: {
          workflowLane: {
            domain: "strategy",
            applyWhen: "maybe-later" as unknown as "always",
            mode: "disabled" as unknown as "hard",
          },
        },
        list: [{ id: "leo" }],
      },
    } satisfies OpenClawConfig;
    const ctx = { agentId: "leo", sessionKey: "agent:leo:invalid-mode-apply-when" };

    const result = evaluateWorkflowLaneGuard({
      toolName: "sessions_send",
      params: { sessionKey: "agent:main:main", message: "status" },
      ctx,
      config: cfg,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("missing ANCHOR");
  });
});
