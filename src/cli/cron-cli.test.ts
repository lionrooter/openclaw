import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const defaultGatewayRpcMock = async (method: string, _opts: unknown, params?: unknown) => {
  if (method === "cron.status") {
    return { enabled: true };
  }
  return { ok: true, params };
};
const callGatewayFromCli = vi.fn(defaultGatewayRpcMock);

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
      callGatewayFromCli(method, opts, params, extra as number | undefined),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number) => {
      throw new Error(`__exit__:${code}`);
    },
  },
}));

const { registerCronCli } = await import("./cron-cli.js");

type CronUpdatePatch = {
  patch?: {
    payload?: { message?: string; model?: string; thinking?: string };
    delivery?: { mode?: string; channel?: string; to?: string; bestEffort?: boolean };
  };
};

type CronAddParams = {
  schedule?: { kind?: string; staggerMs?: number };
  payload?: { model?: string; thinking?: string };
  delivery?: { mode?: string };
  deleteAfterRun?: boolean;
  agentId?: string;
  sessionTarget?: string;
};

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  registerCronCli(program);
  return program;
}

function resetGatewayMock() {
  callGatewayFromCli.mockReset();
  callGatewayFromCli.mockImplementation(defaultGatewayMock);
}

async function runCronEditAndGetPatch(editArgs: string[]): Promise<CronUpdatePatch> {
  resetGatewayMock();
  const program = buildProgram();
  await program.parseAsync(["cron", "edit", "job-1", ...editArgs], { from: "user" });
  const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
  return (updateCall?.[2] ?? {}) as CronUpdatePatch;
}

async function runCronAddAndGetParams(addArgs: string[]): Promise<CronAddParams> {
  resetGatewayMock();
  const program = buildProgram();
  await program.parseAsync(["cron", "add", ...addArgs], { from: "user" });
  const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
  return (addCall?.[2] ?? {}) as CronAddParams;
}

