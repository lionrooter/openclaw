import type {
  ChannelAccountSnapshot,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import * as crypto from "crypto";
import * as fs from "fs";
import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logInboundDrop,
  logTypingFailure,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
  resolveControlCommandGate,
  resolveChannelMediaMaxBytes,
  resolveAckReaction,
  shouldAckReaction as shouldAckReactionGate,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import * as os from "os";
import * as path from "path";
import type { ZulipXCaseConfig } from "../types.js";
import { getZulipRuntime } from "../runtime.js";
import { resolveZulipAccount } from "./accounts.js";
import {
  createZulipClient,
  fetchZulipMe,
  fetchZulipMessages,
  getZulipStreamId,
  registerZulipQueue,
  getZulipEvents,
  sendZulipTyping,
  addZulipReaction,
  removeZulipReaction,
  updateZulipMessage,
  normalizeZulipBaseUrl,
  type ZulipClient,
  type ZulipMessage,
} from "./client.js";
import { sendMessageZulip } from "./send.js";

const OPENCLAW_STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
const ZULIP_CACHE_DIR = path.join(OPENCLAW_STATE_DIR, "cache", "zulip");
const ZULIP_UPLOAD_CACHE_DIR = path.join(ZULIP_CACHE_DIR, "uploads");

// Ensure cache directory exists
try {
  for (const dir of [ZULIP_CACHE_DIR, ZULIP_UPLOAD_CACHE_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
} catch {
  // Ignore errors during module load
}

/**
 * Extract Zulip user_uploads URLs from message content.
 * Matches markdown links like [filename](/user_uploads/...)
 */
function extractZulipUploadUrls(content: string): Array<{ name: string; path: string }> {
  const matches: Array<{ name: string; path: string }> = [];
  // Match markdown links: [name](/user_uploads/...)
  const markdownRegex = /\[([^\]]+)\]\(\/user_uploads\/([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdownRegex.exec(content)) !== null) {
    matches.push({ name: match[1], path: `/user_uploads/${match[2]}` });
  }
  // Also match bare URLs
  const bareRegex = /\/user_uploads\/[\w/.-]+/g;
  while ((match = bareRegex.exec(content)) !== null) {
    // Skip if already captured in markdown
    if (!matches.some((m) => m.path === match![0])) {
      const filename = match[0].split("/").pop() ?? "upload";
      matches.push({ name: filename, path: match[0] });
    }
  }
  return matches;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceUploadReferences(
  content: string,
  upload: { name: string; path: string },
  replacement: string,
): string {
  const markdownRef = new RegExp(
    `\\[${escapeRegex(upload.name)}\\]\\(${escapeRegex(upload.path)}\\)`,
    "g",
  );
  const bareRef = new RegExp(escapeRegex(upload.path), "g");
  return content.replace(markdownRef, replacement).replace(bareRef, replacement);
}

/**
 * Download a Zulip upload to local cache and return the local path.
 */
type ZulipUploadDownloadResult = {
  localPath: string | null;
  tooLarge: boolean;
};

async function downloadZulipUpload(
  client: ZulipClient,
  uploadPath: string,
  fileName: string,
  maxBytes: number,
): Promise<ZulipUploadDownloadResult> {
  try {
    const url = `${client.baseUrl}${uploadPath}`;
    const res = await fetch(url, {
      headers: { Authorization: client.authHeader },
    });
    if (!res.ok) {
      console.error(`[zulip] Failed to download ${uploadPath}: ${res.status}`);
      return { localPath: null, tooLarge: false };
    }

    const contentLengthHeader = res.headers.get("content-length");
    const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : NaN;
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { localPath: null, tooLarge: true };
    }

    let totalBytes = 0;
    const chunks: Buffer[] = [];
    if (res.body) {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          return { localPath: null, tooLarge: true };
        }
        chunks.push(Buffer.from(value));
      }
    } else {
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > maxBytes) {
        return { localPath: null, tooLarge: true };
      }
      chunks.push(buffer);
    }
    const buffer = Buffer.concat(chunks);

    // Create unique filename based on upload path hash
    const hash = uploadPath.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
    const ext = path.extname(fileName) || ".bin";
    const localName = `${Date.now()}_${hash}${ext}`;
    const localPath = path.join(ZULIP_UPLOAD_CACHE_DIR, localName);

    fs.writeFileSync(localPath, buffer);
    return { localPath, tooLarge: false };
  } catch (err) {
    console.error(`[zulip] Error downloading ${uploadPath}: ${String(err)}`);
    return { localPath: null, tooLarge: false };
  }
}

/** Extensions treated as readable text (content inlined into the prompt). */
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

const MAX_INLINE_TEXT_BYTES = 100_000; // ~100 KB cap for inlined text

function isTextFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Process message content: download any Zulip uploads and return info about them.
 * Text files are read and inlined directly into the prompt.
 * Binary/image files get paths noted for tool-based access.
 */
async function processZulipUploads(
  client: ZulipClient,
  content: string,
  maxBytes: number,
): Promise<{ attachmentInfo: string; strippedContent: string }> {
  const uploads = extractZulipUploadUrls(content);
  if (uploads.length === 0) {
    return { attachmentInfo: "", strippedContent: content };
  }

  const attachmentLines: string[] = [];
  let strippedContent = content;

  for (const upload of uploads) {
    const download = await downloadZulipUpload(client, upload.path, upload.name, maxBytes);
    const localPath = download.localPath;
    if (localPath) {
      // Inline text file content directly so the agent can see it without tools
      if (isTextFile(upload.name)) {
        try {
          const stat = fs.statSync(localPath);
          if (stat.size <= MAX_INLINE_TEXT_BYTES) {
            const text = fs.readFileSync(localPath, "utf-8");
            attachmentLines.push(`📎 File "${upload.name}":\n\`\`\`\n${text}\n\`\`\``);
          } else {
            attachmentLines.push(
              `📎 File "${upload.name}" (${Math.round(stat.size / 1024)} KB — too large to inline): ${localPath}`,
            );
          }
        } catch {
          attachmentLines.push(`📎 Attachment "${upload.name}": ${localPath}`);
        }
      } else {
        attachmentLines.push(`📎 Attachment "${upload.name}": ${localPath}`);
      }
      strippedContent = replaceUploadReferences(
        strippedContent,
        upload,
        `[attached: ${upload.name}]`,
      );
    } else {
      // Download failed — strip the raw URL and note the failure so the agent doesn't try to fetch it
      if (download.tooLarge) {
        attachmentLines.push(
          `📎 File "${upload.name}": (download skipped — exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit)`,
        );
        strippedContent = replaceUploadReferences(
          strippedContent,
          upload,
          `[attached: ${upload.name} — too large to download]`,
        );
      } else {
        attachmentLines.push(
          `📎 File "${upload.name}": (download failed — file could not be retrieved from Zulip)`,
        );
        strippedContent = replaceUploadReferences(
          strippedContent,
          upload,
          `[attached: ${upload.name} — download failed]`,
        );
      }
    }
  }

  return {
    attachmentInfo:
      attachmentLines.length > 0 ? `\n[Attached files]\n${attachmentLines.join("\n")}` : "",
    strippedContent,
  };
}

export type MonitorZulipOpts = {
  botEmail?: string;
  botApiKey?: string;
  baseUrl?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

/** Map common Unicode emoji to Zulip emoji names for ack reactions. */
const EMOJI_TO_ZULIP_NAME: Record<string, string> = {
  "👀": "eyes",
  "👍": "thumbs_up",
  "✅": "check",
  "🤔": "thinking",
  "⏳": "hourglass",
  "🔄": "arrows_counterclockwise",
  "💬": "speech_balloon",
  "🧠": "brain",
  "⚡": "zap",
  "🦞": "lobster",
  "💻": "computer",
  "🎨": "art",
  "🎮": "video_game",
  "🎯": "dart",
  "📈": "chart_with_upwards_trend",
  "🌱": "seedling",
  "🪺": "nesting_dolls",
};

function emojiToZulipName(emoji: string): string {
  return EMOJI_TO_ZULIP_NAME[emoji] ?? "eyes";
}

const RECENT_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MESSAGE_MAX = 2000;
const STREAM_ID_CACHE_TTL_MS = 10 * 60_000;

// Simple dedup cache
const recentIds = new Map<string, number>();

function dedup(key: string): boolean {
  const now = Date.now();
  // prune old
  if (recentIds.size > RECENT_MESSAGE_MAX) {
    const cutoff = now - RECENT_MESSAGE_TTL_MS;
    for (const [k, ts] of recentIds) {
      if (ts < cutoff) {
        recentIds.delete(k);
      }
    }
  }
  if (recentIds.has(key)) {
    return true;
  }
  recentIds.set(key, now);
  return false;
}

function resolveRuntime(opts: MonitorZulipOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    }
  );
}

function normalizeAllowEntry(entry: string): string {
  return entry
    .trim()
    .replace(/^(zulip|user):/i, "")
    .toLowerCase();
}

