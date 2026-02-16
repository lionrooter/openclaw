import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, ToolInputError, jsonResult, readStringParam } from "./common.js";

const DEFAULT_MODEL = "gpt-5.3-codex";
const DEFAULT_TIMEOUT_MS = 300_000;

const CODEX_ACTIONS = ["code", "review"] as const;

const CodexDelegateSchema = Type.Object({
  action: stringEnum(CODEX_ACTIONS, {
    description:
      'Action to perform: "code" to implement changes, "review" to review uncommitted changes.',
  }),
  task: Type.String({
    description: "Natural language description of the coding task or review focus.",
  }),
  directory: Type.String({ description: "Absolute path to the target working directory." }),
  model: Type.Optional(
    Type.String({ description: "Codex model override (default: gpt-5.3-codex)." }),
  ),
});

import type { CodexDelegateConfig } from "../../config/types.tools.js";

function resolveCodexConfig(config?: OpenClawConfig): CodexDelegateConfig {
  return config?.tools?.codexDelegate ?? {};
}

async function resolveCodexBinary(configCommand?: string): Promise<string> {
  if (configCommand) {
    return configCommand;
  }
  // Try common locations
  const candidates = [
    process.env.CODEX_PATH,
    // nvm-managed global
    path.join(process.env.HOME ?? "", ".nvm/versions/node", process.version, "bin/codex"),
    // homebrew
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found, continue
    }
  }

  // Fall back to PATH resolution
  return "codex";
}

function validateDirectory(dir: string, allowDirs?: string[]): void {
  if (!path.isAbsolute(dir)) {
    throw new ToolInputError(`directory must be an absolute path, got: ${dir}`);
  }
  if (allowDirs && allowDirs.length > 0) {
    const normalized = path.resolve(dir);
    const allowed = allowDirs.some((allowed) => {
      const normalizedAllowed = path.resolve(allowed);
      return (
        normalized === normalizedAllowed || normalized.startsWith(normalizedAllowed + path.sep)
      );
    });
    if (!allowed) {
      throw new ToolInputError(
        `directory ${dir} is not in the allowed directories list: ${allowDirs.join(", ")}`,
      );
    }
  }
}

type CodexResult = {
  ok: boolean;
  output: string;
  exitCode: number | null;
  durationMs: number;
};

function parseCodexJsonlOutput(raw: string): string {
  const lines = raw.split("\n").filter(Boolean);
  const outputParts: string[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      // Extract text from item.completed events
      if (event.type === "item.completed" || event.type === "message.completed") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item) {
          // Text content
          const content = item.content as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === "output_text" && typeof part.text === "string") {
                outputParts.push(part.text);
              }
            }
          }
          // Formatted text
          const formatted = item.formatted as Record<string, unknown> | undefined;
          if (formatted && typeof formatted.text === "string") {
            outputParts.push(formatted.text);
          }
        }
      }
      // Extract command execution results
      if (event.type === "command.completed") {
        const output = event.output as string | undefined;
        if (output) {
          outputParts.push(`[command] ${output}`);
        }
      }
    } catch {
      // Non-JSON line, include as-is
      if (line.trim()) {
        outputParts.push(line);
      }
    }
  }

  return outputParts.join("\n").trim() || raw.trim();
}

function spawnCodex(params: {
  binary: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<CodexResult> {
  const startMs = Date.now();

  return new Promise((resolve) => {
    const child = spawn(params.binary, params.args, {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }, params.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;
      const rawStdout = Buffer.concat(stdout).toString("utf-8");
      const rawStderr = Buffer.concat(stderr).toString("utf-8");

      const output = rawStdout
        ? parseCodexJsonlOutput(rawStdout)
        : rawStderr.trim() || "(no output)";

      resolve({
        ok: code === 0,
        output,
        exitCode: code,
        durationMs,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;
      resolve({
        ok: false,
        output: `Failed to spawn codex: ${err.message}`,
        exitCode: null,
        durationMs,
      });
    });
  });
}

export function createCodexDelegateTool(opts?: { config?: OpenClawConfig }): AnyAgentTool {
  const codexConfig = resolveCodexConfig(opts?.config);

  return {
    label: "Codex Delegate",
    name: "codex_delegate",
    description:
      'Delegate coding tasks to Codex CLI. Use action="code" to implement code changes in a target directory, or action="review" to review uncommitted changes. The agent stays in control while Codex handles the code-writing execution step.',
    parameters: CodexDelegateSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const task = readStringParam(params, "task", { required: true });
      const directory = readStringParam(params, "directory", { required: true });
      const model = readStringParam(params, "model") ?? codexConfig.model ?? DEFAULT_MODEL;

      // Validate directory exists and is allowed
      validateDirectory(directory, codexConfig.allowDirs);
      try {
        const stat = await fs.stat(directory);
        if (!stat.isDirectory()) {
          throw new ToolInputError(`${directory} is not a directory`);
        }
      } catch (err) {
        if (err instanceof ToolInputError) {
          throw err;
        }
        throw new ToolInputError(`directory does not exist: ${directory}`);
      }

      const binary = await resolveCodexBinary(codexConfig.command);
      const timeoutMs = codexConfig.maxTimeoutMs ?? DEFAULT_TIMEOUT_MS;

      if (action === "code") {
        const result = await spawnCodex({
          binary,
          args: ["exec", "--json", "--full-auto", "-m", model, task],
          cwd: directory,
          timeoutMs,
        });
        return jsonResult(result);
      }

      if (action === "review") {
        const result = await spawnCodex({
          binary,
          args: ["review", "--uncommitted"],
          cwd: directory,
          timeoutMs,
        });
        return jsonResult(result);
      }

      throw new ToolInputError(`Unknown action: ${action}`);
    },
  };
}

// Exported for testing
export const __testing = {
  parseCodexJsonlOutput,
  validateDirectory,
  resolveCodexBinary,
  resolveCodexConfig,
  spawnCodex,
};
