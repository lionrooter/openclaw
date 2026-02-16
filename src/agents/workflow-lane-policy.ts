import type { OpenClawConfig } from "../config/config.js";
import type { WorkflowLaneConfig, WorkflowLaneDomain } from "../config/types.workflow-lane.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { normalizeToolName } from "./tool-policy.js";
import { resolveWorkflowLaneDomainForAgent } from "./workflow-lane-presets.js";

type GuardContext = {
  agentId?: string;
  sessionKey?: string;
};

type StageState = {
  anchorDone: boolean;
  reviewDone: boolean;
  verifyDone: boolean;
  gateDone: boolean;
  sawMutation: boolean;
  devIntent: boolean;
  updatedAtMs: number;
};

type ResolvedWorkflowLane = {
  enabled: boolean;
  mode: "hard" | "soft";
  applyWhen: "dev-intent" | "always";
  domain: WorkflowLaneDomain;
  requiredStages: {
    anchor: boolean;
    review: boolean;
    verify: boolean;
    gate: boolean;
  };
  mutationPolicy: {
    blockBeforeAnchor: boolean;
    blockBeforeReview: boolean;
    blockBeforeVerify: boolean;
  };
  stageChecks?: WorkflowLaneConfig["stageChecks"];
};

type GuardResult = {
  blocked: boolean;
  reason?: string;
};

const DEFAULT_STATE_TTL_MS = 2 * 60 * 60 * 1000;
const STATE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const stageStateBySession = new Map<string, StageState>();
let lastStatePruneMs = 0;

const DOMAIN_DEFAULTS: Record<
  WorkflowLaneDomain,
  Pick<ResolvedWorkflowLane, "applyWhen" | "requiredStages" | "mutationPolicy">
> = {
  coding: {
    applyWhen: "dev-intent",
    requiredStages: { anchor: true, review: true, verify: true, gate: false },
    mutationPolicy: { blockBeforeAnchor: true, blockBeforeReview: true, blockBeforeVerify: true },
  },
  strategy: {
    applyWhen: "always",
    requiredStages: { anchor: true, review: true, verify: true, gate: false },
    mutationPolicy: { blockBeforeAnchor: true, blockBeforeReview: true, blockBeforeVerify: true },
  },
  creative: {
    applyWhen: "always",
    requiredStages: { anchor: true, review: true, verify: true, gate: false },
    mutationPolicy: { blockBeforeAnchor: true, blockBeforeReview: true, blockBeforeVerify: true },
  },
  growth: {
    applyWhen: "always",
    requiredStages: { anchor: true, review: true, verify: true, gate: false },
    mutationPolicy: { blockBeforeAnchor: true, blockBeforeReview: true, blockBeforeVerify: true },
  },
  infra: {
    applyWhen: "always",
    requiredStages: { anchor: true, review: true, verify: true, gate: false },
    mutationPolicy: { blockBeforeAnchor: true, blockBeforeReview: true, blockBeforeVerify: true },
  },
  life: {
    applyWhen: "always",
    requiredStages: { anchor: true, review: true, verify: true, gate: false },
    mutationPolicy: { blockBeforeAnchor: true, blockBeforeReview: true, blockBeforeVerify: true },
  },
  family: {
    applyWhen: "always",
    requiredStages: { anchor: true, review: true, verify: true, gate: false },
    mutationPolicy: { blockBeforeAnchor: true, blockBeforeReview: true, blockBeforeVerify: true },
  },
  finance: {
    applyWhen: "always",
    requiredStages: { anchor: true, review: true, verify: true, gate: false },
    mutationPolicy: { blockBeforeAnchor: true, blockBeforeReview: true, blockBeforeVerify: true },
  },
  "project-lead": {
    applyWhen: "always",
    requiredStages: { anchor: true, review: true, verify: true, gate: false },
    mutationPolicy: { blockBeforeAnchor: true, blockBeforeReview: true, blockBeforeVerify: true },
  },
  ops: {
    applyWhen: "always",
    requiredStages: { anchor: true, review: true, verify: true, gate: false },
    mutationPolicy: { blockBeforeAnchor: true, blockBeforeReview: true, blockBeforeVerify: true },
  },
};

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
  const candidates: unknown[] = [
    params.path,
    params.filePath,
    params.file_path,
    params.from,
    params.to,
    params.target,
    params.cwd,
    params.workdir,
  ];
  return candidates
    .map(readString)
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.toLowerCase());
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
    /\bgit\s+(add|commit|push|tag|merge|rebase|cherry-pick|reset|clean|restore|checkout|pull|switch|apply)\b/,
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
  if (!action) {
    return false;
  }
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