function normalizeAllowList(entries: Array<string | number>): string[] {
  return Array.from(new Set(entries.map((e) => normalizeAllowEntry(String(e))).filter(Boolean)));
}

function isSenderAllowed(params: {
  senderEmail: string;
  senderId: number;
  allowFrom: string[];
}): boolean {
  if (params.allowFrom.length === 0) {
    return false;
  }
  if (params.allowFrom.includes("*")) {
    return true;
  }
  const email = params.senderEmail.toLowerCase();
  const id = String(params.senderId);
  return params.allowFrom.some((e) => e === email || e === id);
}

function messageKind(msg: ZulipMessage): "dm" | "stream" {
  return msg.type === "private" ? "dm" : "stream";
}

function chatType(kind: "dm" | "stream"): "direct" | "channel" {
  return kind === "dm" ? "direct" : "channel";
}

/** Extract stream name from display_recipient (string for streams, array for DMs). */
function streamName(msg: ZulipMessage): string {
  if (typeof msg.display_recipient === "string") {
    return msg.display_recipient;
  }
  return "";
}

/** Build the "to" target string for routing replies back. */
function buildReplyTo(msg: ZulipMessage): string {
  if (msg.type === "stream") {
    return `stream:${streamName(msg)}:topic:${msg.subject}`;
  }
  // DM: send to sender
  return `dm:${msg.sender_id}`;
}

async function resolveZulipTopicHistory(params: {
  client: ZulipClient;
  stream: string;
  topic: string;
  currentMessageId: number;
  limit?: number;
}): Promise<ZulipMessage[]> {
  const maxMessages = params.limit ?? 20;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) {
    return [];
  }

  try {
    const messages = await fetchZulipMessages(params.client, {
      anchor: "newest",
      numBefore: maxMessages + 1,
      numAfter: 0,
      narrow: [
        { operator: "stream", operand: params.stream },
        { operator: "topic", operand: params.topic },
      ],
    });

    return messages
      .filter((message) => message.id !== params.currentMessageId)
      .filter((message) => Boolean(message.content?.trim()))
      .slice()
      .toSorted((a, b) => a.id - b.id)
      .slice(-maxMessages);
  } catch {
    return [];
  }
}

type ZulipTopicHistoryEnvelope = {
  channel: "Zulip";
  from: string;
  timestamp?: number;
  body: string;
  chatType: "channel";
  sender: { name: string; id: string };
};

export function formatZulipTopicHistoryBody(params: {
  messages: ZulipMessage[];
  botUserId: number;
  formatInboundEnvelope: (envelope: ZulipTopicHistoryEnvelope) => string;
}): string | undefined {
  if (params.messages.length === 0) {
    return undefined;
  }
  const historyParts: string[] = [];
  for (const historyMsg of params.messages) {
    const historySenderName = historyMsg.sender_full_name || historyMsg.sender_email;
    const role = historyMsg.sender_id === params.botUserId ? "assistant" : "user";
    const msgWithId = `${historyMsg.content}\n[zulip message id: ${historyMsg.id}]`;
    historyParts.push(
      params.formatInboundEnvelope({
        channel: "Zulip",
        from: `${historySenderName} (${role})`,
        timestamp: historyMsg.timestamp ? historyMsg.timestamp * 1000 : undefined,
        body: msgWithId,
        chatType: "channel",
        sender: { name: historySenderName, id: String(historyMsg.sender_id) },
      }),
    );
  }
  return historyParts.length > 0 ? historyParts.join("\n\n") : undefined;
}

export async function resolveZulipTopicContext(params: {
  client: ZulipClient;
  kind: "dm" | "stream";
  streamName: string;
  topic: string;
  currentMessageId: number;
  botUserId: number;
  initialHistoryLimit: number;
  sessionPreviousTimestamp?: number;
  formatInboundEnvelope: (envelope: ZulipTopicHistoryEnvelope) => string;
  logVerbose?: (message: string) => void;
}): Promise<{
  threadHistoryBody?: string;
  threadLabel?: string;
  isFirstTopicTurn: boolean;
}> {
  if (params.kind === "dm" || !params.streamName) {
    return { isFirstTopicTurn: false };
  }

  const threadLabel = `Zulip topic #${params.streamName} > ${params.topic}`;
  const isFirstTopicTurn = !params.sessionPreviousTimestamp;
  if (!isFirstTopicTurn) {
    params.logVerbose?.(`zulip: skip topic history for existing session ${threadLabel}`);
    return { threadLabel, isFirstTopicTurn };
  }
  if (params.initialHistoryLimit <= 0) {
    params.logVerbose?.(
      `zulip: topic history disabled for ${threadLabel} (initialHistoryLimit=${params.initialHistoryLimit})`,
    );
    return { threadLabel, isFirstTopicTurn };
  }

  const topicHistory = await resolveZulipTopicHistory({
    client: params.client,
    stream: params.streamName,
    topic: params.topic,
    currentMessageId: params.currentMessageId,
    limit: params.initialHistoryLimit,
  });
  const threadHistoryBody = formatZulipTopicHistoryBody({
    messages: topicHistory,
    botUserId: params.botUserId,
    formatInboundEnvelope: params.formatInboundEnvelope,
  });
  if (threadHistoryBody) {
    params.logVerbose?.(
      `zulip: populated topic history with ${topicHistory.length} messages for new session`,
    );
  }

  return {
    threadHistoryBody,
    threadLabel,
    isFirstTopicTurn,
  };
}

type XCaseStatus = "open" | "in_progress" | "noaction" | "moved" | "error";

type XCaseRecord = {
  id: string;
  url: string;
  status: XCaseStatus;
  createdAt: number;
  updatedAt: number;
  originMessageId: string;
  originStream: string;
  originTopic: string;
  originSenderId: number;
  originSenderEmail: string;
  /** Where the intake card lives (single intake topic). */
  intakeStream: string;
  intakeTopic: string;
  /** Where analysis is posted (may be shared per-agent inbox or a dedicated topic). */
  analysisStream: string;
  analysisTopic: string;
  /** True when analysisTopic is intended to be dedicated to this case (used for topic->case inference). */
  dedicatedTopic: boolean;
  routePeerId: string;
  expertAgentId?: string;
  routeKey?: string;
  cardMessageId?: string;
  analysisFirstMessageId?: string;
  analysisLastMessageId?: string;
  analysisPostAsAccountId?: string;
  lastError?: string;
};

type XCaseStore = {
  version: 2;
  cases: XCaseRecord[];
};

type XCaseCommand =
  | { op: "help" }
  | { op: "list"; scope: "open" | "all" }
  | { op: "status"; caseId?: string }
  | { op: "continue"; caseId?: string; note?: string }
  | { op: "move"; caseId?: string; stream?: string; topic?: string }
  | { op: "close"; caseId?: string; reason?: string }
  | { op: "noaction"; caseId?: string; reason?: string };

const X_LINK_RE = /\bhttps?:\/\/(?:mobile\.)?(?:x\.com|twitter\.com)\/[^\s<>"')\]]+/gi;
const TRAILING_PUNCTUATION_RE = /[),.\]]+$/;

function normalizeXUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim().replace(TRAILING_PUNCTUATION_RE, ""));
    const host = parsed.hostname.toLowerCase();
    if (!(host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com")) {
      return null;
    }
    if (host === "mobile.twitter.com") {
      parsed.hostname = "twitter.com";
    }
    parsed.hash = "";
    parsed.searchParams.delete("s");
    parsed.searchParams.delete("t");
    parsed.searchParams.delete("utm_source");
    parsed.searchParams.delete("utm_medium");
    parsed.searchParams.delete("utm_campaign");
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractXLinks(text: string, maxLinks: number): string[] {
  if (!text.trim()) {
    return [];
  }
  const seen = new Set<string>();
  const links: string[] = [];
  for (const match of text.matchAll(X_LINK_RE)) {
    const raw = match[0];
    if (!raw) {
      continue;
    }
    const normalized = normalizeXUrl(raw);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    links.push(normalized);
    if (links.length >= maxLinks) {
      break;
    }
  }
  return links;
}

function buildXCaseId(url: string): string {
  const statusMatch = url.match(/\/status\/(\d+)/);
  if (statusMatch?.[1]) {
    return `x-${statusMatch[1]}`;
  }
  return `x-${crypto.createHash("sha1").update(url).digest("hex").slice(0, 10)}`;
}

function parseXCaseCommand(text: string): XCaseCommand | null {
  const trimmed = text.trim();
  if (!/^\/xcase\b/i.test(trimmed)) {
    return null;
  }
  const parts = trimmed.split(/\s+/).slice(1);
  const op = parts[0]?.toLowerCase();
  if (!op || op === "help") {
    return { op: "help" };
  }
  if (op === "list") {
    const scope = parts[1]?.toLowerCase() === "all" ? "all" : "open";
    return { op: "list", scope };
  }
  const isCaseId = (value?: string) => Boolean(value && /^x-[a-z0-9]+$/i.test(value));
  if (op === "status") {
    return { op: "status", caseId: isCaseId(parts[1]) ? parts[1] : undefined };
  }
  if (op === "continue") {
    const args = parts.slice(1);
    const caseId = isCaseId(args[0]) ? args[0] : undefined;
    const noteStart = caseId ? 1 : 0;
    return {
      op: "continue",
      caseId,
      note: args.slice(noteStart).join(" ").trim() || undefined,
    };
  }
  if (op === "noaction") {
    const args = parts.slice(1);
    const caseId = isCaseId(args[0]) ? args[0] : undefined;
    const reasonStart = caseId ? 1 : 0;
    return {
      op: "noaction",
      caseId,
      reason: args.slice(reasonStart).join(" ").trim() || undefined,
    };
  }
  if (op === "close") {
    const args = parts.slice(1);
    const caseId = isCaseId(args[0]) ? args[0] : undefined;
    const reasonStart = caseId ? 1 : 0;
    return {
      op: "close",
      caseId,
      reason: args.slice(reasonStart).join(" ").trim() || undefined,
    };
  }
  if (op === "move") {
    const args = parts.slice(1);
    let index = 0;
    let caseId: string | undefined;
    let stream: string | undefined;
    if (args[index] && isCaseId(args[index])) {
      caseId = args[index];
      index += 1;
    }
    if (args[index]?.toLowerCase().startsWith("stream:")) {
      stream = args[index].slice("stream:".length).trim() || undefined;
      index += 1;
    }
    return {
      op: "move",
      caseId,
      stream,
      topic: args.slice(index).join(" ").trim() || undefined,
    };
  }
  return { op: "help" };
}

function normalizeTopicSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
}

