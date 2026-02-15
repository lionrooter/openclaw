import type { OpenClawConfig } from "../config/config.js";
import type {
  WorkflowLaneApplyWhen,
  WorkflowLaneConfig,
  WorkflowLaneDomain,
} from "../config/types.workflow-lane.js";
import { normalizeAgentId } from "../routing/session-key.js";

export const WORKFLOW_LANE_AGENT_DOMAIN_DEFAULTS: Readonly<Record<string, WorkflowLaneDomain>> = {
  main: "coding",
  cody: "coding",
  leo: "strategy",
  artie: "creative",
  exdi: "creative",
  grove: "growth",
  archie: "infra",
  liev: "life",
  nesta: "family",
  finn: "finance",
  projel: "project-lead",
};

const DOMAIN_APPLY_WHEN_DEFAULTS: Readonly<Record<WorkflowLaneDomain, WorkflowLaneApplyWhen>> = {
  coding: "dev-intent",
  strategy: "always",
  creative: "always",
  growth: "always",
  infra: "always",
  life: "always",
  family: "always",
  finance: "always",
  "project-lead": "always",
  ops: "always",
};

const DEFAULT_WORKFLOW_LANE: WorkflowLaneConfig = {
  enabled: true,
  mode: "hard",
  domain: "ops",
  applyWhen: "always",
};

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

function hasWorkflowLane(value: unknown): value is WorkflowLaneConfig {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function resolveWorkflowLaneDomainForAgent(
  agentId?: string,
): WorkflowLaneDomain | undefined {
  const normalized = normalizeAgentId(agentId ?? "");
  if (!normalized || !Object.hasOwn(WORKFLOW_LANE_AGENT_DOMAIN_DEFAULTS, normalized)) {
    return undefined;
  }
  return WORKFLOW_LANE_AGENT_DOMAIN_DEFAULTS[normalized];
}

export function resolveRecommendedWorkflowLaneForAgent(
  agentId?: string,
): WorkflowLaneConfig | undefined {
  const domain = resolveWorkflowLaneDomainForAgent(agentId);
  if (!domain) {
    return undefined;
  }
  return {
    enabled: true,
    mode: "hard",
    domain,
    applyWhen: DOMAIN_APPLY_WHEN_DEFAULTS[domain],
  };
}

export function applyRecommendedWorkflowLaneToAgentEntry(entry: AgentEntry): AgentEntry {
  if (hasWorkflowLane(entry.workflowLane)) {
    return entry;
  }
  const recommended = resolveRecommendedWorkflowLaneForAgent(entry.id);
  if (!recommended) {
    return entry;
  }
  return {
    ...entry,
    workflowLane: recommended,
  };
}

export function applyRecommendedWorkflowLaneConfig(cfg: OpenClawConfig): OpenClawConfig {
  let changed = false;

  const agents = cfg.agents ?? {};
  const defaults = agents.defaults ?? {};
  const defaultsWorkflowLane = hasWorkflowLane(defaults.workflowLane)
    ? defaults.workflowLane
    : DEFAULT_WORKFLOW_LANE;
  if (!hasWorkflowLane(defaults.workflowLane)) {
    changed = true;
  }

  const list = Array.isArray(agents.list) ? agents.list : undefined;
  const nextList = list?.map((entry) => {
    const nextEntry = applyRecommendedWorkflowLaneToAgentEntry(entry);
    if (nextEntry !== entry) {
      changed = true;
    }
    return nextEntry;
  });

  if (!changed) {
    return cfg;
  }

  return {
    ...cfg,
    agents: {
      ...agents,
      defaults: {
        ...defaults,
        workflowLane: defaultsWorkflowLane,
      },
      ...(nextList ? { list: nextList } : {}),
    },
  };
}
