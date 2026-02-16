import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, ToolInputError, jsonResult, readStringParam } from "./common.js";

const MAESTRO_ACTIONS = [
  "list",
  "enqueue",
  "claim",
  "complete",
  "reassign",
  "validate",
  "watch",
] as const;

const MaestroToolSchema = Type.Object({
  action: stringEnum(MAESTRO_ACTIONS),
  // common
  actor: Type.Optional(Type.String()),
  // queue identity
  task: Type.Optional(Type.String()),
  owner: Type.Optional(Type.String()),
  // enqueue
  title: Type.Optional(Type.String()),
  ask: Type.Optional(Type.String()),
  blockedBy: Type.Optional(Type.String()),
  constraints: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
  repo: Type.Optional(Type.String()),
  modelTier: Type.Optional(Type.String()),
  priority: Type.Optional(Type.String()),
  requestId: Type.Optional(Type.String()),
  laneDomain: Type.Optional(Type.String()),
  stream: Type.Optional(Type.String()),
  topic: Type.Optional(Type.String()),
  worktree: Type.Optional(Type.String()),
  // completion
  result: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
  // list/watch/validate
  status: Type.Optional(Type.String()),
  hours: Type.Optional(Type.Number()),
  includeBlocked: Type.Optional(Type.Boolean()),
  strict: Type.Optional(Type.Boolean()),
  expectedRevision: Type.Optional(Type.Number()),
  // plumbing
  taskApiPath: Type.Optional(Type.String()),
  autorunDir: Type.Optional(Type.String()),
});

const DEFAULT_TASK_API =
  "/Users/lionheart/programming_projects/lionroot-openclaw/scripts/maestro/task-api";

function pushArg(args: string[], name: string, value: unknown) {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  args.push(name, trimmed);
}

function pushNumber(args: string[], name: string, value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return;
  }
  args.push(name, String(value));
}

function buildTaskApiArgs(action: string, params: Record<string, unknown>): string[] {
  switch (action) {
    case "list": {
      const args = ["list"];
      pushArg(args, "--status", params.status);
      pushArg(args, "--owner", params.owner);
      args.push("--json");
      return args;
    }
    case "validate": {
      const args = ["validate"];
      if (params.strict === true) {
        args.push("--strict");
      }
      args.push("--json");
      return args;
    }
    case "watch": {
      const args = ["watch"];
      pushNumber(args, "--hours", params.hours);
      if (params.includeBlocked === true) {
        args.push("--include-blocked");
      }
      args.push("--json");
      return args;
    }
    case "enqueue": {
      const owner = readStringParam(params, "owner", { required: true });
      const title = readStringParam(params, "title", { required: true });
      const ask = readStringParam(params, "ask", { required: true });
      const args = ["enqueue", "--owner", owner, "--title", title, "--ask", ask];
      pushArg(args, "--blocked-by", params.blockedBy);
      pushArg(args, "--constraints", params.constraints);
      pushArg(args, "--output", params.output);
      pushArg(args, "--repo", params.repo);
      pushArg(args, "--model-tier", params.modelTier);
      pushArg(args, "--priority", params.priority);
      pushArg(args, "--request-id", params.requestId);
      pushArg(args, "--lane-domain", params.laneDomain);
      pushArg(args, "--stream", params.stream);
      pushArg(args, "--topic", params.topic);
      pushArg(args, "--worktree", params.worktree);
      pushArg(args, "--actor", params.actor);
      return args;
    }
    case "claim": {
      const task = readStringParam(params, "task", { required: true });
      const args = ["claim", task];
      pushArg(args, "--owner", params.owner);
      pushArg(args, "--actor", params.actor);
      pushNumber(args, "--expected-revision", params.expectedRevision);
      pushArg(args, "--stream", params.stream);
      pushArg(args, "--topic", params.topic);
      pushArg(args, "--worktree", params.worktree);
      return args;
    }
    case "complete": {
      const task = readStringParam(params, "task", { required: true });
      const args = ["complete", task];
      pushArg(args, "--result", params.result);
      pushArg(args, "--note", params.note);
      pushArg(args, "--actor", params.actor);
      pushNumber(args, "--expected-revision", params.expectedRevision);
      return args;
    }
    case "reassign": {
      const task = readStringParam(params, "task", { required: true });
      const owner = readStringParam(params, "owner", { required: true });
      const actor = readStringParam(params, "actor", { required: true });
      const args = ["reassign", task, "--owner", owner, "--actor", actor];
      pushNumber(args, "--expected-revision", params.expectedRevision);
      return args;
    }
    default:
      throw new ToolInputError(`Unknown maestro action: ${action}`);
  }
}

function resolveTaskApiPath(params: Record<string, unknown>) {
  const byParam = typeof params.taskApiPath === "string" ? params.taskApiPath.trim() : "";
  if (byParam) {
    return byParam;
  }
  const byEnv = typeof process.env.MAESTRO_TASK_API === "string" ? process.env.MAESTRO_TASK_API : "";
  if (byEnv.trim()) {
    return byEnv.trim();
  }
  return DEFAULT_TASK_API;
}

function tryParseJson(raw: string) {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createMaestroTool(): AnyAgentTool {
  return {
    label: "Maestro Queue",
    name: "maestro",
    description:
      "Manage the Lionroot Maestro queue (list/enqueue/claim/complete/reassign/validate/watch). Uses lionroot-openclaw scripts for durable task state.",
    parameters: MaestroToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const taskApiPath = resolveTaskApiPath(params);
      const taskApiArgs = buildTaskApiArgs(action, params);
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (typeof params.autorunDir === "string" && params.autorunDir.trim()) {
        env.MAESTRO_AUTORUN_DIR = params.autorunDir.trim();
      }
      const result = spawnSync(taskApiPath, taskApiArgs, {
        encoding: "utf8",
        shell: false,
        env,
      });

      if (result.error) {
        throw result.error;
      }
      if ((result.status ?? 1) !== 0) {
        const detail = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
        throw new Error(`maestro ${action} failed: ${detail || "unknown error"}`);
      }

      const parsed = tryParseJson(result.stdout ?? "");
      return jsonResult({
        ok: true,
        action,
        command: [taskApiPath, ...taskApiArgs],
        result: parsed ?? (result.stdout || "").trim(),
      });
    },
  };
}

export const __testing = {
  buildTaskApiArgs,
  resolveTaskApiPath,
};
