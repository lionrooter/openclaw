import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  listEnabledZulipAccounts,
  resolveZulipAccount,
  type ResolvedZulipAccount,
} from "./accounts.js";
import { createZulipClient, fetchZulipMessages, type ZulipMessage } from "./client.js";

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".bash",
  ".log",
  ".env",
  ".cfg",
  ".ini",
  ".conf",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".sql",
  ".swift",
]);

export type ParsedZulipBridgeTarget =
  | {
      kind: "upload";
      baseUrl: string;
      uploadPath: string;
      fileName: string;
    }
  | {
      kind: "narrow";
      baseUrl: string;
      streamOperand: number | string;
      streamLabel: string;
      topic: string;
      nearMessageId?: number;
    };

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function decodeZulipNarrowSegment(segment: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  })();

  let out = "";
  let i = 0;
  while (i < decoded.length) {
    if (decoded[i] === "." && /^[0-9a-fA-F]{2}$/.test(decoded.slice(i + 1, i + 3))) {
      const bytes: number[] = [];
      while (decoded[i] === "." && /^[0-9a-fA-F]{2}$/.test(decoded.slice(i + 1, i + 3))) {
        bytes.push(Number.parseInt(decoded.slice(i + 1, i + 3), 16));
        i += 3;
      }
      out += Buffer.from(bytes).toString("utf8");
      continue;
    }
    out += decoded[i];
    i += 1;
  }

  return out;
}

function parseStreamOperand(raw: string): { operand: number | string; label: string } {
  const decoded = decodeZulipNarrowSegment(raw);
  const numericPrefix = /^(\d+)(?:-(.*))?$/.exec(decoded);
  if (numericPrefix?.[1]) {
    const operand = Number.parseInt(numericPrefix[1], 10);
    return {
      operand: Number.isFinite(operand) ? operand : decoded,
      label: numericPrefix[2] ? decodeZulipNarrowSegment(numericPrefix[2]) : decoded,
    };
  }
  return { operand: decoded, label: decoded };
}

function ensureAccountUsable(account: ResolvedZulipAccount): void {
  if (!account.enabled) {
    throw new Error(`Zulip account "${account.accountId}" is disabled.`);
  }
  if (!account.baseUrl) {
    throw new Error(`Zulip account "${account.accountId}" has no baseUrl.`);
  }
  if (!account.botEmail || !account.botApiKey) {
    throw new Error(`Zulip account "${account.accountId}" is missing credentials.`);
  }
}

function resolveBridgeAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  baseUrl: string;
}): ResolvedZulipAccount {
  if (params.accountId?.trim()) {
    const account = resolveZulipAccount({ cfg: params.cfg, accountId: params.accountId.trim() });
    ensureAccountUsable(account);
    if (normalizeBaseUrl(account.baseUrl ?? "") !== params.baseUrl) {
      throw new Error(
        `Zulip account "${account.accountId}" is configured for ${account.baseUrl ?? "(missing baseUrl)"}, not ${params.baseUrl}.`,
      );
    }
    return account;
  }

  const candidates = listEnabledZulipAccounts(params.cfg).filter((account) => {
    if (!account.botEmail || !account.botApiKey || !account.baseUrl) {
      return false;
    }
    return normalizeBaseUrl(account.baseUrl) === params.baseUrl;
  });

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length === 0) {
    throw new Error(`No configured Zulip account matches ${params.baseUrl}.`);
  }

  const ids = candidates.map((account) => account.accountId).join(", ");
  throw new Error(`Multiple Zulip accounts match ${params.baseUrl} (${ids}). Pass --account <id>.`);
}

function isTextLikeUpload(params: { fileName: string; contentType?: string }): boolean {
  const normalizedType = params.contentType?.split(";")[0]?.trim().toLowerCase();
  if (normalizedType?.startsWith("text/")) {
    return true;
  }
  if (
    normalizedType === "application/json" ||
    normalizedType === "application/xml" ||
    normalizedType === "text/xml" ||
    normalizedType === "application/yaml" ||
    normalizedType === "text/yaml"
  ) {
    return true;
  }
  return TEXT_EXTENSIONS.has(path.extname(params.fileName).toLowerCase());
}

function stripMessageContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