function buildAnalysisTopic(caseId: string, url: string): string {
  const slug = normalizeTopicSegment(url.split("/").slice(-2).join("-")).slice(0, 30);
  return `x/${caseId}${slug ? `-${slug}` : ""}`;
}

function resolveXCaseTopicMode(xcase: ZulipXCaseConfig): "always" | "on_continue" | "never" {
  const explicit = (xcase as any)?.caseTopicMode as string | undefined;
  if (explicit === "always" || explicit === "on_continue" || explicit === "never") {
    return explicit;
  }
  if (xcase.perCaseTopic === false) {
    return "never";
  }
  return "always";
}

function normalizeRouteKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "");
}

function buildRouteTokenMatchers(
  xcase: ZulipXCaseConfig,
): Array<{ key: string; tokens: string[] }> {
  const routes = xcase.routes ?? {};
  const items: Array<{ key: string; tokens: string[] }> = [];
  for (const [rawKey, cfg] of Object.entries(routes)) {
    const key = normalizeRouteKey(rawKey);
    if (!key) {
      continue;
    }
    const tokens = new Set<string>([key]);
    for (const alias of cfg.aliases ?? []) {
      const t = normalizeRouteKey(alias);
      if (t) {
        tokens.add(t);
      }
    }
    items.push({ key, tokens: Array.from(tokens) });
  }
  return items;
}

function resolveRouteConfigByNormalizedKey(
  xcase: ZulipXCaseConfig,
  normalizedKey: string,
): { key: string; cfg: NonNullable<ZulipXCaseConfig["routes"]>[string] } | undefined {
  const key = normalizeRouteKey(normalizedKey);
  if (!key) {
    return undefined;
  }
  for (const [rawKey, cfg] of Object.entries(xcase.routes ?? {})) {
    if (normalizeRouteKey(rawKey) === key) {
      return { key, cfg };
    }
  }
  return undefined;
}

function resolveRouteKeyFromText(text: string, xcase: ZulipXCaseConfig): string | undefined {
  const matchers = buildRouteTokenMatchers(xcase);
  if (matchers.length === 0) {
    return undefined;
  }

  const raw = text.toLowerCase();
  for (const matcher of matchers) {
    for (const token of matcher.tokens) {
      // Explicit override forms:
      //   #exdi, @exdi, to:exdi, agent:exdi, route:exdi
      const explicitRe = new RegExp(`(^|\\s)([#@]|to:|agent:|route:)${escapeRegex(token)}\\b`, "i");
      if (explicitRe.test(raw)) {
        return matcher.key;
      }

      // Plain mention: exdi / artie / etc. (whole word)
      const plainRe = new RegExp(`\\b${escapeRegex(token)}\\b`, "i");
      if (plainRe.test(raw)) {
        return matcher.key;
      }
    }
  }

  const fallback = xcase.defaultRoute ? normalizeRouteKey(xcase.defaultRoute) : "";
  if (fallback && resolveRouteConfigByNormalizedKey(xcase, fallback)) {
    return fallback;
  }
  if (fallback) {
    return fallback;
  }
  return undefined;
}

function isInCommandPost(params: {
  xcase: ZulipXCaseConfig;
  stream: string;
  topic: string;
}): boolean {
  if (!params.xcase.commandPostStream) {
    return false;
  }
  if (params.stream !== params.xcase.commandPostStream) {
    return false;
  }
  const topic = params.xcase.commandPostTopic?.trim();
  return !topic || params.topic === topic;
}

function shouldAutoTriage(params: {
  xcase: ZulipXCaseConfig;
  inCommandPost: boolean;
  wasMentioned: boolean;
}): boolean {
  if (params.xcase.enabled !== true) {
    return false;
  }
  const mode = params.xcase.autoTriage ?? "command_post_only";
  if (mode === "off") {
    return false;
  }
  if (mode === "always") {
    return true;
  }
  if (mode === "mentioned") {
    return params.wasMentioned;
  }
  return params.inCommandPost;
}

function formatXCaseHelp(): string {
  return [
    "**XCase commands**",
    "`/xcase list [all]`",
    "`/xcase status <caseId?>`",
    "`/xcase continue <caseId?> [note...]`",
    "`/xcase move <caseId?> [stream:NAME] <new topic>`",
    "`/xcase close <caseId?> [reason...]` (alias: `/xcase noaction`)",
    "`/xcase noaction <caseId?> [reason...]`",
    "",
    "Notes:",
    "- If you're not in a dedicated per-case topic, include the `<caseId>` (e.g. `x-123...`).",
    "- You can route captures with `#exdi`, `@artie`, or by mentioning the route key in your message text.",
  ].join("\n");
}

function formatXCaseRecord(record: XCaseRecord): string {
  return [
    `**${record.id}** · ${record.status}`,
    record.url,
    `expert: ${record.expertAgentId ?? "auto-route"} · route: ${record.routeKey ?? "default"} · analysis: #${record.analysisStream} > ${record.analysisTopic}`,
    `updated: ${new Date(record.updatedAt).toISOString()}`,
  ].join("\n");
}

function loadXCaseStore(storeFilePath: string): Map<string, XCaseRecord> {
  try {
    if (!fs.existsSync(storeFilePath)) {
      return new Map();
    }
    const parsed = JSON.parse(fs.readFileSync(storeFilePath, "utf-8")) as
      | XCaseStore
      | { version: 1; cases: any[] };
    if (!parsed || !Array.isArray((parsed as any).cases)) {
      return new Map();
    }

    // v1 -> v2 migration (best-effort)
    if ((parsed as any).version === 1) {
      const migrated: XCaseRecord[] = (parsed as any).cases
        .map((r: any) => {
          const intakeStream = String(r.commandPostStream ?? "").trim();
          const intakeTopic = String(r.inboxTopic ?? "").trim();
          const analysisStream = intakeStream;
          const analysisTopic = String(r.analysisTopic ?? intakeTopic).trim();
          const dedicatedTopic = analysisTopic !== intakeTopic;
          if (!r?.id || !r?.url || !intakeStream || !intakeTopic || !analysisTopic) {
            return null;
          }
          const record: XCaseRecord = {
            id: String(r.id),
            url: String(r.url),
            status: (r.status as XCaseStatus) ?? "open",
            createdAt: Number(r.createdAt ?? Date.now()),
            updatedAt: Number(r.updatedAt ?? Date.now()),
            originMessageId: String(r.originMessageId ?? ""),
            originStream: String(r.originStream ?? ""),
            originTopic: String(r.originTopic ?? ""),
            originSenderId: Number(r.originSenderId ?? 0),
            originSenderEmail: String(r.originSenderEmail ?? ""),
            intakeStream,
            intakeTopic,
            analysisStream,
            analysisTopic,
            dedicatedTopic,
            routePeerId: String(r.routePeerId ?? ""),
            expertAgentId: r.expertAgentId ? String(r.expertAgentId) : undefined,
            lastError: r.lastError ? String(r.lastError) : undefined,
          };
          return record;
        })
        .filter(Boolean) as XCaseRecord[];
      return new Map(migrated.map((record) => [record.id, record]));
    }

    if ((parsed as any).version !== 2) {
      return new Map();
    }
    return new Map(((parsed as any).cases as XCaseRecord[]).map((record) => [record.id, record]));
  } catch {
    return new Map();
  }
}

