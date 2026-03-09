#!/usr/bin/env -S node --import tsx

import { readZulipUrl } from "../extensions/zulip/src/zulip/url-bridge.js";
import { loadConfig } from "../src/config/config.js";

type CliOptions = {
  accountId?: string;
  messagesBefore?: number;
  messagesAfter?: number;
  url?: string;
};

function printUsage(): void {
  process.stderr.write(
    [
      "Usage: node --import tsx scripts/zulip-read-url.ts [--account <id>] [--before <n>] [--after <n>] <zulip-url>",
      "",
      "Examples:",
      "  node --import tsx scripts/zulip-read-url.ts --account cody 'https://zulip.example.com/user_uploads/.../PastedText.txt'",
      "  node --import tsx scripts/zulip-read-url.ts --account cody 'https://zulip.example.com/#narrow/channel/5-.../topic/.../near/3538'",
    ].join("\n") + "\n",
  );
}

function parseIntegerFlag(raw: string, flag: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  let flagsDone = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      if (index === 0) {
        continue;
      }
      flagsDone = true;
      continue;
    }
    if (!flagsDone && (arg === "--help" || arg === "-h")) {
      printUsage();
      process.exit(0);
    }
    if (!flagsDone && arg === "--account") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--account requires a value.");
      }
      options.accountId = next;
      index += 1;
      continue;
    }
    if (!flagsDone && arg === "--before") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--before requires a value.");
      }
      options.messagesBefore = parseIntegerFlag(next, "--before");
      index += 1;
      continue;
    }
    if (!flagsDone && arg === "--after") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--after requires a value.");
      }
      options.messagesAfter = parseIntegerFlag(next, "--after");
      index += 1;
      continue;
    }
    if (!flagsDone && arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (options.url) {
      throw new Error("Only one Zulip URL may be passed.");
    }
    options.url = arg;
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.url) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const text = await readZulipUrl({
    cfg: loadConfig(),
    url: options.url,
    accountId: options.accountId,
    messagesBefore: options.messagesBefore,
    messagesAfter: options.messagesAfter,
  });
  process.stdout.write(`${text}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `zulip-read-url: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