describe("cron cli", () => {
  it("trims model and thinking on cron add", { timeout: 60_000 }, async () => {
    resetGatewayMock();

    const program = buildProgram();

    await program.parseAsync(
      [
        "cron",
        "add",
        "--name",
        "Daily",
        "--cron",
        "* * * * *",
        "--session",
        "isolated",
        "--message",
        "hello",
        "--model",
        "  opus  ",
        "--thinking",
        "  low  ",
      ],
      { from: "user" },
    );

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as {
      payload?: { model?: string; thinking?: string };
    };

    expect(params?.payload?.model).toBe("opus");
    expect(params?.payload?.thinking).toBe("low");
  });

  it("defaults isolated cron add to announce delivery", async () => {
    resetGatewayMock();

    const program = buildProgram();

    await program.parseAsync(
      [
        "cron",
        "add",
        "--name",
        "Daily",
        "--cron",
        "* * * * *",
        "--session",
        "isolated",
        "--message",
        "hello",
      ],
      { from: "user" },
    );

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as { delivery?: { mode?: string } };

    expect(params?.delivery?.mode).toBe("announce");
  });

  it("infers sessionTarget from payload when --session is omitted", async () => {
    resetGatewayMock();

    const program = buildProgram();

    await program.parseAsync(
      ["cron", "add", "--name", "Main reminder", "--cron", "* * * * *", "--system-event", "hi"],
      { from: "user" },
    );

    let addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    let params = addCall?.[2] as { sessionTarget?: string; payload?: { kind?: string } };
    expect(params?.sessionTarget).toBe("main");
    expect(params?.payload?.kind).toBe("systemEvent");

    resetGatewayMock();

    await program.parseAsync(
      ["cron", "add", "--name", "Isolated task", "--cron", "* * * * *", "--message", "hello"],
      { from: "user" },
    );

    addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    params = addCall?.[2] as { sessionTarget?: string; payload?: { kind?: string } };
    expect(params?.sessionTarget).toBe("isolated");
    expect(params?.payload?.kind).toBe("agentTurn");
  });

  it("supports --keep-after-run on cron add", async () => {
    resetGatewayMock();

    const program = buildProgram();

    await program.parseAsync(
      [
        "cron",
        "add",
        "--name",
        "Keep me",
        "--at",
        "20m",
        "--session",
        "main",
        "--system-event",
        "hello",
        "--keep-after-run",
      ],
      { from: "user" },
    );

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as { deleteAfterRun?: boolean };
    expect(params?.deleteAfterRun).toBe(false);
  });

  it("sends agent id on cron add", async () => {
    resetGatewayMock();

    const program = buildProgram();

    await program.parseAsync(
      [
        "cron",
        "add",
        "--name",
        "Agent pinned",
        "--cron",
        "* * * * *",
        "--session",
        "isolated",
        "--message",
        "hi",
        "--agent",
        "ops",
      ],
      { from: "user" },
    );

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as { agentId?: string };
    expect(params?.agentId).toBe("ops");
  });

  it("omits empty model and thinking on cron edit", async () => {
    const patch = await runCronEditAndGetPatch([
      "--message",
      "hello",
      "--model",
      "   ",
      "--thinking",
      "  ",
    ]);

    expect(patch?.patch?.payload?.model).toBeUndefined();
    expect(patch?.patch?.payload?.thinking).toBeUndefined();
  });

  it("trims model and thinking on cron edit", async () => {
    const patch = await runCronEditAndGetPatch([
      "--message",
      "hello",
      "--model",
      "  opus  ",
      "--thinking",
      "  high  ",
    ]);

    expect(patch?.patch?.payload?.model).toBe("opus");
    expect(patch?.patch?.payload?.thinking).toBe("high");
  });

  it("sets and clears agent id on cron edit", async () => {
    resetGatewayMock();

    const program = buildProgram();

    await program.parseAsync(["cron", "edit", "job-1", "--agent", " Ops ", "--message", "hello"], {
      from: "user",
    });

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as { patch?: { agentId?: unknown } };
    expect(patch?.patch?.agentId).toBe("ops");

    resetGatewayMock();
    await program.parseAsync(["cron", "edit", "job-2", "--clear-agent"], {
      from: "user",
    });
    const clearCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const clearPatch = clearCall?.[2] as { patch?: { agentId?: unknown } };
    expect(clearPatch?.patch?.agentId).toBeNull();
  });

  it("allows model/thinking updates without --message", async () => {
    resetGatewayMock();

    const program = buildProgram();

    await program.parseAsync(["cron", "edit", "job-1", "--model", "opus", "--thinking", "low"], {
      from: "user",
    });

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: { payload?: { kind?: string; model?: string; thinking?: string } };
    };

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.payload?.model).toBe("opus");
    expect(patch?.patch?.payload?.thinking).toBe("low");
  });

  it("updates delivery settings without requiring --message", async () => {
    resetGatewayMock();

    const program = buildProgram();

    await program.parseAsync(
      ["cron", "edit", "job-1", "--deliver", "--channel", "telegram", "--to", "19098680"],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: {
        payload?: { kind?: string; message?: string };
        delivery?: { mode?: string; channel?: string; to?: string };
      };
    };

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.channel).toBe("telegram");
    expect(patch?.patch?.delivery?.to).toBe("19098680");
    expect(patch?.patch?.payload?.message).toBeUndefined();
  });

  it("supports --no-deliver on cron edit", async () => {
    resetGatewayMock();

    const program = buildProgram();

    await program.parseAsync(["cron", "edit", "job-1", "--no-deliver"], { from: "user" });

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: { payload?: { kind?: string }; delivery?: { mode?: string } };
    };

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.delivery?.mode).toBe("none");
  });

  it("does not include undefined delivery fields when updating message", async () => {
    resetGatewayMock();

    const program = buildProgram();

    // Update message without delivery flags - should NOT include undefined delivery fields
    await program.parseAsync(["cron", "edit", "job-1", "--message", "Updated message"], {
      from: "user",
    });

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: {
        payload?: {
          message?: string;
          deliver?: boolean;
          channel?: string;
          to?: string;
          bestEffortDeliver?: boolean;
        };
        delivery?: unknown;
      };
    };

    // Should include the new message
    expect(patch?.patch?.payload?.message).toBe("Updated message");

    // Should NOT include delivery fields at all (to preserve existing values)
    expect(patch?.patch?.payload).not.toHaveProperty("deliver");
    expect(patch?.patch?.payload).not.toHaveProperty("channel");
    expect(patch?.patch?.payload).not.toHaveProperty("to");
    expect(patch?.patch?.payload).not.toHaveProperty("bestEffortDeliver");
    expect(patch?.patch).not.toHaveProperty("delivery");
  });

  it("includes delivery fields when explicitly provided with message", async () => {
    const patch = await runCronEditAndGetPatch([
      "--message",
      "Updated message",
      "--deliver",
      "--channel",
      "telegram",
      "--to",
      "19098680",
    ]);

    // Should include everything
    expect(patch?.patch?.payload?.message).toBe("Updated message");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.channel).toBe("telegram");
    expect(patch?.patch?.delivery?.to).toBe("19098680");
  });

  it("includes best-effort delivery when provided with message", async () => {
    const patch = await runCronEditAndGetPatch([
      "--message",
      "Updated message",
      "--best-effort-deliver",
    ]);

    expect(patch?.patch?.payload?.message).toBe("Updated message");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.bestEffort).toBe(true);
  });

  it("includes no-best-effort delivery when provided with message", async () => {
    const patch = await runCronEditAndGetPatch([
      "--message",
      "Updated message",
      "--no-best-effort-deliver",
    ]);

    expect(patch?.patch?.payload?.message).toBe("Updated message");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.bestEffort).toBe(false);
  });

  it("runs delivery preflight before cron run", async () => {
    callGatewayFromCli.mockClear();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "job-1",
              sessionTarget: "isolated",
              delivery: { mode: "announce", channel: "zulip" },
            },
          ],
        };
      }
      if (method === "channels.status") {
        return {
          channelOrder: ["zulip"],
          channels: {
            zulip: { configured: true, running: true, connected: true },
          },
          channelAccounts: {
            zulip: [
              {
                accountId: "archie",
                configured: true,
                running: true,
                connected: true,
              },
            ],
          },
          channelDefaultAccountId: { zulip: "archie" },
        };
      }
      if (method === "cron.run") {
        return { ok: true, ran: true };
      }
      return defaultGatewayRpcMock(method, {}, undefined);
    });

    const program = buildProgram();
    await program.parseAsync(["cron", "run", "job-1"], { from: "user" });

    const methods = callGatewayFromCli.mock.calls.map((call) => call[0]);
    expect(methods).toContain("cron.list");
    expect(methods).toContain("channels.status");
    expect(methods).toContain("cron.run");
    expect(methods.indexOf("cron.list")).toBeLessThan(methods.indexOf("cron.run"));

    callGatewayFromCli.mockImplementation(defaultGatewayRpcMock);
  });

  it("recovers cron run timeout by verifying cron.runs", async () => {
    callGatewayFromCli.mockClear();
    let runsCallCount = 0;
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.runs") {
        runsCallCount += 1;
        if (runsCallCount === 1) {
          return { entries: [{ ts: 100, status: "ok" }] };
        }
        return {
          entries: [
            { ts: 100, status: "ok" },
            { ts: Date.now() + 1000, status: "ok", summary: "done" },
          ],
        };
      }
      if (method === "cron.run") {
        throw new Error("gateway timeout after 30000ms");
      }
      return defaultGatewayRpcMock(method, {}, undefined);
    });

    const program = buildProgram();
    await program.parseAsync(
      ["cron", "run", "job-1", "--verify-timeout", "2000", "--verify-poll", "1"],
      {
        from: "user",
      },
    );

    expect(callGatewayFromCli.mock.calls.some((call) => call[0] === "cron.run")).toBe(true);
    expect(callGatewayFromCli.mock.calls.filter((call) => call[0] === "cron.runs").length).toBe(2);

    callGatewayFromCli.mockImplementation(defaultGatewayRpcMock);
  });

  it("exits non-zero when timeout verification finds failed run", async () => {
    callGatewayFromCli.mockClear();
    let runsCallCount = 0;
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.runs") {
        runsCallCount += 1;
        if (runsCallCount === 1) {
          return { entries: [{ ts: 100, status: "ok" }] };
        }
        return {
          entries: [
            { ts: 100, status: "ok" },
            { ts: Date.now() + 1000, status: "error", error: "delivery failed" },
          ],
        };
      }
      if (method === "cron.run") {
        throw new Error("gateway timeout after 30000ms");
      }
      return defaultGatewayRpcMock(method, {}, undefined);
    });

    const program = buildProgram();
    await expect(
      program.parseAsync(
        ["cron", "run", "job-1", "--verify-timeout", "2000", "--verify-poll", "1"],
        {
          from: "user",
        },
      ),
    ).rejects.toThrow("__exit__:1");

    callGatewayFromCli.mockImplementation(defaultGatewayRpcMock);
  });

  it("fails preflight when announce delivery channel is missing", async () => {
    callGatewayFromCli.mockClear();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "job-1",
              sessionTarget: "isolated",
              delivery: { mode: "announce", channel: "zulip" },
            },
          ],
        };
      }
      if (method === "channels.status") {
        return {
          channelOrder: ["imessage"],
          channels: { imessage: { configured: true } },
          channelAccounts: {},
          channelDefaultAccountId: {},
        };
      }
      if (method === "cron.run") {
        return { ok: true, ran: true };
      }
      return defaultGatewayRpcMock(method, {}, undefined);
    });

    const program = buildProgram();
    await expect(program.parseAsync(["cron", "run", "job-1"], { from: "user" })).rejects.toThrow(
      "__exit__:1",
    );
    expect(callGatewayFromCli.mock.calls.some((call) => call[0] === "cron.run")).toBe(false);

    callGatewayFromCli.mockImplementation(defaultGatewayRpcMock);
  });
});