function saveXCaseStore(storeFilePath: string, store: Map<string, XCaseRecord>) {
  try {
    const payload: XCaseStore = {
      version: 2,
      cases: Array.from(store.values()).toSorted((a, b) => b.updatedAt - a.updatedAt),
    };
    fs.writeFileSync(storeFilePath, JSON.stringify(payload, null, 2));
  } catch {
    // Non-fatal: xcase persistence is best effort.
  }
}

function chooseExpertAgentId(params: {
  config: ZulipXCaseConfig;
  caseId: string;
}): string | undefined {
  if (params.config.expertAgentId?.trim()) {
    return params.config.expertAgentId.trim();
  }
  const pool = (params.config.expertAgentIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (pool.length === 0) {
    return undefined;
  }
  const hash = crypto.createHash("md5").update(params.caseId).digest();
  const index = hash[0] % pool.length;
  return pool[index];
}

export async function monitorZulipProvider(opts: MonitorZulipOpts = {}): Promise<void> {
  const core = getZulipRuntime();
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveZulipAccount({ cfg, accountId: opts.accountId });

  const botEmail = opts.botEmail?.trim() || account.botEmail?.trim();
  const botApiKey = opts.botApiKey?.trim() || account.botApiKey?.trim();
  if (!botEmail || !botApiKey) {
    throw new Error(`Zulip bot credentials missing for account "${account.accountId}"`);
  }
  const baseUrl = normalizeZulipBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(`Zulip baseUrl missing for account "${account.accountId}"`);
  }

  // Handle self-signed certs
  const tlsReject = account.config.tlsRejectUnauthorized;
  if (tlsReject === false && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const client = createZulipClient({ baseUrl, botEmail, botApiKey });
  const botUser = await fetchZulipMe(client);
  const botUserId = botUser.user_id;
  const botName = botUser.full_name || botEmail;
  runtime.log?.(`zulip connected as ${botName} (id=${botUserId})`);

  const logger = core.logging.getChildLogger({ module: "zulip" });
  const logVerbose = (msg: string) => {
    if (core.logging.shouldLogVerbose()) {
      logger.debug?.(msg);
    }
  };

  const mediaMaxBytes =
    resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: () => undefined,
      accountId: account.accountId,
    }) ?? 8 * 1024 * 1024;

  const historyLimit = Math.max(
    0,
    cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const channelHistories = new Map<string, HistoryEntry[]>();
  const xcaseConfig = account.config.xcase;
  const xcaseStorePath = path.join(ZULIP_CACHE_DIR, `xcases-${account.accountId}.json`);
  const xcases = loadXCaseStore(xcaseStorePath);
  const xcaseByTopic = new Map<string, string>();
  const xcaseInFlight = new Set<string>();
  const topicKey = (stream: string, topic: string) => `${stream}:${topic}`;

  for (const record of xcases.values()) {
    if (record.dedicatedTopic) {
      xcaseByTopic.set(topicKey(record.analysisStream, record.analysisTopic), record.id);
    }
  }

  const persistXCases = () => saveXCaseStore(xcaseStorePath, xcases);
  const pruneXCases = () => {
    const maxCases = xcaseConfig?.maxOpenCases ?? 500;
    if (xcases.size <= maxCases) {
      return;
    }
    const records = Array.from(xcases.values()).toSorted((a, b) => b.updatedAt - a.updatedAt);
    for (const record of records.slice(maxCases)) {
      xcases.delete(record.id);
    }
    persistXCases();
  };

  // Stream ID cache for typing indicators
  const streamIdCache = new Map<string, { id: number; expiresAt: number }>();
  const resolveStreamId = async (name: string): Promise<number | undefined> => {
    const cached = streamIdCache.get(name);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.id;
    }
    try {
      const id = await getZulipStreamId(client, name);
      streamIdCache.set(name, { id, expiresAt: Date.now() + STREAM_ID_CACHE_TTL_MS });
      return id;
    } catch {
      return undefined;
    }
  };

  const sendTypingIndicator = async (msg: ZulipMessage) => {
    try {
      if (msg.type === "stream" && msg.stream_id) {
        await sendZulipTyping(client, { op: "start", streamId: msg.stream_id, topic: msg.subject });
      } else if (msg.type === "stream") {
        const sName = streamName(msg);
        const id = sName ? await resolveStreamId(sName) : undefined;
        if (id) {
          await sendZulipTyping(client, { op: "start", streamId: id, topic: msg.subject });
        }
      } else {
        await sendZulipTyping(client, { op: "start", to: [msg.sender_id] });
      }
    } catch (err) {
      logVerbose(`zulip typing failed: ${String(err)}`);
    }
  };

  const sendXCaseMessage = async (
    stream: string,
    topic: string,
    text: string,
    opts: { accountId?: string } = {},
  ) => {
    await sendMessageZulip(`stream:${stream}:topic:${topic}`, text, {
      accountId: opts.accountId ?? account.accountId,
    });
  };

  const renderXCaseCard = (record: XCaseRecord): string => {
    const routePart = record.routeKey ? ` · ${record.routeKey}` : "";
    const expert = record.expertAgentId ?? "auto-route";
    const analysisWhere = `#${record.analysisStream} > ${record.analysisTopic}`;
    const analysisLink = record.analysisFirstMessageId
      ? `${baseUrl}/#narrow/near/${record.analysisFirstMessageId}`
      : "";
    const errorLine = record.lastError ? `error: ${record.lastError}` : "";
    const chatLine = record.dedicatedTopic
      ? "chat: reply in the case topic"
      : `chat: /xcase continue ${record.id}`;
    return [
      `xcase ${record.id} · ${record.status}${routePart}`,
      record.url,
      `expert: ${expert}`,
      `analysis: ${analysisWhere}`,
      analysisLink,
      chatLine,
      errorLine,
    ]
      .filter(Boolean)
      .join("\n");
  };

  const upsertXCaseCard = async (record: XCaseRecord) => {
    const cardText = renderXCaseCard(record);
    const sendNew = async () => {
      const res = await sendMessageZulip(
        `stream:${record.intakeStream}:topic:${record.intakeTopic}`,
        cardText,
        { accountId: account.accountId },
      );
      record.cardMessageId = res.messageId;
      record.updatedAt = Date.now();
      persistXCases();
    };

    const messageId = record.cardMessageId ? Number(record.cardMessageId) : NaN;
    if (!Number.isFinite(messageId) || messageId <= 0) {
      await sendNew();
      return;
    }

    try {
      await updateZulipMessage(client, { messageId, content: cardText });
    } catch (err) {
      logVerbose(`zulip xcase: card update failed, posting new card: ${String(err)}`);
      await sendNew();
    }
  };

  const runXCaseAnalysis = async (params: {
    record: XCaseRecord;
    sourceText: string;
    senderName: string;
    senderId: number;
    note?: string;
    kind?: "initial" | "followup";
  }) => {
    if (xcaseInFlight.has(params.record.id)) {
      await upsertXCaseCard(params.record);
      return;
    }

    xcaseInFlight.add(params.record.id);
    params.record.status = "in_progress";
    params.record.updatedAt = Date.now();
    persistXCases();
    await upsertXCaseCard(params.record);

    try {
      const routePeerPrefix = xcaseConfig?.routePeerPrefix?.trim() || "xcase";
      params.record.routePeerId = `${routePeerPrefix}:${params.record.id}`;
      const expertRoute = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "zulip",
        accountId: account.accountId,
        peer: {
          kind: "channel",
          id: params.record.routePeerId,
        },
      });

      const expertAgentId = params.record.expertAgentId || expertRoute.agentId;
      const expertSessionKey = `agent:${expertAgentId}:zulip:xcase:${params.record.id}`;
      const targetTo = `stream:${params.record.analysisStream}:topic:${params.record.analysisTopic}`;
      const analysisText =
        params.kind === "followup"
          ? [
              `XCase ${params.record.id}`,
              `URL: ${params.record.url}`,
              params.note ? `Operator note: ${params.note}` : "",
              "Operator follow-up:",
              params.sourceText,
              "",
              "Respond to the follow-up in context of this case. Be concise and concrete.",
            ]
              .filter(Boolean)
              .join("\n")
          : [
              `XCase ${params.record.id}`,
              `URL: ${params.record.url}`,
              params.note ? `Operator note: ${params.note}` : "",
              "Please analyze this link for applicability to our team.",
              "Respond with concise sections:",
              "1) Summary",
              "2) Relevance to us",
              "3) Risks or opportunities",
              "4) Recommended action",
              "",
              "Source context:",
              params.sourceText,
            ]
              .filter(Boolean)
              .join("\n");
      const inboundBody = core.channel.reply.formatInboundEnvelope({
        channel: "Zulip",
        from: `${params.senderName} (user)`,
        body: `${analysisText}\n[xcase id: ${params.record.id}]`,
        chatType: "channel",
        sender: { name: params.senderName, id: String(params.senderId) },
      });

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: inboundBody,
        RawBody: analysisText,
        CommandBody: analysisText,
        From: `zulip:xcase:${params.record.id}`,
        To: targetTo,
        SessionKey: expertSessionKey,
        AccountId: expertRoute.accountId,
        ChatType: "channel",
        ConversationLabel: `#${params.record.analysisStream} > ${params.record.analysisTopic}`,
        GroupSubject: `${params.record.analysisStream} > ${params.record.analysisTopic}`,
        GroupChannel: `#${params.record.analysisStream}`,
        SenderName: params.senderName,
        SenderId: String(params.senderId),
        Provider: "zulip" as const,
        Surface: "zulip" as const,
        MessageSid: `${params.record.id}:${Date.now()}`,
        WasMentioned: true,
        CommandAuthorized: true,
        OriginatingChannel: "zulip" as const,
        OriginatingTo: targetTo,
      });

      const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "zulip", account.accountId, {
        fallbackLimit: account.textChunkLimit ?? 10000,
      });
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "zulip",
        accountId: account.accountId,
      });
      const prefixContext = createReplyPrefixContext({ cfg, agentId: expertAgentId });
      const deliverAccountId = params.record.analysisPostAsAccountId ?? account.accountId;
      let firstMessageId: string | undefined;
      let lastMessageId: string | undefined;
      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          responsePrefix: prefixContext.responsePrefix,
          responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, expertAgentId),
          deliver: async (payload: ReplyPayload) => {
            const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
            const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
            if (mediaUrls.length === 0) {
              const chunkMode = core.channel.text.resolveChunkMode(cfg, "zulip", account.accountId);
              const chunks = core.channel.text.chunkMarkdownTextWithMode(
                text,
                textLimit,
                chunkMode,
              );
              for (const chunk of chunks.length > 0 ? chunks : [text]) {
                if (!chunk) {
                  continue;
                }
                const res = await sendMessageZulip(targetTo, chunk, {
                  accountId: deliverAccountId,
                });
                if (!firstMessageId) {
                  firstMessageId = res.messageId;
                }
                lastMessageId = res.messageId;
              }
            } else {
              let first = true;
              for (const mediaUrl of mediaUrls) {
                const caption = first ? text : "";
                first = false;
                const res = await sendMessageZulip(targetTo, caption, {
                  accountId: deliverAccountId,
                  mediaUrl,
                });
                if (!firstMessageId) {
                  firstMessageId = res.messageId;
                }
                lastMessageId = res.messageId;
              }
            }
          },
          onError: (err, info) => {
            runtime.error?.(`zulip xcase ${info.kind} reply failed: ${String(err)}`);
          },
        });

      await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          disableBlockStreaming:
            typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
          onModelSelected: prefixContext.onModelSelected,
        },
      });
      markDispatchIdle();

      params.record.status = "open";
      params.record.updatedAt = Date.now();
      params.record.lastError = undefined;
      if (firstMessageId) {
        params.record.analysisFirstMessageId = firstMessageId;
      }
      if (lastMessageId) {
        params.record.analysisLastMessageId = lastMessageId;
      }
      persistXCases();
      await upsertXCaseCard(params.record);
    } catch (err) {
      params.record.status = "error";
      params.record.lastError = String(err);
      params.record.updatedAt = Date.now();
      persistXCases();
      await upsertXCaseCard(params.record);
    } finally {
      xcaseInFlight.delete(params.record.id);
    }
  };

  const handleMessage = async (msg: ZulipMessage) => {
    const msgKey = `${account.accountId}:${msg.id}`;
    if (dedup(msgKey)) {
      return;
    }

    // Skip own messages
    if (msg.sender_id === botUserId) {
      return;
    }

    // Skip messages from other bots UNLESS this bot was explicitly @mentioned
    // (allows agent coordination when mentioned, prevents infinite loops otherwise)
    const isBotSender =
      msg.sender_email?.endsWith("-bot@macpro.tail63777e.ts.net") ||
      msg.sender_email?.endsWith("-bot-bot@macpro.tail63777e.ts.net") ||
      (msg as any).is_bot;
    const wasMentionedByBot =
      isBotSender &&
      (msg.flags?.includes("mentioned") ||
        msg.flags?.includes("wildcard_mentioned") ||
        (msg.content ?? "")
          .toLowerCase()
          .includes(`@**${botUser.full_name?.toLowerCase() ?? ""}**`));
    if (isBotSender && !wasMentionedByBot) {
      logVerbose(`zulip: skip bot message from ${msg.sender_email} (not mentioned)`);
      return;
    }

    const kind = messageKind(msg);
    const cType = chatType(kind);

    const senderEmail = msg.sender_email;
    const senderName = msg.sender_full_name || senderEmail;
    const senderId = msg.sender_id;

    // Access control
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const groupPolicy =
      account.config.groupPolicy ?? cfg.channels?.defaults?.groupPolicy ?? "allowlist";
    const configAllowFrom = normalizeAllowList(account.config.allowFrom ?? []);
    const configGroupAllowFrom = normalizeAllowList(account.config.groupAllowFrom ?? []);
    const storeAllowFrom = normalizeAllowList(
      await core.channel.pairing.readAllowFromStore("zulip").catch(() => []),
    );
    const effectiveAllowFrom = Array.from(new Set([...configAllowFrom, ...storeAllowFrom]));
    const effectiveGroupAllowFrom = Array.from(
      new Set([
        ...(configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom),
        ...storeAllowFrom,
      ]),
    );

    const senderAllowed = isSenderAllowed({ senderEmail, senderId, allowFrom: effectiveAllowFrom });
    const groupSenderAllowed = isSenderAllowed({
      senderEmail,
      senderId,
      allowFrom: effectiveGroupAllowFrom,
    });

    const rawText = msg.content?.trim() ?? "";
    const botMentionRegex = new RegExp(`@\\*\\*${escapeRegex(botName)}\\*\\*`, "gi");
    const cleanText = rawText.replace(botMentionRegex, "").replace(/\s+/g, " ").trim();
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "zulip",
    });
    const hasControlCommand = core.channel.text.hasControlCommand(rawText, cfg);
    const hasXCaseCommandSyntax = /^\/xcase\b/i.test(cleanText);
    const isControlCommand = allowTextCommands && (hasControlCommand || hasXCaseCommandSyntax);
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: effectiveAllowFrom.length > 0, allowed: senderAllowed },
        { configured: effectiveGroupAllowFrom.length > 0, allowed: groupSenderAllowed },
      ],
      allowTextCommands,
      hasControlCommand: hasControlCommand || hasXCaseCommandSyntax,
    });
    const commandAuthorized =
      kind === "dm" ? dmPolicy === "open" || senderAllowed : commandGate.commandAuthorized;

    // DM gating
    if (kind === "dm") {
      if (dmPolicy === "disabled") {
        logVerbose(`zulip: drop dm (disabled) sender=${senderEmail}`);
        return;
      }
      if (dmPolicy !== "open" && !senderAllowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "zulip",
            id: String(senderId),
            meta: { name: senderName, email: senderEmail },
          });
          if (created) {
            try {
              await sendMessageZulip(
                `dm:${senderId}`,
                core.channel.pairing.buildPairingReply({
                  channel: "zulip",
                  idLine: `Your Zulip user id: ${senderId} (${senderEmail})`,
                  code,
                }),
                { accountId: account.accountId },
              );
            } catch (err) {
              logVerbose(`zulip: pairing reply failed: ${String(err)}`);
            }
          }
        }
        return;
      }
    } else {
      // Stream gating
      if (groupPolicy === "disabled") {
        return;
      }
      if (groupPolicy === "allowlist") {
        if (effectiveGroupAllowFrom.length === 0) {
          return;
        }
        if (!groupSenderAllowed) {
          return;
        }
      }
    }

    if (kind !== "dm" && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerbose,
        channel: "zulip",
        reason: "control command (unauthorized)",
        target: String(senderId),
      });
      return;
    }

    // Mention detection
    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, undefined);
    const wasMentioned =
      kind !== "dm" &&
      (msg.flags?.includes("mentioned") ||
        msg.flags?.includes("wildcard_mentioned") ||
        rawText.toLowerCase().includes(`@**${botName.toLowerCase()}**`) ||
        core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));

    const sName = streamName(msg);
    const topic = msg.subject || "(no topic)";

    // Session key: stream + topic = thread
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
      peer: {
        kind: kind === "dm" ? "direct" : "channel",
        id: kind === "dm" ? String(senderId) : `${sName}:${topic}`,
      },
    });

    const sessionKey = kind === "dm" ? route.sessionKey : `${route.sessionKey}:topic:${topic}`;
    const historyKey = kind === "dm" ? null : sessionKey;
    const sessionCfg = cfg.session;
    const storePath = core.channel.session.resolveStorePath(sessionCfg?.store, {
      agentId: route.agentId,
    });

    // Check stream-level requireMention override (like Discord's per-channel config)
    const streamConfig =
      kind !== "dm" && sName ? (account.config as any)?.streams?.[sName] : undefined;
    const shouldRequireMention =
      kind !== "dm" &&
      (streamConfig?.requireMention !== undefined
        ? streamConfig.requireMention !== false
        : account.requireMention !== false);

    // Record pending history for non-triggered messages
    const recordPendingHistory = () => {
      const trimmed = rawText.trim();
      recordPendingHistoryEntryIfEnabled({
        historyMap: channelHistories,
        limit: historyLimit,
        historyKey: historyKey ?? "",
        entry:
          historyKey && trimmed
            ? {
                sender: senderName,
                body: trimmed,
                timestamp: msg.timestamp ? msg.timestamp * 1000 : undefined,
                messageId: String(msg.id),
              }
            : null,
      });
    };

    const shouldBypassMention =
      isControlCommand && shouldRequireMention && !wasMentioned && commandAuthorized;
    const effectiveWasMentioned = wasMentioned || shouldBypassMention;

    const isDedicatedXCaseTopic =
      kind !== "dm" && sName ? xcaseByTopic.has(topicKey(sName, topic)) : false;

    // Special-case: allow xcase auto-triage intake + dedicated xcase topics to work without @mention.
    const shouldBypassMentionForXCase =
      kind !== "dm" &&
      shouldRequireMention &&
      !effectiveWasMentioned &&
      Boolean(xcaseConfig?.enabled) &&
      (isDedicatedXCaseTopic ||
        Boolean(
          xcaseConfig &&
          shouldAutoTriage({
            xcase: xcaseConfig,
            inCommandPost: isInCommandPost({ xcase: xcaseConfig, stream: sName, topic }),
            wasMentioned: false,
          }) &&
          extractXLinks(cleanText, xcaseConfig.maxLinksPerMessage ?? 3).length > 0,
        ));

    if (
      kind !== "dm" &&
      shouldRequireMention &&
      !effectiveWasMentioned &&
      !shouldBypassMentionForXCase
    ) {
      recordPendingHistory();
      return;
    }

    if (!cleanText) {
      return;
    }

    const xcaseCommand = parseXCaseCommand(cleanText);
    if (xcaseCommand) {
      if (!allowTextCommands) {
        logVerbose("zulip xcase: text commands disabled, ignoring command");
        return;
      }
      const commandTo = buildReplyTo(msg);
      if (!xcaseConfig?.enabled) {
        await sendMessageZulip(
          commandTo,
          "xcase is disabled for this account. Enable channels.zulip.xcase.enabled first.",
          { accountId: account.accountId },
        );
        return;
      }
      const resolveCaseId = (requested?: string): string | undefined => {
        const normalizedRequested = requested?.trim();
        if (normalizedRequested && xcases.has(normalizedRequested)) {
          return normalizedRequested;
        }
        const caseFromTopic =
          kind !== "dm" && sName ? xcaseByTopic.get(topicKey(sName, topic)) : undefined;
        if (caseFromTopic) {
          return caseFromTopic;
        }
        const links = extractXLinks(cleanText, 1);
        if (links.length === 1) {
          const inferred = buildXCaseId(links[0]);
          if (xcases.has(inferred)) {
            return inferred;
          }
        }
        return normalizedRequested;
      };
      const loadCase = (requested?: string): XCaseRecord | null => {
        const resolvedId = resolveCaseId(requested);
        if (!resolvedId) {
          return null;
        }
        return xcases.get(resolvedId) ?? null;
      };

      switch (xcaseCommand.op) {
        case "help":
          await sendMessageZulip(commandTo, formatXCaseHelp(), { accountId: account.accountId });
          return;
        case "list": {
          const all = Array.from(xcases.values()).toSorted((a, b) => b.updatedAt - a.updatedAt);
          const items =
            xcaseCommand.scope === "all" ? all : all.filter((record) => record.status === "open");
          if (items.length === 0) {
            await sendMessageZulip(
              commandTo,
              `xcase list (${xcaseCommand.scope}): no cases found.`,
              { accountId: account.accountId },
            );
            return;
          }
          const lines = items
            .slice(0, 20)
            .map(
              (record) =>
                `- ${record.id} · ${record.status} · ${record.routeKey ?? "default"} · #${record.analysisStream} > ${record.analysisTopic}`,
            );
          await sendMessageZulip(
            commandTo,
            [`xcase list (${xcaseCommand.scope}):`, ...lines].join("\n"),
            {
              accountId: account.accountId,
            },
          );
          return;
        }
        case "status": {
          const record = loadCase(xcaseCommand.caseId);
          if (!record) {
            await sendMessageZulip(commandTo, "xcase status: case not found.", {
              accountId: account.accountId,
            });
            return;
          }
          await sendMessageZulip(commandTo, formatXCaseRecord(record), {
            accountId: account.accountId,
          });
          return;
        }
        case "noaction": {
          const record = loadCase(xcaseCommand.caseId);
          if (!record) {
            await sendMessageZulip(commandTo, "xcase noaction: case not found.", {
              accountId: account.accountId,
            });
            return;
          }
          record.status = "noaction";
          record.updatedAt = Date.now();
          persistXCases();
          if (xcaseCommand.reason) {
            record.lastError = `closed: ${xcaseCommand.reason}`;
          } else {
            record.lastError = undefined;
          }
          await upsertXCaseCard(record);
          await sendMessageZulip(commandTo, `xcase ${record.id}: closed (no-action).`, {
            accountId: account.accountId,
          });
          return;
        }
        case "close": {
          const record = loadCase(xcaseCommand.caseId);
          if (!record) {
            await sendMessageZulip(commandTo, "xcase close: case not found.", {
              accountId: account.accountId,
            });
            return;
          }
          record.status = "noaction";
          record.updatedAt = Date.now();
          persistXCases();
          if (xcaseCommand.reason) {
            record.lastError = `closed: ${xcaseCommand.reason}`;
          } else {
            record.lastError = undefined;
          }
          await upsertXCaseCard(record);
          await sendMessageZulip(commandTo, `xcase ${record.id}: closed.`, {
            accountId: account.accountId,
          });
          return;
        }
        case "move": {
          const record = loadCase(xcaseCommand.caseId);
          if (!record) {
            await sendMessageZulip(commandTo, "xcase move: case not found.", {
              accountId: account.accountId,
            });
            return;
          }
          if (!xcaseCommand.topic) {
            await sendMessageZulip(commandTo, "xcase move: target topic is required.", {
              accountId: account.accountId,
            });
            return;
          }
          if (record.dedicatedTopic) {
            xcaseByTopic.delete(topicKey(record.analysisStream, record.analysisTopic));
          }
          if (xcaseCommand.stream?.trim()) {
            record.analysisStream = xcaseCommand.stream.trim();
          }
          record.analysisTopic = xcaseCommand.topic.trim();
          record.status = "moved";
          record.updatedAt = Date.now();
          record.dedicatedTopic = true;
          xcaseByTopic.set(topicKey(record.analysisStream, record.analysisTopic), record.id);
          persistXCases();
          await sendXCaseMessage(
            record.analysisStream,
            record.analysisTopic,
            [
              `xcase ${record.id} moved here.`,
              record.url,
              "Use `/xcase continue` in this topic for follow-up analysis.",
            ].join("\n"),
            { accountId: record.analysisPostAsAccountId },
          );
          await upsertXCaseCard(record);
          await sendMessageZulip(
            commandTo,
            `xcase ${record.id}: moved to #${record.analysisStream} > ${record.analysisTopic}`,
            { accountId: account.accountId },
          );
          return;
        }
        case "continue": {
          const record = loadCase(xcaseCommand.caseId);
          if (!record) {
            await sendMessageZulip(commandTo, "xcase continue: case not found.", {
              accountId: account.accountId,
            });
            return;
          }
          const topicMode = xcaseConfig ? resolveXCaseTopicMode(xcaseConfig) : "always";
          if (topicMode === "on_continue" && !record.dedicatedTopic) {
            const newTopic = buildAnalysisTopic(record.id, record.url);
            record.analysisTopic = newTopic;
            record.dedicatedTopic = true;
            record.updatedAt = Date.now();
            xcaseByTopic.set(topicKey(record.analysisStream, record.analysisTopic), record.id);
            persistXCases();
            await sendXCaseMessage(
              record.analysisStream,
              record.analysisTopic,
              [`xcase ${record.id} thread opened here.`, record.url].join("\n"),
              { accountId: record.analysisPostAsAccountId },
            );
          }
          await sendMessageZulip(
            commandTo,
            `xcase ${record.id}: running follow-up analysis in #${record.analysisStream} > ${record.analysisTopic}`,
            { accountId: account.accountId },
          );
          await runXCaseAnalysis({
            record,
            sourceText: cleanText,
            senderName,
            senderId,
            note: xcaseCommand.note,
            kind: "followup",
          });
          return;
        }
      }
    }

    // Ack reaction: immediately show the bot is processing this message
    const ackReaction = resolveAckReaction(cfg, route.agentId);
    const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
    const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
    const shouldAck = Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ackReactionScope,
        isDirect: kind === "dm",
        isGroup: kind !== "dm",
        isMentionableGroup: kind !== "dm",
        requireMention: Boolean(shouldRequireMention),
        canDetectMention: true,
        effectiveWasMentioned,
        shouldBypassMention,
      }),
    );
    const ackEmojiName = ackReaction ? emojiToZulipName(ackReaction) : "eyes";
    const ackReactionPromise = shouldAck
      ? addZulipReaction(client, { messageId: msg.id, emojiName: ackEmojiName }).then(
          () => true,
          (err) => {
            logVerbose(`zulip ack react failed for message ${msg.id}: ${String(err)}`);
            return false;
          },
        )
      : null;

    // Download any Zulip uploads (images, files) and get local paths
    const { attachmentInfo, strippedContent } = await processZulipUploads(
      client,
      rawText,
      mediaMaxBytes,
    );
    // Apply the same bot-mention stripping to the stripped content (upload URLs removed)
    const cleanStripped = strippedContent.replace(botMentionRegex, "").replace(/\s+/g, " ").trim();
    const textWithAttachments = attachmentInfo ? `${cleanStripped}${attachmentInfo}` : cleanText;

    // Dedicated xcase topics behave like real threads: any message is treated as a follow-up turn.
    if (kind !== "dm" && sName && isDedicatedXCaseTopic && xcaseConfig?.enabled) {
      const caseId = xcaseByTopic.get(topicKey(sName, topic));
      const record = caseId ? xcases.get(caseId) : undefined;
      if (record && record.status !== "noaction") {
        const sourceText =
          xcaseConfig.includeMessageContext === false
            ? cleanText
            : `${textWithAttachments}\n[zulip message id: ${msg.id}]`;
        await runXCaseAnalysis({
          record,
          sourceText,
          senderName,
          senderId,
          kind: "followup",
        });

        if (removeAckAfterReply && ackReactionPromise) {
          ackReactionPromise.then((didAck) => {
            if (!didAck) {
              return;
            }
            removeZulipReaction(client, { messageId: msg.id, emojiName: ackEmojiName }).catch(
              (err) => {
                logVerbose(`zulip remove ack react failed: ${String(err)}`);
              },
            );
          });
        }
        return;
      }
    }

    const inCommandPost =
      kind !== "dm" &&
      Boolean(
        xcaseConfig &&
        isInCommandPost({
          xcase: xcaseConfig,
          stream: sName,
          topic,
        }),
      );
    const autoTriageEnabled =
      kind !== "dm" &&
      Boolean(
        xcaseConfig &&
        shouldAutoTriage({
          xcase: xcaseConfig,
          inCommandPost,
          wasMentioned: effectiveWasMentioned,
        }),
      );
    const xLinks =
      autoTriageEnabled && xcaseConfig
        ? extractXLinks(textWithAttachments, xcaseConfig.maxLinksPerMessage ?? 3)
        : [];
    if (autoTriageEnabled && xcaseConfig && xLinks.length > 0) {
      const intakeStream = xcaseConfig.commandPostStream?.trim();
      const intakeTopic = xcaseConfig.commandPostTopic?.trim() || "command-post";
      if (!intakeStream) {
        logVerbose("zulip xcase: commandPostStream missing, skipping auto-triage");
      } else {
        const topicMode = resolveXCaseTopicMode(xcaseConfig);
        const routeKeyRaw = resolveRouteKeyFromText(textWithAttachments, xcaseConfig);
        const fallbackKey = normalizeRouteKey(xcaseConfig.defaultRoute ?? "default") || "default";
        const routeKeyCandidate = routeKeyRaw ? normalizeRouteKey(routeKeyRaw) : fallbackKey;
        const resolvedRoute = resolveRouteConfigByNormalizedKey(xcaseConfig, routeKeyCandidate);
        const routeKey = resolvedRoute?.key ?? routeKeyCandidate;
        const routeCfg = resolvedRoute?.cfg;

        const analysisStreamDefault = routeCfg?.analysisStream?.trim() || intakeStream;
        const analysisTopicSharedDefault =
          routeCfg?.analysisTopic?.trim() || (routeKey ? `x/${routeKey}` : "x/inbox");
        const expertAgentDefault =
          routeCfg?.expertAgentId?.trim() ||
          (xcaseConfig.expertAgentId?.trim() ? xcaseConfig.expertAgentId.trim() : undefined);
        const analysisPostAsAccountIdDefault = routeCfg?.postAsAccountId?.trim() || undefined;

        for (const url of xLinks) {
          const caseId = buildXCaseId(url);
          let record = xcases.get(caseId);

          if (!record) {
            const dedicatedTopic = topicMode === "always";
            const analysisTopic = dedicatedTopic
              ? buildAnalysisTopic(caseId, url)
              : analysisTopicSharedDefault;
            const expertAgentId =
              expertAgentDefault ?? chooseExpertAgentId({ config: xcaseConfig, caseId });

            record = {
              id: caseId,
              url,
              status: "open",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              originMessageId: String(msg.id),
              originStream: sName,
              originTopic: topic,
              originSenderId: senderId,
              originSenderEmail: senderEmail,
              intakeStream,
              intakeTopic,
              analysisStream: analysisStreamDefault,
              analysisTopic,
              dedicatedTopic,
              routePeerId: `${xcaseConfig.routePeerPrefix?.trim() || "xcase"}:${caseId}`,
              expertAgentId,
              routeKey,
              analysisPostAsAccountId: analysisPostAsAccountIdDefault,
            };

            xcases.set(caseId, record);
            if (record.dedicatedTopic) {
              xcaseByTopic.set(topicKey(record.analysisStream, record.analysisTopic), caseId);
            }
            pruneXCases();
            persistXCases();
            await upsertXCaseCard(record);
          } else {
            // Refresh record metadata (non-destructive)
            record.updatedAt = Date.now();
            record.intakeStream = record.intakeStream || intakeStream;
            record.intakeTopic = record.intakeTopic || intakeTopic;
            if (!record.routeKey) {
              record.routeKey = routeKey ?? xcaseConfig.defaultRoute ?? "default";
            }
            if (!record.analysisPostAsAccountId && analysisPostAsAccountIdDefault) {
              record.analysisPostAsAccountId = analysisPostAsAccountIdDefault;
            }
            persistXCases();
            await upsertXCaseCard(record);
          }

          if (xcaseConfig.autoAnalyzeOnCapture !== false) {
            const sourceText =
              xcaseConfig.includeMessageContext === false
                ? `URL: ${url}`
                : `${textWithAttachments}\n[zulip message id: ${msg.id}]`;
            await runXCaseAnalysis({
              record,
              sourceText,
              senderName,
              senderId,
              kind: "initial",
            });
          }
        }
      }

      if (removeAckAfterReply && ackReactionPromise) {
        ackReactionPromise.then((didAck) => {
          if (!didAck) {
            return;
          }
          removeZulipReaction(client, { messageId: msg.id, emojiName: ackEmojiName }).catch(
            (err) => {
              logVerbose(`zulip remove ack react failed: ${String(err)}`);
            },
          );
        });
      }
      return;
    }

    core.channel.activity.record({
      channel: "zulip",
      accountId: account.accountId,
      direction: "inbound",
    });

    const roomLabel = kind === "dm" ? senderName : `#${sName} > ${topic}`;
    const fromLabel = kind === "dm" ? senderName : `${roomLabel} (${senderName})`;

    const preview = cleanText.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel =
      kind === "dm"
        ? `Zulip DM from ${senderName}`
        : `Zulip message in #${sName} > ${topic} from ${senderName}`;
    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey,
      contextKey: `zulip:message:${msg.id}`,
    });

    const to = buildReplyTo(msg);
    const textWithId = `${textWithAttachments}\n[zulip message id: ${msg.id}]`;
    const topicInitialHistoryLimit = account.config.topic?.initialHistoryLimit ?? 20;
    const topicSessionPreviousTimestamp =
      kind !== "dm" && sName
        ? core.channel.session.readSessionUpdatedAt({
            storePath,
            sessionKey,
          })
        : undefined;
    const { threadHistoryBody, threadLabel, isFirstTopicTurn } = await resolveZulipTopicContext({
      client,
      kind,
      streamName: sName,
      topic,
      currentMessageId: msg.id,
      botUserId,
      initialHistoryLimit: topicInitialHistoryLimit,
      sessionPreviousTimestamp: topicSessionPreviousTimestamp,
      formatInboundEnvelope: core.channel.reply.formatInboundEnvelope,
      logVerbose,
    });
    const body = core.channel.reply.formatInboundEnvelope({
      channel: "Zulip",
      from: fromLabel,
      timestamp: msg.timestamp ? msg.timestamp * 1000 : undefined,
      body: textWithId,
      chatType: cType,
      sender: { name: senderName, id: String(senderId) },
    });

    let combinedBody = body;
    if (historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatInboundEnvelope({
            channel: "Zulip",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
            chatType: cType,
            senderLabel: entry.sender,
          }),
      });
    }

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      RawBody: cleanText,
      CommandBody: cleanText,
      From: kind === "dm" ? `zulip:${senderId}` : `zulip:stream:${sName}:topic:${topic}`,
      To: to,
      SessionKey: sessionKey,
      AccountId: route.accountId,
      ChatType: cType,
      ConversationLabel: fromLabel,
      GroupSubject: kind !== "dm" ? `${sName} > ${topic}` : undefined,
      GroupChannel: kind !== "dm" ? `#${sName}` : undefined,
      SenderName: senderName,
      SenderId: String(senderId),
      Provider: "zulip" as const,
      Surface: "zulip" as const,
      MessageSid: String(msg.id),
      WasMentioned: kind !== "dm" ? effectiveWasMentioned : undefined,
      ThreadHistoryBody: threadHistoryBody,
      IsFirstThreadTurn: isFirstTopicTurn ? true : undefined,
      ThreadLabel: threadLabel,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "zulip" as const,
      OriginatingTo: to,
    });

    if (kind === "dm") {
      await core.channel.session.updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        deliveryContext: { channel: "zulip", to, accountId: route.accountId },
      });
    }

    const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "zulip", account.accountId, {
      fallbackLimit: account.textChunkLimit ?? 10000,
    });
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
    });
    const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });

    const typingCallbacks = createTypingCallbacks({
      start: () => sendTypingIndicator(msg),
      onStartError: (err) => {
        logTypingFailure({
          log: (m) => logger.debug?.(m),
          channel: "zulip",
          target: to,
          error: err,
        });
      },
    });

    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        responsePrefix: prefixContext.responsePrefix,
        responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        deliver: async (payload: ReplyPayload) => {
          const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);

          if (mediaUrls.length === 0) {
            const chunkMode = core.channel.text.resolveChunkMode(cfg, "zulip", account.accountId);
            const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
            for (const chunk of chunks.length > 0 ? chunks : [text]) {
              if (!chunk) {
                continue;
              }
              await sendMessageZulip(to, chunk, { accountId: account.accountId });
            }
          } else {
            let first = true;
            for (const mediaUrl of mediaUrls) {
              const caption = first ? text : "";
              first = false;
              await sendMessageZulip(to, caption, { accountId: account.accountId, mediaUrl });
            }
          }
          runtime.log?.(`delivered reply to ${to}`);
        },
        onError: (err, info) => {
          runtime.error?.(`zulip ${info.kind} reply failed: ${String(err)}`);
        },
        onReplyStart: typingCallbacks.onReplyStart,
      });

    await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        disableBlockStreaming:
          typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
        onModelSelected: prefixContext.onModelSelected,
      },
    });
    markDispatchIdle();

    // Log message to Convex activity feed (fire-and-forget)
    const convexHttpUrl = process.env.CONVEX_HTTP_URL;
    if (convexHttpUrl) {
      fetch(`${convexHttpUrl}/api/activity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "zulip_message",
          agentId: route.agentId,
          summary: cleanText.slice(0, 200),
          details: {
            stream: sName || undefined,
            topic: kind !== "dm" ? topic : undefined,
            sender: senderName,
            senderId: String(senderId),
            isDm: kind === "dm",
            messageId: String(msg.id),
          },
          source: "zulip",
          timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
        }),
      }).catch((err) => {
        logVerbose(`convex activity log failed: ${String(err)}`);
      });
    }

    // Remove ack reaction after reply is sent
    if (removeAckAfterReply && ackReactionPromise) {
      ackReactionPromise.then((didAck) => {
        if (!didAck) {
          return;
        }
        removeZulipReaction(client, { messageId: msg.id, emojiName: ackEmojiName }).catch((err) => {
          logVerbose(`zulip remove ack react failed: ${String(err)}`);
        });
      });
    }

    if (historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
      });
    }
  };

  // Track last processed message timestamp for replay on reconnect.
  // Persisted to disk so restarts can replay the full gap instead of losing history.
  const TIMESTAMP_FILE = path.join(ZULIP_UPLOAD_CACHE_DIR, `last-ts-${account.accountId}.json`);
  const MAX_REPLAY_MESSAGES = 100;
  const MAX_REPLAY_AGE_SECONDS = 1800; // 30 minutes

  const loadLastTimestamp = (): number => {
    try {
      if (fs.existsSync(TIMESTAMP_FILE)) {
        const data = JSON.parse(fs.readFileSync(TIMESTAMP_FILE, "utf-8"));
        if (typeof data.timestamp === "number" && data.timestamp > 0) {
          return data.timestamp;
        }
      }
    } catch {
      // Ignore read errors — replay window fallback will handle this safely.
    }
    return 0;
  };

  const saveLastTimestamp = (ts: number) => {
    try {
      fs.writeFileSync(TIMESTAMP_FILE, JSON.stringify({ timestamp: ts }));
    } catch {
      // Non-fatal — worst case we replay some extra messages
    }
  };

  let lastProcessedTimestamp = loadLastTimestamp();

  // Replay missed messages on reconnect
  const replayMissedMessages = async (): Promise<void> => {
    try {
      const cutoffTimestamp = Math.max(
        lastProcessedTimestamp,
        Math.floor(Date.now() / 1000) - MAX_REPLAY_AGE_SECONDS,
      );

      // Fetch recent messages from all public streams
      const messages = await fetchZulipMessages(client, {
        anchor: "newest",
        numBefore: MAX_REPLAY_MESSAGES,
        numAfter: 0,
        // Empty narrow = all messages the bot can see
      });

      // Filter to messages newer than cutoff, excluding bot's own messages
      const missed = messages.filter(
        (m) => m.timestamp > cutoffTimestamp && m.sender_id !== botUserId,
      );

      if (missed.length === 0) {
        logVerbose?.(`zulip: no missed messages to replay (cutoff=${cutoffTimestamp})`);
        return;
      }

      // Sort oldest first for proper ordering
      missed.sort((a, b) => a.timestamp - b.timestamp);

      runtime.log?.(`zulip: replaying ${missed.length} missed messages`);

      for (const msg of missed) {
        // Update timestamp immediately, then fire-and-forget the handler
        lastProcessedTimestamp = Math.max(lastProcessedTimestamp, msg.timestamp);
        saveLastTimestamp(lastProcessedTimestamp);
        void handleMessage(msg).catch((err) => {
          runtime.error?.(`zulip: replay handler failed: ${String(err)}`);
        });
      }
    } catch (err) {
      // Don't fail the whole reconnect if replay fails
      runtime.error?.(`zulip: message replay failed (non-fatal): ${String(err)}`);
    }
  };

  // Main event loop with reconnection
  const pollLoop = async (): Promise<void> => {
    while (!opts.abortSignal?.aborted) {
      let queueId: string;
      let lastEventId: number;

      try {
        const reg = await registerZulipQueue(client);
        queueId = reg.queue_id;
        lastEventId = reg.last_event_id;
        opts.statusSink?.({ connected: true, lastConnectedAt: Date.now(), lastError: null });
        runtime.log?.(`zulip event queue registered: ${queueId}`);

        // Replay any missed messages from the disconnection window
        await replayMissedMessages();
      } catch (err) {
        opts.statusSink?.({ lastError: String(err) });
        runtime.error?.(`zulip queue registration failed: ${String(err)}`);
        await sleep(5000, opts.abortSignal);
        continue;
      }

      // Poll events from this queue
      while (!opts.abortSignal?.aborted) {
        try {
          const res = await getZulipEvents(client, queueId, lastEventId, opts.abortSignal);
          if (!res.events || res.events.length === 0) {
            continue;
          }

          for (const event of res.events) {
            lastEventId = Math.max(lastEventId, event.id);
            if (event.type === "message" && event.message) {
              // Update timestamp immediately so the poll loop isn't blocked
              if (event.message.timestamp) {
                lastProcessedTimestamp = Math.max(lastProcessedTimestamp, event.message.timestamp);
                saveLastTimestamp(lastProcessedTimestamp);
              }
              // Fire-and-forget: don't block the poll loop on message handling.
              // The lane system handles concurrency; blocking here causes the
              // entire event loop to freeze if one handler stalls (e.g. compaction).
              void handleMessage(event.message).catch((err) => {
                runtime.error?.(`zulip handler failed: ${String(err)}`);
              });
            }
          }
        } catch (err) {
          const errStr = String(err);
          const errLower = errStr.toLowerCase();
          // Bad event queue ID means we need to re-register
          if (
            errLower.includes("bad_event_queue_id") ||
            errLower.includes("bad event queue") ||
            errLower.includes("queue_id")
          ) {
            runtime.log?.("zulip event queue expired, re-registering...");
            break;
          }
          if (opts.abortSignal?.aborted) {
            return;
          }
          opts.statusSink?.({
            connected: false,
            lastDisconnect: { at: Date.now(), error: errStr },
            lastError: errStr,
          });
          runtime.error?.(`zulip poll error: ${errStr}`);
          await sleep(3000, opts.abortSignal);
          break; // re-register
        }
      }

      if (!opts.abortSignal?.aborted) {
        opts.statusSink?.({ connected: false, lastDisconnect: { at: Date.now() } });
        await sleep(2000, opts.abortSignal);
      }
    }
  };

  await pollLoop();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
