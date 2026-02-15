import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

const configMocks = vi.hoisted(() => ({
  createConfigIO: vi.fn(),
  writeConfigFile: vi.fn().mockResolvedValue(undefined),
}));

const workspaceMocks = vi.hoisted(() => ({
  ensureAgentWorkspace: vi.fn().mockResolvedValue({ dir: "/tmp/workspace" }),
}));

const loggingMocks = vi.hoisted(() => ({
  formatConfigPath: vi.fn((value: string) => value),
  logConfigUpdated: vi.fn(),
}));

const sessionsMocks = vi.hoisted(() => ({
  resolveSessionTranscriptsDir: vi.fn(() => "/tmp/sessions"),
}));

const utilsMocks = vi.hoisted(() => ({
  shortenHomePath: vi.fn((value: string) => value),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: fsMocks.readFile,
    mkdir: fsMocks.mkdir,
  },
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    createConfigIO: configMocks.createConfigIO,
    writeConfigFile: configMocks.writeConfigFile,
  };
});

vi.mock("../agents/workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/workspace.js")>();
  return {
    ...actual,
    DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/default-workspace",
    ensureAgentWorkspace: workspaceMocks.ensureAgentWorkspace,
  };
});

vi.mock("../config/logging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/logging.js")>();
  return {
    ...actual,
    formatConfigPath: loggingMocks.formatConfigPath,
    logConfigUpdated: loggingMocks.logConfigUpdated,
  };
});

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    resolveSessionTranscriptsDir: sessionsMocks.resolveSessionTranscriptsDir,
  };
});

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    shortenHomePath: utilsMocks.shortenHomePath,
  };
});

import { setupCommand } from "./setup.js";

describe("setup command", () => {
  let runtime: RuntimeEnv;

  beforeEach(() => {
    runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    fsMocks.readFile.mockReset();
    fsMocks.mkdir.mockClear();
    configMocks.createConfigIO.mockReset();
    configMocks.writeConfigFile.mockClear();
    workspaceMocks.ensureAgentWorkspace.mockClear();
    loggingMocks.formatConfigPath.mockClear();
    loggingMocks.logConfigUpdated.mockClear();
    sessionsMocks.resolveSessionTranscriptsDir.mockClear();
    utilsMocks.shortenHomePath.mockClear();

    configMocks.createConfigIO.mockReturnValue({ configPath: "/tmp/openclaw.json" });
  });

  it("writes workspace + workflow lane defaults when config does not exist", async () => {
    const enoentError = new Error("ENOENT");
    // oxlint-disable-next-line typescript/no-explicit-any
    (enoentError as any).code = "ENOENT";
    fsMocks.readFile.mockRejectedValueOnce(enoentError);

    await setupCommand({ workspace: "/tmp/workspace" }, runtime);

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(configMocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            workspace: "/tmp/workspace",
            workflowLane: {
              enabled: true,
              mode: "hard",
              domain: "ops",
              applyWhen: "always",
            },
          }),
        }),
      }),
    );
    expect(workspaceMocks.ensureAgentWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        dir: "/tmp/workspace",
        ensureBootstrapFiles: true,
      }),
    );
    expect(fsMocks.mkdir).toHaveBeenCalledWith("/tmp/sessions", { recursive: true });
  });

  it("logs workflow-lane suffix when workspace is unchanged and only lane defaults are added", async () => {
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        agents: {
          defaults: {
            workspace: "/tmp/workspace",
          },
        },
      }),
    );

    await setupCommand({ workspace: "/tmp/workspace" }, runtime);

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(loggingMocks.logConfigUpdated).toHaveBeenCalledWith(runtime, {
      path: "/tmp/openclaw.json",
      suffix: "(set workflow lane defaults)",
    });
  });
});
