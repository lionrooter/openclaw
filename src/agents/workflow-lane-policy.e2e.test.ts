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
    expect(result.reason).toContain("missing ANCHOR");
  });

  it("allows coding mutations after ANCHOR + REVIEW + VERIFY", () => {
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
    expect(
      evaluateWorkflowLaneGuard({
        toolName: "exec",
        params: { command: "rp-cli review" },
        ctx,
        config: cfg,
      }).blocked,
    ).toBe(false);
    expect(
      evaluateWorkflowLaneGuard({
        toolName: "exec",
        params: { command: "pnpm test" },
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

  it("enforces strategy lane for high-impact cross-session sends", () => {
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
    const ctx = { agentId: "leo", sessionKey: "agent:leo:main" };

    const blocked = evaluateWorkflowLaneGuard({
      toolName: "sessions_send",
      params: { sessionKey: "agent:main:main", message: "status" },
      ctx,
      config: cfg,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain("missing ANCHOR");

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
    evaluateWorkflowLaneGuard({
      toolName: "edit",
      params: { path: "/Users/lionheart/clawd/agents/leo/workflows/leo_Maintenance-Log.md" },
      ctx,
      config: cfg,
    });

    const allowed = evaluateWorkflowLaneGuard({
      toolName: "sessions_send",
      params: { sessionKey: "agent:main:main", message: "done" },
      ctx,
      config: cfg,
    });
    expect(allowed.blocked).toBe(false);
  });

  it("does not gate regular message sends for non-coding lanes", () => {
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
    const ctx = { agentId: "leo", sessionKey: "agent:leo:main" };

    const result = evaluateWorkflowLaneGuard({
      toolName: "message",
      params: { action: "send", message: "status" },
      ctx,
      config: cfg,
    });
    expect(result.blocked).toBe(false);
  });

  it("treats review as verify for non-mutating domain runs", () => {
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
    expect(result.reason).toContain("missing VERIFY");
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
            mutationPolicy: {
              blockBeforeAnchor: true,
              blockBeforeReview: false,
              blockBeforeVerify: false,
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

  it("handles malformed stageChecks values without crashing", () => {
    const cfg = {
      agents: {
        defaults: {
          workflowLane: {
            domain: "strategy",
            applyWhen: "always",
            mode: "hard",
            stageChecks: {
              anchor: [123, "  "] as unknown as string[],
            },
            requiredStages: {
              anchor: true,
              review: false,
              verify: false,
              gate: false,
            },
            mutationPolicy: {
              blockBeforeAnchor: true,
              blockBeforeReview: false,
              blockBeforeVerify: false,
            },
          },
        },
        list: [{ id: "leo" }],
      },
    } satisfies OpenClawConfig;
    const ctx = { agentId: "leo", sessionKey: "agent:leo:malformed-stage-checks" };

    const result = evaluateWorkflowLaneGuard({
      toolName: "sessions_send",
      params: { sessionKey: "agent:main:main", message: "status" },
      ctx,
      config: cfg,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("missing ANCHOR");
  });

  it("does not treat `git status` as non-coding verify", () => {
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
    const ctx = { agentId: "leo", sessionKey: "agent:leo:status-not-verify" };

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
    evaluateWorkflowLaneGuard({
      toolName: "edit",
      params: { path: "/Users/lionheart/clawd/agents/leo/workflows/leo_Notes.md" },
      ctx,
      config: cfg,
    });
    evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: "git status" },
      ctx,
      config: cfg,
    });

    const result = evaluateWorkflowLaneGuard({
      toolName: "sessions_send",
      params: { sessionKey: "agent:main:main", message: "status" },
      ctx,
      config: cfg,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("missing VERIFY");
  });

  it("does not flip coding dev-intent on passive reads", () => {
    const cfg = {
      agents: {
        defaults: {
          workflowLane: {
            domain: "coding",
            applyWhen: "dev-intent",
            mode: "hard",
          },
        },
        list: [{ id: "cody" }],
      },
    } satisfies OpenClawConfig;
    const ctx = { agentId: "cody", sessionKey: "agent:cody:read-only" };

    evaluateWorkflowLaneGuard({
      toolName: "read",
      params: { path: "README.md" },
      ctx,
      config: cfg,
    });

    const state = __testing.stageStateBySession.get("session:agent:cody:read-only");
    expect(state?.devIntent).toBe(false);
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
              review: false,
              verify: false,
              gate: false,
            },
            mutationPolicy: {
              blockBeforeAnchor: true,
              blockBeforeReview: true,
              blockBeforeVerify: true,
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

    evaluateWorkflowLaneGuard({
      toolName: "read",
      params: { path: "/Users/lionheart/clawd/agents/leo/workflows/leo_Workflow-SKILL.md" },
      ctx,
      config: cfg,
    });

    const allowed = evaluateWorkflowLaneGuard({
      toolName: "sessions_send",
      params: { sessionKey: "agent:main:main", message: "status" },
      ctx,
      config: cfg,
    });
    expect(allowed.blocked).toBe(false);
  });

  it("preserves global mutationPolicy when agent overrides one nested field", () => {
    const cfg = {
      agents: {
        defaults: {
          workflowLane: {
            domain: "strategy",
            applyWhen: "always",
            mode: "hard",
            requiredStages: {
              anchor: true,
              review: true,
              verify: false,
              gate: false,
            },
            mutationPolicy: {
              blockBeforeAnchor: false,
              blockBeforeReview: false,
              blockBeforeVerify: false,
            },
          },
        },
        list: [
          {
            id: "leo",
            workflowLane: {
              mutationPolicy: {
                blockBeforeAnchor: true,
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;
    const ctx = { agentId: "leo", sessionKey: "agent:leo:mutation-policy-merge" };

    evaluateWorkflowLaneGuard({
      toolName: "read",
      params: { path: "/Users/lionheart/clawd/agents/leo/workflows/leo_Workflow-SKILL.md" },
      ctx,
      config: cfg,
    });

    const allowed = evaluateWorkflowLaneGuard({
      toolName: "sessions_send",
      params: { sessionKey: "agent:main:main", message: "status" },
      ctx,
      config: cfg,
    });
    expect(allowed.blocked).toBe(false);
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

  it("falls back safely when mode/applyWhen are invalid", () => {
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

  it("does not mark review on regex substrings like `different`", () => {
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
    const ctx = { agentId: "leo", sessionKey: "agent:leo:review-regex-boundary" };

    evaluateWorkflowLaneGuard({
      toolName: "read",
      params: { path: "/Users/lionheart/clawd/agents/leo/workflows/leo_Workflow-SKILL.md" },
      ctx,
      config: cfg,
    });
    evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: "echo different" },
      ctx,
      config: cfg,
    });

    const result = evaluateWorkflowLaneGuard({
      toolName: "sessions_send",
      params: { sessionKey: "agent:main:main", message: "status" },
      ctx,
      config: cfg,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("missing REVIEW");
  });

  it("treats `git pull` as a mutating exec action", () => {
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
    const ctx = { agentId: "leo", sessionKey: "agent:leo:git-pull-mutation" };

    const result = evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: "git pull --rebase" },
      ctx,
      config: cfg,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("missing ANCHOR");
  });

  it("accepts pnpm verify commands that include flags", () => {
    const cfg = configWithLane({ agentId: "cody" });
    const ctx = { agentId: "cody", sessionKey: "agent:cody:pnpm-flags-verify" };

    evaluateWorkflowLaneGuard({
      toolName: "exec",
      params: { command: 'rp-cli context_builder task="x"' },
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
      params: { command: "pnpm -w test" },
      ctx,
      config: cfg,
    });

    const result = evaluateWorkflowLaneGuard({
      toolName: "write",
      params: { path: "src/main.ts", content: "updated" },
      ctx,
      config: cfg,
    });
    expect(result.blocked).toBe(false);
  });
});
