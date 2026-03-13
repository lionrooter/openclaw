import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type {
  WorkflowLaneConfig,
  WorkflowLaneDomain,
  WorkflowLaneMutationPolicy,
  WorkflowLaneRequiredStages,
} from "../config/types.workflow-lane.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { normalizeToolName } from "./tool-policy.js";
import { resolveWorkflowLaneDomainForAgent } from "./workflow-lane-presets.js";

type GuardContext = {
  agentId?: string;
  sessionKey?: string;
};

type StageRequirementSet = {
  anchor: boolean;
  review: boolean;
  verify: boolean;
  gate: boolean;
};

type StageKey = keyof StageRequirementSet;

type StageState = {
  eventSeq: number;
  anchorSeq?: number;
  reviewSeq?: number;
  verifySeq?: number;
  gateSeq?: number;
  mutationSeq?: number;
  devIntent: boolean;
  updatedAtMs: number;
};

type ResolvedWorkflowLane = {
  enabled: boolean;
  mode: "hard" | "soft";
  applyWhen: "dev-intent" | "always";
  domain: WorkflowLaneDomain;
  requiredStages: StageRequirementSet;
  actionRequirements: {
    mutation: StageRequirementSet;
    finalize: StageRequirementSet;
  };
  stageChecks?: WorkflowLaneConfig["stageChecks"];
};

type GuardResult = {
  blocked: boolean;
  reason?: string;
};

type LaneActionKind = "mutation" | "finalize" | "read-only";

type StageSignals = {
  anchor: boolean;
  review: boolean;
  verify: boolean;
  gate: boolean;
};

const DEFAULT_STATE_TTL_MS = 2 * 60 * 60 * 1000;
const STATE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const STAGE_KEYS: StageKey[] = ["anchor", "review", "verify", "gate"];
const stageStateBySession = new Map<string, StageState>();
let lastStatePruneMs = 0;

const FULL_STAGE_REQUIREMENTS: StageRequirementSet = {
  anchor: true,
  review: true,
  verify: true,
  gate: false,
};

const ANCHOR_ONLY_REQUIREMENTS: StageRequirementSet = {
  anchor: true,
  review: false,
  verify: false,
  gate: false,
};

const DOMAIN_DEFAULTS: Record<
  WorkflowLaneDomain,
  Pick<ResolvedWorkflowLane, "applyWhen" | "requiredStages" | "actionRequirements">
