import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveUserPath } from "../../utils.js";
import { loadWorkspaceSkillEntries, type SkillEntry, type SkillSnapshot } from "../skills.js";

function snapshotResolvedSkillsMatchWorkspace(params: {
  workspaceDir: string;
  skillsSnapshot?: SkillSnapshot;
}): boolean {
  const resolvedSkills = params.skillsSnapshot?.resolvedSkills;
  if (!resolvedSkills) {
    return false;
  }
  if (resolvedSkills.length === 0) {
    return true;
  }
  const workspaceRoot = path.resolve(resolveUserPath(params.workspaceDir));
  return resolvedSkills.every((skill) => {
    const filePath = typeof skill?.filePath === "string" ? skill.filePath.trim() : "";
    if (!filePath) {
      return false;
    }
    const resolvedPath = path.resolve(resolveUserPath(filePath));
    return resolvedPath === workspaceRoot || resolvedPath.startsWith(`${workspaceRoot}${path.sep}`);
  });
}

export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
}): {
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
} {
  const shouldLoadSkillEntries = !snapshotResolvedSkillsMatchWorkspace({
    workspaceDir: params.workspaceDir,
    skillsSnapshot: params.skillsSnapshot,
  });
  return {
    shouldLoadSkillEntries,
    skillEntries: shouldLoadSkillEntries
      ? loadWorkspaceSkillEntries(params.workspaceDir, { config: params.config })
      : [],
  };
}