export function parseZulipBridgeUrl(rawUrl: string): ParsedZulipBridgeTarget {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }

  const baseUrl = normalizeBaseUrl(url.origin);
  if (url.pathname.startsWith("/user_uploads/")) {
    return {
      kind: "upload",
      baseUrl,
      uploadPath: url.pathname,
      fileName: path.basename(url.pathname),
    };
  }

  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const normalizedHash = hash.replace(/^\/+/, "");
  const segments = normalizedHash.split("/").filter(Boolean);
  if (segments[0] !== "narrow") {
    throw new Error(`Unsupported Zulip URL: ${rawUrl}`);
  }

  let streamOperand: number | string | undefined;
  let streamLabel: string | undefined;
  let topic: string | undefined;
  let nearMessageId: number | undefined;

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) {
      continue;
    }
    if (segment === "stream" || segment === "channel") {
      const next = segments[index + 1];
      if (next) {
        const parsed = parseStreamOperand(next);
        streamOperand = parsed.operand;
        streamLabel = parsed.label;
        index += 1;
      }
      continue;
    }
    if (segment === "topic") {
      const next = segments[index + 1];
      if (next) {
        topic = decodeZulipNarrowSegment(next);
        index += 1;
      }
      continue;
    }
    if (segment === "near" || segment === "with") {
      const next = segments[index + 1];
      if (next) {
        const parsed = Number.parseInt(next, 10);
        if (Number.isFinite(parsed)) {
          nearMessageId = parsed;
        }
        index += 1;
      }
    }
  }

  if (!streamOperand || !streamLabel || !topic) {
    throw new Error(`Unsupported or incomplete Zulip narrow URL: ${rawUrl}`);
  }

  return {
    kind: "narrow",
    baseUrl,
    streamOperand,
    streamLabel,
    topic,
    nearMessageId,
  };
}

function formatTranscriptMessage(message: ZulipMessage): string {
  const iso = new Date(message.timestamp * 1000).toISOString();
  const content = stripMessageContent(message.content ?? "");
  return `[${iso}] ${message.sender_full_name} (#${message.id}): ${content}`;
}

async function readUploadTarget(params: {
  target: Extract<ParsedZulipBridgeTarget, { kind: "upload" }>;
  account: ResolvedZulipAccount;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const client = createZulipClient({
    baseUrl: params.account.baseUrl!,
    botEmail: params.account.botEmail!,
    botApiKey: params.account.botApiKey!,
    fetchImpl: params.fetchImpl,
  });
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(`${client.baseUrl}${params.target.uploadPath}`, {
    headers: { Authorization: client.authHeader },
  });
  if (!response.ok) {
    throw new Error(`Zulip upload fetch ${response.status}: ${await response.text()}`);
  }
  const contentType = response.headers.get("content-type") ?? undefined;
  const buffer = Buffer.from(await response.arrayBuffer());

  if (!isTextLikeUpload({ fileName: params.target.fileName, contentType })) {
    return [
      `Zulip upload via account ${params.account.accountId}`,
      `URL: ${params.target.baseUrl}${params.target.uploadPath}`,
      `File: ${params.target.fileName}`,
      `Content-Type: ${contentType ?? "unknown"}`,
      `Bytes: ${buffer.length}`,
      "",
      "(Binary upload not inlined.)",
    ].join("\n");
  }

  return [
    `Zulip upload via account ${params.account.accountId}`,
    `URL: ${params.target.baseUrl}${params.target.uploadPath}`,
    `File: ${params.target.fileName}`,
    `Content-Type: ${contentType ?? "unknown"}`,
    "",
    buffer.toString("utf8").replaceAll("\u0000", ""),
  ].join("\n");
}

async function readNarrowTarget(params: {
  target: Extract<ParsedZulipBridgeTarget, { kind: "narrow" }>;
  account: ResolvedZulipAccount;
  fetchImpl?: typeof fetch;
  messagesBefore?: number;
  messagesAfter?: number;
}): Promise<string> {
  const client = createZulipClient({
    baseUrl: params.account.baseUrl!,
    botEmail: params.account.botEmail!,
    botApiKey: params.account.botApiKey!,
    fetchImpl: params.fetchImpl,
  });
  const messages = await fetchZulipMessages(client, {
    anchor: params.target.nearMessageId ?? "newest",
    numBefore: params.messagesBefore ?? 3,
    numAfter: params.messagesAfter ?? 3,
    narrow: [
      { operator: "stream", operand: params.target.streamOperand },
      { operator: "topic", operand: params.target.topic },
    ],
  });

  if (messages.length === 0) {
    return [
      `Zulip narrow via account ${params.account.accountId}`,
      `Stream: ${params.target.streamLabel}`,
      `Topic: ${params.target.topic}`,
      "",
      "(No messages found.)",
    ].join("\n");
  }

  const ordered = [...messages].toSorted((a, b) => a.id - b.id);
  return [
    `Zulip narrow via account ${params.account.accountId}`,
    `Stream: ${params.target.streamLabel}`,
    `Topic: ${params.target.topic}`,
    ...(params.target.nearMessageId ? [`Near: ${params.target.nearMessageId}`] : []),
    "",
    ...ordered.map(formatTranscriptMessage),
  ].join("\n");
}

export async function readZulipUrl(params: {
  cfg: OpenClawConfig;
  url: string;
  accountId?: string;
  fetchImpl?: typeof fetch;
  messagesBefore?: number;
  messagesAfter?: number;
}): Promise<string> {
  const target = parseZulipBridgeUrl(params.url);
  const account = resolveBridgeAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    baseUrl: target.baseUrl,
  });

  if (target.kind === "upload") {
    return await readUploadTarget({
      target,
      account,
      fetchImpl: params.fetchImpl,
    });
  }

  return await readNarrowTarget({
    target,
    account,
    fetchImpl: params.fetchImpl,
    messagesBefore: params.messagesBefore,
    messagesAfter: params.messagesAfter,
  });
}