> = {
  coding: {
    applyWhen: "dev-intent",
    requiredStages: FULL_STAGE_REQUIREMENTS,
    actionRequirements: {
      mutation: ANCHOR_ONLY_REQUIREMENTS,
      finalize: FULL_STAGE_REQUIREMENTS,
    },
  },
  strategy: {
    applyWhen: "always",
    requiredStages: FULL_STAGE_REQUIREMENTS,
    actionRequirements: {
      mutation: FULL_STAGE_REQUIREMENTS,
      finalize: FULL_STAGE_REQUIREMENTS,
    },
  },
  creative: {
    applyWhen: "always",
    requiredStages: FULL_STAGE_REQUIREMENTS,
    actionRequirements: {
      mutation: FULL_STAGE_REQUIREMENTS,
      finalize: FULL_STAGE_REQUIREMENTS,
    },
  },
  growth: {
    applyWhen: "always",
    requiredStages: FULL_STAGE_REQUIREMENTS,
    actionRequirements: {
      mutation: FULL_STAGE_REQUIREMENTS,
      finalize: FULL_STAGE_REQUIREMENTS,
    },
  },
  infra: {
    applyWhen: "always",
    requiredStages: FULL_STAGE_REQUIREMENTS,
    actionRequirements: {
      mutation: FULL_STAGE_REQUIREMENTS,
      finalize: FULL_STAGE_REQUIREMENTS,
    },
  },
  life: {
    applyWhen: "always",
    requiredStages: FULL_STAGE_REQUIREMENTS,
    actionRequirements: {
      mutation: FULL_STAGE_REQUIREMENTS,
      finalize: FULL_STAGE_REQUIREMENTS,
    },
  },
  family: {
    applyWhen: "always",
    requiredStages: FULL_STAGE_REQUIREMENTS,
    actionRequirements: {
      mutation: FULL_STAGE_REQUIREMENTS,
      finalize: FULL_STAGE_REQUIREMENTS,
    },
  },
  finance: {
    applyWhen: "always",
    requiredStages: FULL_STAGE_REQUIREMENTS,
    actionRequirements: {
      mutation: FULL_STAGE_REQUIREMENTS,
      finalize: FULL_STAGE_REQUIREMENTS,
    },
  },
  "project-lead": {
    applyWhen: "always",
    requiredStages: FULL_STAGE_REQUIREMENTS,
    actionRequirements: {
      mutation: FULL_STAGE_REQUIREMENTS,
      finalize: FULL_STAGE_REQUIREMENTS,
    },
  },
  ops: {
    applyWhen: "always",
    requiredStages: FULL_STAGE_REQUIREMENTS,
    actionRequirements: {
      mutation: FULL_STAGE_REQUIREMENTS,
      finalize: FULL_STAGE_REQUIREMENTS,
    },
  },
  narrative: {
    applyWhen: "always",
    requiredStages: FULL_STAGE_REQUIREMENTS,
    actionRequirements: {
      mutation: FULL_STAGE_REQUIREMENTS,
      finalize: FULL_STAGE_REQUIREMENTS,
    },
  },
  research: {
    applyWhen: "always",
    requiredStages: FULL_STAGE_REQUIREMENTS,
    actionRequirements: {
      mutation: FULL_STAGE_REQUIREMENTS,
      finalize: FULL_STAGE_REQUIREMENTS,
    },
  },
  maker: {
    applyWhen: "always",
    requiredStages: FULL_STAGE_REQUIREMENTS,
    actionRequirements: {
      mutation: FULL_STAGE_REQUIREMENTS,
      finalize: FULL_STAGE_REQUIREMENTS,
    },
  },
};

