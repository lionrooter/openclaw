export type WorkflowLaneDomain =
  | "coding"
  | "strategy"
  | "creative"
  | "growth"
  | "infra"
  | "life"
  | "family"
  | "finance"
  | "project-lead"
  | "ops"
  | "narrative"
  | "research"
  | "maker";

export type WorkflowLaneMode = "hard" | "soft";
export type WorkflowLaneApplyWhen = "dev-intent" | "always";

export type WorkflowLaneRequiredStages = {
  anchor?: boolean;
  review?: boolean;
  verify?: boolean;
  gate?: boolean;
};

export type WorkflowLaneActionRequirements = {
  mutation?: WorkflowLaneRequiredStages;
  finalize?: WorkflowLaneRequiredStages;
};

export type WorkflowLaneStageChecks = {
  /**
   * Optional substring patterns. If any pattern matches the normalized tool event text,
   * that stage is marked complete.
   */
  anchor?: string[];
  review?: string[];
  verify?: string[];
  gate?: string[];
};

export type WorkflowLaneMutationPolicy = {
  /** @deprecated Use actionRequirements.mutation.anchor instead. */
  blockBeforeAnchor?: boolean;
  /** @deprecated Use actionRequirements.finalize.review instead. */
  blockBeforeReview?: boolean;
  /** @deprecated Use actionRequirements.finalize.verify instead. */
  blockBeforeVerify?: boolean;
};

export type WorkflowLaneConfig = {
  enabled?: boolean;
  mode?: WorkflowLaneMode;
  applyWhen?: WorkflowLaneApplyWhen;
  domain?: WorkflowLaneDomain;
  requiredStages?: WorkflowLaneRequiredStages;
  actionRequirements?: WorkflowLaneActionRequirements;
  stageChecks?: WorkflowLaneStageChecks;
  mutationPolicy?: WorkflowLaneMutationPolicy;
};
