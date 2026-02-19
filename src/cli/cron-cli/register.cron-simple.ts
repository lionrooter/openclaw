import type { Command } from "commander";
import { danger } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "../gateway-rpc.js";
import { warnIfCronSchedulerDisabled } from "./shared.js";

type CronRunCliOpts = GatewayRpcOpts & {
  due?: boolean;
  preflight?: boolean;
  verifyOnTimeout?: boolean;
  verifyTimeout?: string;
  verifyPoll?: string;
  preflightTimeout?: string;
};

type CronRunResponse = {
  ok?: boolean;
  ran?: boolean;
  reason?: string;
};

type CronRunLogEntry = {
  ts?: number;
  status?: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
};

type CronRunsResponse = {
  entries?: CronRunLogEntry[];
};

type CronJobSummary = {
  id?: string;
  name?: string;
  sessionTarget?: string;
  delivery?: {
    mode?: string;
    channel?: string;
    to?: string;
  };
};

type CronListResponse = {
  jobs?: CronJobSummary[];
};

type ChannelsStatusResponse = {
  channelOrder?: string[];
  channels?: Record<string, unknown>;
  channelAccounts?: Record<string, unknown>;
  channelDefaultAccountId?: Record<string, string>;
};

function parseIntegerOption(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function isGatewayTimeoutError(err: unknown): boolean {
  return String(err).includes("gateway timeout after");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function formatUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveAnnounceDeliveryChannel(job: CronJobSummary | undefined): string | null {
  if (!job || job.sessionTarget !== "isolated") {
    return null;
  }
  const mode = job.delivery?.mode?.trim().toLowerCase();
  if (mode !== "announce") {
    return null;
  }
  const channel = job.delivery?.channel?.trim().toLowerCase() ?? "";
  if (!channel || channel === "last") {
    return null;
  }
  return channel;
}

async function getLatestRunEntry(
  id: string,
  opts: GatewayRpcOpts,
  limit = 20,
): Promise<CronRunLogEntry | undefined> {
  const response = (await callGatewayFromCli(
    "cron.runs",
    opts,
    { id, limit },
    { progress: false },
  )) as CronRunsResponse;
  const entries = Array.isArray(response.entries) ? response.entries : [];
  return entries[entries.length - 1];
}

async function findVerifiedRunEntry(params: {
  id: string;
  opts: GatewayRpcOpts;
  baselineTs?: number;
  startedAtMs: number;
  timeoutMs: number;
  pollMs: number;
}): Promise<CronRunLogEntry | undefined> {
  const deadline = Date.now() + params.timeoutMs;
  let lastReadError: unknown;
  while (Date.now() <= deadline) {
    try {
      const response = (await callGatewayFromCli(
        "cron.runs",
        params.opts,
        { id: params.id, limit: 30 },
        { progress: false },
      )) as CronRunsResponse;
      const entries = Array.isArray(response.entries) ? response.entries : [];
      const candidate = entries.toReversed().find((entry) => {
        const ts = typeof entry.ts === "number" ? entry.ts : 0;
        const runAtMs = typeof entry.runAtMs === "number" ? entry.runAtMs : ts;
        if (typeof params.baselineTs === "number" && ts <= params.baselineTs) {
          return false;
        }
        // Guard against stale log entries when baseline lookup failed.
        if (runAtMs + 1000 < params.startedAtMs && ts + 1000 < params.startedAtMs) {
          return false;
        }
        return true;
      });
      if (candidate) {
        return candidate;
      }
    } catch (err) {
      lastReadError = err;
    }

    const waitMs = Math.max(100, params.pollMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  if (lastReadError) {
    throw new Error(
      `could not verify cron run completion from run logs: ${formatUnknown(lastReadError)}`,
    );
  }
  return undefined;
}

async function runDeliveryPreflight(params: {
  id: string;
  opts: GatewayRpcOpts;
  timeoutMs: number;
}) {
  const list = (await callGatewayFromCli(
    "cron.list",
    params.opts,
    { includeDisabled: true },
    { progress: false },
  )) as CronListResponse;
  const jobs = Array.isArray(list.jobs) ? list.jobs : [];
  const job = jobs.find((entry) => entry?.id === params.id);
  const channelId = resolveAnnounceDeliveryChannel(job);
  if (!channelId) {
    return;
  }

  const status = (await callGatewayFromCli(
    "channels.status",
    params.opts,
    {
      probe: false,
      timeoutMs: params.timeoutMs,
    },
    { progress: false },
  )) as ChannelsStatusResponse;

  const channelOrder = Array.isArray(status.channelOrder) ? status.channelOrder : [];
  const channelsRecord = asRecord(status.channels) ?? {};
  const knownChannelIds = new Set<string>([...channelOrder, ...Object.keys(channelsRecord)]);
  if (!knownChannelIds.has(channelId)) {
    throw new Error(
      `preflight failed: cron delivery channel "${channelId}" is not available in gateway channel status`,
    );
  }

  const channelSummary = asRecord(channelsRecord[channelId]);
  if (channelSummary) {
    if (readBool(channelSummary.configured) === false) {
      throw new Error(`preflight failed: channel "${channelId}" is configured=false`);
    }
    if (readBool(channelSummary.running) === false) {
      defaultRuntime.log(theme.warn(`preflight warning: channel "${channelId}" is running=false`));
    }
    if (readBool(channelSummary.connected) === false) {
      defaultRuntime.log(
        theme.warn(`preflight warning: channel "${channelId}" is connected=false`),
      );
    }
  }

  const accountsRecord = asRecord(status.channelAccounts);
  const defaultAccountIdRecord = asRecord(status.channelDefaultAccountId);
  const defaultAccountIdRaw = defaultAccountIdRecord?.[channelId];
  const defaultAccountId =
    typeof defaultAccountIdRaw === "string" && defaultAccountIdRaw.trim()
      ? defaultAccountIdRaw.trim()
      : null;

  const channelAccounts = Array.isArray(accountsRecord?.[channelId])
    ? (accountsRecord?.[channelId] as unknown[])
    : [];
  if (channelAccounts.length === 0) {
    return;
  }

  const defaultAccount =
    channelAccounts.find((entry) => {
      const accountRecord = asRecord(entry);
      return accountRecord && accountRecord.accountId === defaultAccountId;
    }) ?? channelAccounts[0];
  const defaultAccountRecord = asRecord(defaultAccount);
  if (!defaultAccountRecord) {
    return;
  }
  const defaultAccountIdLabel = readString(defaultAccountRecord.accountId) ?? "unknown";

  if (readBool(defaultAccountRecord.configured) === false) {
    throw new Error(
      `preflight failed: default account for "${channelId}" is configured=false (accountId=${defaultAccountIdLabel})`,
    );
  }
  if (readBool(defaultAccountRecord.running) === false) {
    defaultRuntime.log(
      theme.warn(
        `preflight warning: default account for "${channelId}" is running=false (accountId=${defaultAccountIdLabel})`,
      ),
    );
  }
  if (readBool(defaultAccountRecord.connected) === false) {
    defaultRuntime.log(
      theme.warn(
        `preflight warning: default account for "${channelId}" is connected=false (accountId=${defaultAccountIdLabel})`,
      ),
    );
  }
}

function registerCronToggleCommand(params: {
  cron: Command;
  name: "enable" | "disable";
  description: string;
  enabled: boolean;
}) {
  addGatewayClientOptions(
    params.cron
      .command(params.name)
      .description(params.description)
      .argument("<id>", "Job id")
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch: { enabled: params.enabled },
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}

export function registerCronSimpleCommands(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("rm")
      .alias("remove")
      .alias("delete")
      .description("Remove a cron job")
      .argument("<id>", "Job id")
      .option("--json", "Output JSON", false)
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.remove", opts, { id });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  registerCronToggleCommand({
    cron,
    name: "enable",
    description: "Enable a cron job",
    enabled: true,
  });
  registerCronToggleCommand({
    cron,
    name: "disable",
    description: "Disable a cron job",
    enabled: false,
  });

  addGatewayClientOptions(
    cron
      .command("runs")
      .description("Show cron run history (JSONL-backed)")
      .requiredOption("--id <id>", "Job id")
      .option("--limit <n>", "Max entries (default 50)", "50")
      .action(async (opts) => {
        try {
          const limitRaw = Number.parseInt(String(opts.limit ?? "50"), 10);
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
          const id = String(opts.id);
          const res = await callGatewayFromCli("cron.runs", opts, {
            id,
            limit,
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("run")
      .description("Run a cron job now (debug)")
      .argument("<id>", "Job id")
      .option("--due", "Run only when due (default behavior in older versions)", false)
      .option("--no-preflight", "Skip delivery preflight checks for isolated announce jobs")
      .option(
        "--no-verify-on-timeout",
        "Skip run-log verification when the cron.run request times out",
      )
      .option(
        "--verify-timeout <ms>",
        "Max time to wait for a new run-log entry after timeout",
        "120000",
      )
      .option("--verify-poll <ms>", "Poll interval for run-log verification", "3000")
      .option("--preflight-timeout <ms>", "Timeout for channels.status preflight check", "5000")
      .action(async (id, opts: CronRunCliOpts) => {
        try {
          const preflightTimeoutMs = parseIntegerOption(opts.preflightTimeout, 5000, 1000, 120_000);
          const verifyTimeoutMs = parseIntegerOption(opts.verifyTimeout, 120_000, 1000, 900_000);
          const verifyPollMs = parseIntegerOption(opts.verifyPoll, 3000, 100, 60_000);
          const shouldVerifyOnTimeout = opts.verifyOnTimeout !== false;
          const jobId = String(id).trim();

          if (opts.preflight !== false) {
            await runDeliveryPreflight({
              id: jobId,
              opts,
              timeoutMs: preflightTimeoutMs,
            });
          }

          const baselineEntry = shouldVerifyOnTimeout
            ? await getLatestRunEntry(jobId, opts, 1).catch(() => undefined)
            : undefined;
          const startedAtMs = Date.now();

          let res: CronRunResponse;
          try {
            res = (await callGatewayFromCli("cron.run", opts, {
              id: jobId,
              mode: opts.due ? "due" : "force",
            })) as CronRunResponse;
          } catch (err) {
            if (!shouldVerifyOnTimeout || !isGatewayTimeoutError(err)) {
              throw err;
            }
            defaultRuntime.log(
              theme.warn(
                `cron.run timed out; verifying completion from run log for job "${jobId}"...`,
              ),
            );
            const verifiedEntry = await findVerifiedRunEntry({
              id: jobId,
              opts,
              baselineTs:
                typeof baselineEntry?.ts === "number" && Number.isFinite(baselineEntry.ts)
                  ? baselineEntry.ts
                  : undefined,
              startedAtMs,
              timeoutMs: verifyTimeoutMs,
              pollMs: verifyPollMs,
            });
            if (!verifiedEntry) {
              throw new Error(
                [
                  String(err),
                  `verification timed out after ${verifyTimeoutMs}ms waiting for a new cron run log entry`,
                  `Inspect: openclaw cron runs --id ${jobId} --limit 20`,
                ].join("\n"),
                { cause: err },
              );
            }
            const verifiedPayload = {
              ok: verifiedEntry.status !== "error",
              ran: true,
              verifiedFromRuns: true,
              timeoutRecovered: true,
              status: verifiedEntry.status ?? "unknown",
              summary: verifiedEntry.summary,
              error: verifiedEntry.error,
              ts: verifiedEntry.ts,
              runAtMs: verifiedEntry.runAtMs,
              durationMs: verifiedEntry.durationMs,
              sessionId: verifiedEntry.sessionId,
              sessionKey: verifiedEntry.sessionKey,
            };
            defaultRuntime.log(JSON.stringify(verifiedPayload, null, 2));
            if (verifiedEntry.status === "error") {
              defaultRuntime.exit(1);
            }
            return;
          }

          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