function hasOwnDomain(value: unknown): value is WorkflowLaneDomain {
  return typeof value === "string" && Object.hasOwn(DOMAIN_DEFAULTS, value);
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function readPathHints(params: Record<string, unknown>): string[] {
  const scalarCandidates: unknown[] = [
    params.path,
    params.filePath,
    params.file_path,
    params.from,
    params.to,
    params.target,
    params.cwd,
    params.workdir,
    params.directory,
  ];
  const arrayCandidates = [params.paths, params.files]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .map(readString)
    .filter((entry): entry is string => Boolean(entry));
  return [
    ...scalarCandidates.map(readString).filter((entry): entry is string => Boolean(entry)),
    ...arrayCandidates,
  ].map((entry) => entry.toLowerCase());
}

function readExecCommand(params: Record<string, unknown>): string {
  const command = readString(params.command) ?? readString(params.cmd) ?? "";
  return command.toLowerCase();
}

function readAction(params: Record<string, unknown>): string {
  return readString(params.action)?.toLowerCase() ?? "";
}

function isCodingToolMutation(toolName: string): boolean {
  return toolName === "write" || toolName === "edit" || toolName === "apply_patch";
}

function isFinalizingExecCommand(command: string): boolean {
  if (!command) {
    return false;
  }
  const finalizingPatterns = [
    /\bgit\s+(commit|push|tag)\b/,
    /\bnpm\s+publish\b/,
    /\bpnpm\s+(publish|release)\b/,
    /\byarn\s+(publish|npm publish|release)\b/,
    /\bbun\s+publish\b/,
    /\b(kubectl\s+rollout|wrangler\s+deploy|vercel\b|netlify\b|render\b).*\b(deploy|publish)\b/,
    /\bdeploy\b/,
    /\brelease\b/,
    /\bpublish\b/,
  ];
  return finalizingPatterns.some((pattern) => pattern.test(command));
}

function isMutatingExecCommand(command: string): boolean {
  if (!command) {
    return false;
  }
  if (/>|>>/.test(command)) {
    return true;
  }
  const mutatingPatterns = [
    /\brm\b/,
    /\bmv\b/,
    /\bcp\b/,
    /\btouch\b/,
    /\bmkdir\b/,
    /\brmdir\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\btee\b/,
    /\bgit\s+(add|merge|rebase|cherry-pick|reset|clean|restore|checkout|pull|switch|apply)\b/,
    /\bgit\s+stash(?:\s+(pop|apply|push|drop|clear))?\b/,
    /\bpnpm\s+(install|add|remove|up|update)\b/,
    /\bnpm\s+(install|i|add|remove|update)\b/,
    /\byarn\s+(install|add|remove|up)\b/,
    /\bbun\s+(install|add|remove|update)\b/,
    /\bsed\s+-i\b/,
    /\bperl\s+-i\b/,
  ];
  return mutatingPatterns.some((pattern) => pattern.test(command));
}

function isCodingIntentCommand(command: string): boolean {
  if (!command) {
    return false;
  }
  const codingPatterns = [
    /\brp-cli\b/,
    /\bgit\b/,
    /\bpnpm\b/,
    /\bnpm\b/,
    /\bbun\b/,
    /\bvitest\b/,
    /\bpytest\b/,
    /\bgo\s+test\b/,
    /\bcargo\s+test\b/,
    /\beslint\b/,
    /\btsc\b/,
    /\bbuild\b/,
    /\blint\b/,
    /\btest\b/,
  ];
  return codingPatterns.some((pattern) => pattern.test(command));
}

function isGatewayHighImpact(params: Record<string, unknown>): boolean {
  const action = readAction(params);
  return (
    action === "config.apply" ||
    action === "update.run" ||
    action === "restart" ||
    action === "start" ||
    action === "stop"
  );
}

function isMutatingMaestroAction(params: Record<string, unknown>): boolean {
  const action = readAction(params);
  return (
    action === "enqueue" || action === "claim" || action === "complete" || action === "reassign"
  );
}

function isReviewPath(path: string): boolean {
  return (
    path.includes("review") ||
    path.includes("checklist") ||
    path.includes("readiness") ||
    path.includes("score") ||
    path.includes("maintenance")
  );
}

function isVerifyPath(path: string): boolean {
  return (
    path.includes("kanban") ||
    path.includes("maintenance") ||
    path.includes("active-task") ||
    path.includes("/outputs/") ||
    path.includes("/output/") ||
    path.includes("report") ||
    path.includes("status") ||
    path.includes("log")
  );
}

function stageChecksMatch(
  stageChecks: unknown,
  toolName: string,
  command: string,
  action: string,
  paths: string[],
): boolean {
  if (!Array.isArray(stageChecks) || stageChecks.length === 0) {
    return false;
  }
  const payload = [toolName, command, action, ...paths].join("\n").toLowerCase();
  const checks = stageChecks
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (checks.length === 0) {
    return false;
  }
  return checks.some((entry) => payload.includes(entry));
}

function isCodingVerifyCommand(command: string): boolean {
  return (
    (/\bpnpm\b/.test(command) && /\b(test|check|lint|build)\b/.test(command)) ||
    (/\bnpm\b/.test(command) &&
      (/\btest\b/.test(command) || /\brun\s+(check|lint|build)\b/.test(command))) ||
    (/\bbun\b/.test(command) && /\b(test|check|lint|build)\b/.test(command)) ||
    /\b(vitest|pytest)\b/.test(command) ||
    /\b(go\s+test|cargo\s+test)\b/.test(command) ||
    /\btsc\b/.test(command)
  );
}

function detectStageSignals(params: {
  lane: ResolvedWorkflowLane;
  toolName: string;
  args: Record<string, unknown>;
}): StageSignals {
  const { lane, toolName, args } = params;
  const paths = readPathHints(args);
  const command = readExecCommand(args);
  const action = readAction(args);
  const isRead = toolName === "read";
  const isWrite = toolName === "write" || toolName === "edit" || toolName === "apply_patch";
  const isMutatingExec = toolName === "exec" && isMutatingExecCommand(command);

  const customAnchor = stageChecksMatch(lane.stageChecks?.anchor, toolName, command, action, paths);
  const customReview = stageChecksMatch(lane.stageChecks?.review, toolName, command, action, paths);
  const customVerify = stageChecksMatch(lane.stageChecks?.verify, toolName, command, action, paths);
  const customGate = stageChecksMatch(lane.stageChecks?.gate, toolName, command, action, paths);

  const anchorByDomain =
    lane.domain === "coding"
      ? toolName === "exec" &&
        (command.includes("rp-cli context_builder") || command.includes("rp-cli context-builder"))
      : (isRead &&
          paths.some(
            (path) =>
              path.includes("workflows/") ||
              path.includes("context.md") ||
              path.includes("memory/active-tasks") ||
              path.includes("kanban"),
          )) ||
        (lane.domain === "infra" && toolName === "exec" && /status|health|uptime/.test(command));

  const reviewByDomain =
    lane.domain === "coding"
      ? toolName === "exec" && command.includes("rp-cli review")
      : (isRead && paths.some((path) => isReviewPath(path))) ||
        (toolName === "exec" && /\b(review|checklist|retro|audit|diff)\b/.test(command));

  const verifyByDomain =
    lane.domain === "coding"
      ? toolName === "exec" && isCodingVerifyCommand(command)
      : (isWrite && paths.some((path) => isVerifyPath(path))) ||
        (toolName === "exec" &&
          !isMutatingExec &&
          /\b(verify|validate|readiness|audit|health|healthcheck)\b/.test(command));

  return {
    anchor: customAnchor || anchorByDomain,
    review: customReview || reviewByDomain,
    verify: customVerify || verifyByDomain,
    gate: customGate,
  };
}

function classifyAction(params: {
  lane: ResolvedWorkflowLane;
  toolName: string;
  args: Record<string, unknown>;
}): LaneActionKind {
  const { lane, toolName, args } = params;
  const command = readExecCommand(args);
  const action = readAction(args);

  if (toolName === "exec") {
    if (isFinalizingExecCommand(command)) {
      return "finalize";
    }
    if (isMutatingExecCommand(command)) {
      return "mutation";
    }
    return "read-only";
  }

  if (isCodingToolMutation(toolName)) {
    return "mutation";
  }

  if (toolName === "codex_delegate") {
    return action === "code" ? "mutation" : "read-only";
  }

  if (lane.domain !== "coding") {
    if (toolName === "sessions_send") {
      return "finalize";
    }
    if (toolName === "gateway" && isGatewayHighImpact(args)) {
      return "finalize";
    }
    if (toolName === "maestro" && isMutatingMaestroAction(args)) {
      return "mutation";
    }
  }

  return "read-only";
}

function resolveDomain(agentId?: string, override?: WorkflowLaneDomain): WorkflowLaneDomain {
  if (hasOwnDomain(override)) {
    return override;
  }
  const mapped = resolveWorkflowLaneDomainForAgent(agentId);
  if (hasOwnDomain(mapped)) {
    return mapped;
  }
  return "ops";
}

function toLegacyMutationRequirements(policy?: WorkflowLaneMutationPolicy): {
  mutation?: Partial<StageRequirementSet>;
  finalize?: Partial<StageRequirementSet>;
} {
  if (!policy) {
    return {};
  }
  const mutation: Partial<StageRequirementSet> = {};
  const finalize: Partial<StageRequirementSet> = {};

  if (policy.blockBeforeAnchor !== undefined) {
    mutation.anchor = policy.blockBeforeAnchor;
  }
  if (policy.blockBeforeReview !== undefined) {
    finalize.review = policy.blockBeforeReview;
  }
  if (policy.blockBeforeVerify !== undefined) {
    finalize.verify = policy.blockBeforeVerify;
  }

  return {
    mutation,
    finalize,
  };
}

function resolveRequirementSet(params: {
  defaults: StageRequirementSet;
  globalSet?: WorkflowLaneRequiredStages;
  agentSet?: WorkflowLaneRequiredStages;
  globalLegacy?: Partial<StageRequirementSet>;
  agentLegacy?: Partial<StageRequirementSet>;
}): StageRequirementSet {
  return {
    anchor:
      params.agentSet?.anchor ??
      params.agentLegacy?.anchor ??
      params.globalSet?.anchor ??
      params.globalLegacy?.anchor ??
      params.defaults.anchor,
    review:
      params.agentSet?.review ??
      params.agentLegacy?.review ??
      params.globalSet?.review ??
      params.globalLegacy?.review ??
      params.defaults.review,
    verify:
      params.agentSet?.verify ??
      params.agentLegacy?.verify ??
      params.globalSet?.verify ??
      params.globalLegacy?.verify ??
      params.defaults.verify,
    gate:
      params.agentSet?.gate ??
      params.agentLegacy?.gate ??
      params.globalSet?.gate ??
      params.globalLegacy?.gate ??
      params.defaults.gate,
  };
}

function resolveWorkflowLane(params: {
  config: OpenClawConfig;
  agentId?: string;
}): ResolvedWorkflowLane {
  const globalLane = params.config.agents?.defaults?.workflowLane;
  const agentLane = params.agentId
    ? resolveAgentConfig(params.config, params.agentId)?.workflowLane
    : undefined;
  const domain = resolveDomain(params.agentId, agentLane?.domain ?? globalLane?.domain);
  const domainDefaults = DOMAIN_DEFAULTS[domain];
  const stageChecks = {
    anchor: agentLane?.stageChecks?.anchor ?? globalLane?.stageChecks?.anchor,
    review: agentLane?.stageChecks?.review ?? globalLane?.stageChecks?.review,
    verify: agentLane?.stageChecks?.verify ?? globalLane?.stageChecks?.verify,
    gate: agentLane?.stageChecks?.gate ?? globalLane?.stageChecks?.gate,
  };
  const hasStageChecks =
    stageChecks.anchor !== undefined ||
    stageChecks.review !== undefined ||
    stageChecks.verify !== undefined ||
    stageChecks.gate !== undefined;
  const modeCandidate = agentLane?.mode ?? globalLane?.mode;
  const mode: "hard" | "soft" = modeCandidate === "soft" ? "soft" : "hard";
  const applyWhenCandidate = agentLane?.applyWhen ?? globalLane?.applyWhen;
  const applyWhen: "dev-intent" | "always" =
    applyWhenCandidate === "always" || applyWhenCandidate === "dev-intent"
      ? applyWhenCandidate
      : domainDefaults.applyWhen;
  const globalLegacy = toLegacyMutationRequirements(globalLane?.mutationPolicy);
  const agentLegacy = toLegacyMutationRequirements(agentLane?.mutationPolicy);

  return {
    enabled: agentLane?.enabled ?? globalLane?.enabled ?? true,
    mode,
    applyWhen,
    domain,
    requiredStages: resolveRequirementSet({
      defaults: domainDefaults.requiredStages,
      globalSet: globalLane?.requiredStages,
      agentSet: agentLane?.requiredStages,
    }),
    actionRequirements: {
      mutation: resolveRequirementSet({
        defaults: domainDefaults.actionRequirements.mutation,
        globalSet: globalLane?.actionRequirements?.mutation,
        agentSet: agentLane?.actionRequirements?.mutation,
        globalLegacy: globalLegacy.mutation,
        agentLegacy: agentLegacy.mutation,
      }),
      finalize: resolveRequirementSet({
        defaults: domainDefaults.actionRequirements.finalize,
        globalSet: globalLane?.actionRequirements?.finalize,
        agentSet: agentLane?.actionRequirements?.finalize,
        globalLegacy: globalLegacy.finalize,
        agentLegacy: agentLegacy.finalize,
      }),
    },
    stageChecks: hasStageChecks ? stageChecks : undefined,
  };
}

function getSessionStateKey(ctx?: GuardContext): string {
  const sessionKey = ctx?.sessionKey?.trim();
  if (sessionKey) {
    return `session:${sessionKey}`;
  }
  const agentId = ctx?.agentId?.trim() || "main";
  return `agent:${agentId}`;
}

function resetState(): StageState {
  return {
    eventSeq: 0,
    devIntent: false,
    updatedAtMs: Date.now(),
  };
}

function getSessionState(sessionKey: string): StageState {
  const now = Date.now();
  if (now - lastStatePruneMs >= STATE_PRUNE_INTERVAL_MS) {
    for (const [key, value] of stageStateBySession.entries()) {
      if (now - value.updatedAtMs > DEFAULT_STATE_TTL_MS) {
        stageStateBySession.delete(key);
      }
    }
    lastStatePruneMs = now;
  }

  const existing = stageStateBySession.get(sessionKey);
  if (!existing) {
    const initial = resetState();
    stageStateBySession.set(sessionKey, initial);
    return initial;
  }
  if (now - existing.updatedAtMs > DEFAULT_STATE_TTL_MS) {
    const next = resetState();
    stageStateBySession.set(sessionKey, next);
    return next;
  }
  return existing;
}

function getStageSeq(state: StageState, stage: StageKey): number | undefined {
  if (stage === "anchor") {
    return state.anchorSeq;
  }
  if (stage === "review") {
    return state.reviewSeq;
  }
  if (stage === "verify") {
    return state.verifySeq;
  }
  return state.gateSeq;
}

function stageExistsForFinalize(state: StageState, stage: StageKey): boolean {
  const seq = getStageSeq(state, stage);
  if (!seq) {
    return false;
  }
  if ((stage === "review" || stage === "verify" || stage === "gate") && state.mutationSeq) {
    return seq > state.mutationSeq;
  }
  return true;
}

function missingStageForRequirements(params: {
  requirements: StageRequirementSet;
  state: StageState;
  actionKind: Exclude<LaneActionKind, "read-only">;
}): StageKey | null {
  for (const stage of STAGE_KEYS) {
    if (!params.requirements[stage]) {
      continue;
    }
    if (params.actionKind === "finalize") {
      if (!stageExistsForFinalize(params.state, stage)) {
        if (
          stage === "verify" &&
          !params.state.mutationSeq &&
          !params.state.verifySeq &&
          params.state.reviewSeq
        ) {
          continue;
        }
        return stage;
      }
      continue;
    }

    if (!getStageSeq(params.state, stage)) {
      return stage;
    }
  }
  return null;
}

function missingStageMessage(params: {
  domain: WorkflowLaneDomain;
  stage: StageKey;
  actionKind: Exclude<LaneActionKind, "read-only">;
  state: StageState;
}): string {
  const freshnessRequired =
    params.actionKind === "finalize" &&
    Boolean(params.state.mutationSeq) &&
    (params.stage === "review" || params.stage === "verify" || params.stage === "gate");

  if (params.domain === "coding") {
    if (params.actionKind === "mutation") {
      if (params.stage === "anchor") {
        return 'Workflow lane gate: missing ANCHOR before mutation. Run `rp-cli context_builder task="<task>"` before mutating code.';
      }
      if (params.stage === "review") {
        return "Workflow lane gate: missing REVIEW before mutation.";
      }
      if (params.stage === "verify") {
        return "Workflow lane gate: missing VERIFY before mutation.";
      }
      return "Workflow lane gate: missing GATE before mutation.";
    }
    if (params.stage === "anchor") {
      return 'Workflow lane gate: missing ANCHOR before finalizing. Run `rp-cli context_builder task="<task>"` first.';
    }
    if (params.stage === "review") {
      return freshnessRequired
        ? "Workflow lane gate: missing REVIEW after last mutation before finalizing."
        : "Workflow lane gate: missing REVIEW before finalizing.";
    }
    if (params.stage === "verify") {
      return freshnessRequired
        ? "Workflow lane gate: missing VERIFY after last mutation before finalizing."
        : "Workflow lane gate: missing VERIFY before finalizing.";
    }
    return "Workflow lane gate: missing GATE before finalizing.";
  }

  if (params.actionKind === "mutation") {
    return `Workflow lane gate: missing ${params.stage.toUpperCase()} before high-impact mutation.`;
  }
  if (freshnessRequired) {
    return `Workflow lane gate: missing ${params.stage.toUpperCase()} after last mutation before finalizing.`;
  }
  return `Workflow lane gate: missing ${params.stage.toUpperCase()} before finalizing.`;
}

function applySignalsToState(state: StageState, seq: number, signals: StageSignals): void {
  if (signals.anchor) {
    state.anchorSeq = seq;
  }
  if (signals.review) {
    state.reviewSeq = seq;
  }
  if (signals.verify) {
    state.verifySeq = seq;
  }
  if (signals.gate) {
    state.gateSeq = seq;
  }
}

export function evaluateWorkflowLaneGuard(args: {
  toolName: string;
  params: unknown;
  ctx?: GuardContext;
  config?: OpenClawConfig;
}): GuardResult {
  const cfg = args.config ?? loadConfig();
  const toolName = normalizeToolName(args.toolName);
  const params = toRecord(args.params);
  const lane = resolveWorkflowLane({ config: cfg, agentId: args.ctx?.agentId });

  if (!lane.enabled) {
    return { blocked: false };
  }

  const sessionStateKey = getSessionStateKey(args.ctx);
  const state = getSessionState(sessionStateKey);
  const signals = detectStageSignals({ lane, toolName, args: params });
  const actionKind = classifyAction({ lane, toolName, args: params });
  const command = readExecCommand(params);
  const nextSeq = state.eventSeq + 1;
  const devIntent =
    state.devIntent ||
    signals.anchor ||
    signals.review ||
    signals.verify ||
    signals.gate ||
    actionKind !== "read-only" ||
    (lane.domain === "coding" && isCodingIntentCommand(command));
  const laneActive = lane.applyWhen === "always" || devIntent;

  if (lane.mode === "hard" && laneActive && actionKind !== "read-only") {
    const requirements =
      actionKind === "mutation"
        ? lane.actionRequirements.mutation
        : lane.actionRequirements.finalize;
    const missingStage = missingStageForRequirements({
      requirements,
      state,
      actionKind,
    });
    if (missingStage) {
      state.eventSeq = nextSeq;
      state.devIntent = devIntent;
      state.updatedAtMs = Date.now();
      return {
        blocked: true,
        reason: missingStageMessage({
          domain: lane.domain,
          stage: missingStage,
          actionKind,
          state,
        }),
      };
    }
  }

  state.eventSeq = nextSeq;
  state.devIntent = devIntent;
  state.updatedAtMs = Date.now();
  applySignalsToState(state, nextSeq, signals);
  if (actionKind === "mutation") {
    state.mutationSeq = nextSeq;
  }

  return { blocked: false };
}

export const __testing = {
  stageStateBySession,
  resetWorkflowLaneState: () => {
    stageStateBySession.clear();
    lastStatePruneMs = 0;
  },
  isMutatingExecCommand,
  isFinalizingExecCommand,
  isCodingIntentCommand,
};
