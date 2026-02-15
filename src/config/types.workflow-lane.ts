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
  | "ops";

export type WorkflowLaneMode = "hard" | "soft";
export type WorkflowLaneApplyWhen = "dev-intent" | "always";

export type WorkflowLaneRequiredStages = {
  anchor?: boolean;
  review?: boolean;
  verify?: boolean;
  gate?: boolean;
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
  /** Block high-impact actions when ANCHOR has not been completed. */
  blockBeforeAnchor?: boolean;
  /** Block high-impact actions when REVIEW has not been completed. */
  blockBeforeReview?: boolean;
  /** Block high-impact actions when VERIFY has not been completed. */
  blockBeforeVerify?: boolean;
};

export type WorkflowLaneConfig = {
  enabled?: boolean;
  mode?: WorkflowLaneMode;
  applyWhen?: WorkflowLaneApplyWhen;
  domain?: WorkflowLaneDomain;
  requiredStages?: WorkflowLaneRequiredStages;
  stageChecks?: WorkflowLaneStageChecks;
  mutationPolicy?: WorkflowLaneMutationPolicy;
};
