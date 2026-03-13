const RUNTIME_INTAKE_DEFAULTS: Record<string, string> = {
  archie:
    "Runtime intake default: For infrastructure, deployment, runtime, or host references, default to infra-fit analysis before asking follow-up questions.",
  artie:
    "Runtime intake default: For creative tools, visual workflows, prompt packs, or style references, default to creative-pipeline-fit analysis before asking follow-up questions.",
  clawdy:
    "Runtime intake default: For ambiguous or cross-domain inputs, default to routing, ownership, and lead-agent framing before asking follow-up questions.",
  cody: "Runtime intake default: For coding, tooling, repo, or workflow references, default to repo/workflow-fit analysis before asking follow-up questions.",
  exdi: "Runtime intake default: For UX, gameplay, onboarding, or interaction references, default to experience-fit analysis before asking follow-up questions.",
  finn: "Runtime intake default: For pricing, spend, billing, budget, or financial-system references, default to finance-fit analysis before asking follow-up questions.",
  grove:
    "Runtime intake default: For content, marketing, channel, audience, or creator-pattern references, default to audience/brand-fit analysis before asking follow-up questions.",
  leo: "Runtime intake default: For strategy, business, org, workflow, or system-pattern references, default to mission/org/priority-fit analysis before asking follow-up questions.",
  liev: "Runtime intake default: For food, health, rhythm, or daily-life signals, treat them as coaching inputs first, not generic research links or tooling evaluation.",
  maclern:
    "Runtime intake default: For training, eval, checkpoint, benchmark, or research-ops references, default to training-ops-fit analysis before asking follow-up questions.",
  mako: "Runtime intake default: For hardware, fabrication, robotics, BOM, or maker-workflow references, default to maker-fit analysis before asking follow-up questions.",
  nesta:
    "Runtime intake default: For family, meal, schedule, or household signals, treat them as family-ops inputs first, not generic research links or tooling evaluation.",
  storie:
    "Runtime intake default: For narrative, lore, canon, symbol, or story-structure references, default to narrative/canon-fit analysis before asking follow-up questions.",
};

export function buildAgentIntakeDefaultSystemPrompt(agentId: string): string {
  return RUNTIME_INTAKE_DEFAULTS[agentId.trim().toLowerCase()] ?? "";
}