function isHighImpactDomainAction(toolName: string, params: Record<string, unknown>): boolean {
  if (toolName === "sessions_send") {
    return true;
  }
  if (toolName === "gateway") {
    return isGatewayHighImpact(params);
  }
  if (toolName === "maestro") {
    return isMutatingMaestroAction(params);
  }
  if (toolName === "exec") {
    return isMutatingExecCommand(readExecCommand(params));
  }
  return false;
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

function detectStageSignals(params: {
  lane: ResolvedWorkflowLane;
  toolName: string;
  args: Record<string, unknown>;
  state: StageState;
}): {
  anchor: boolean;
  review: boolean;
  verify: boolean;
  gate: boolean;
  sawMutation: boolean;
  devIntent: boolean;
} {
  const { lane, toolName, args, state } = params;
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
      ? toolName === "exec" &&
        ((/\bpnpm\b/.test(command) && /\b(test|check|lint|build)\b/.test(command)) ||
          (/\bnpm\b/.test(command) &&
            (/\btest\b/.test(command) || /\brun\s+(check|lint|build)\b/.test(command))) ||
          (/\bbun\b/.test(command) && /\btest\b/.test(command)) ||
          /\b(vitest|pytest)\b/.test(command) ||
          /\b(go\s+test|cargo\s+test)\b/.test(command) ||
          /\btsc\b/.test(command))
      : (isWrite && paths.some((path) => isVerifyPath(path))) ||
        (toolName === "exec" &&
          !isMutatingExec &&
          /\b(verify|validate|readiness|audit|health|healthcheck)\b/.test(command));

  const gateByDomain = false;
  const sawMutation = state.sawMutation || isWrite || isMutatingExec;
  const devIntent =
    state.devIntent ||
    isCodingToolMutation(toolName) ||
    isCodingIntentCommand(command) ||
    isMutatingExec;

  return {
    anchor: customAnchor || anchorByDomain,
    review: customReview || reviewByDomain,
    verify: customVerify || verifyByDomain,
    gate: customGate || gateByDomain,
    sawMutation,
    devIntent,
  };
}

function resolveDomain(agentId?: string, override?: WorkflowLaneDomain): WorkflowLaneDomain {
  if (typeof override === "string" && Object.hasOwn(DOMAIN_DEFAULTS, override)) {
    return override;
  }
  const mapped = resolveWorkflowLaneDomainForAgent(agentId);
  if (typeof mapped === "string" && Object.hasOwn(DOMAIN_DEFAULTS, mapped)) {
    return mapped;
  }
  return "ops";
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

  return {
    enabled: agentLane?.enabled ?? globalLane?.enabled ?? true,
    mode,
    applyWhen,
    domain,
    requiredStages: {
      anchor:
        agentLane?.requiredStages?.anchor ??
        globalLane?.requiredStages?.anchor ??
        domainDefaults.requiredStages.anchor,
      review:
        agentLane?.requiredStages?.review ??
        globalLane?.requiredStages?.review ??
        domainDefaults.requiredStages.review,
      verify:
        agentLane?.requiredStages?.verify ??
        globalLane?.requiredStages?.verify ??
        domainDefaults.requiredStages.verify,
      gate:
        agentLane?.requiredStages?.gate ??
        globalLane?.requiredStages?.gate ??
        domainDefaults.requiredStages.gate,
    },
    mutationPolicy: {
      blockBeforeAnchor:
        agentLane?.mutationPolicy?.blockBeforeAnchor ??
        globalLane?.mutationPolicy?.blockBeforeAnchor ??
        domainDefaults.mutationPolicy.blockBeforeAnchor,
      blockBeforeReview:
        agentLane?.mutationPolicy?.blockBeforeReview ??
        globalLane?.mutationPolicy?.blockBeforeReview ??
        domainDefaults.mutationPolicy.blockBeforeReview,
      blockBeforeVerify:
        agentLane?.mutationPolicy?.blockBeforeVerify ??
        globalLane?.mutationPolicy?.blockBeforeVerify ??
        domainDefaults.mutationPolicy.blockBeforeVerify,
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
    anchorDone: false,
    reviewDone: false,
    verifyDone: false,
    gateDone: false,
    sawMutation: false,
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

function missingStageMessage(
  domain: WorkflowLaneDomain,
  stage: "anchor" | "review" | "verify",
): string {
  if (domain === "coding") {
    if (stage === "anchor") {
      return 'Workflow lane gate: missing ANCHOR. Run `rp-cli context_builder task="<task>"` before mutating code.';
    }
    if (stage === "review") {
      return "Workflow lane gate: missing REVIEW. Run `rp-cli review` before final code mutations.";
    }
    return "Workflow lane gate: missing VERIFY. Run test/lint/build checks before final code mutations.";
  }
  if (stage === "anchor") {
    return "Workflow lane gate: missing ANCHOR. Read domain workflow/context/active-task files first.";
  }
  if (stage === "review") {
    return "Workflow lane gate: missing REVIEW. Run your domain review/checklist pass first.";
  }
  return "Workflow lane gate: missing VERIFY. Update/validate maintenance artifacts before high-impact actions.";
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
  const signals = detectStageSignals({
    lane,
    toolName,
    args: params,
    state,
  });

  state.anchorDone ||= signals.anchor;
  state.reviewDone ||= signals.review;
  state.verifyDone ||= signals.verify;
  state.gateDone ||= signals.gate;
  state.sawMutation = signals.sawMutation;
  state.devIntent = signals.devIntent;
  state.updatedAtMs = Date.now();

  const laneActive = lane.applyWhen === "always" || state.devIntent;
  if (!laneActive || lane.mode !== "hard") {
    return { blocked: false };
  }

  const isCodingLane = lane.domain === "coding";
  const targetAction = isCodingLane
    ? isCodingToolMutation(toolName) ||
      (toolName === "exec" && isMutatingExecCommand(readExecCommand(params)))
    : isHighImpactDomainAction(toolName, params);

  if (!targetAction) {
    return { blocked: false };
  }

  const verifyDone = isCodingLane
    ? state.verifyDone
    : state.verifyDone || (!state.sawMutation && state.reviewDone);

  if (lane.requiredStages.anchor && lane.mutationPolicy.blockBeforeAnchor && !state.anchorDone) {
    return { blocked: true, reason: missingStageMessage(lane.domain, "anchor") };
  }
  if (lane.requiredStages.review && lane.mutationPolicy.blockBeforeReview && !state.reviewDone) {
    return { blocked: true, reason: missingStageMessage(lane.domain, "review") };
  }
  if (lane.requiredStages.verify && lane.mutationPolicy.blockBeforeVerify && !verifyDone) {
    return { blocked: true, reason: missingStageMessage(lane.domain, "verify") };
  }

  if (!isCodingLane && isHighImpactDomainAction(toolName, params)) {
    stageStateBySession.set(sessionStateKey, {
      ...state,
      reviewDone: false,
      verifyDone: false,
      gateDone: false,
      sawMutation: false,
      updatedAtMs: Date.now(),
    });
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
  isCodingIntentCommand,
};
