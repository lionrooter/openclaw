import { getZulipRuntime } from "../runtime.js";
import { resolveZulipAccount } from "./accounts.js";
import {
  createZulipClient,
  normalizeZulipBaseUrl,
  sendZulipDirectMessage,
  sendZulipStreamMessage,
  uploadZulipFile,
} from "./client.js";

export type ZulipSendOpts = {
  accountId?: string;
  mediaUrl?: string;
  replyToTopic?: string;
};

export type ZulipSendResult = {
  messageId: string;
  target: string;
};

type ZulipTarget =
  | { kind: "stream"; stream: string; topic: string }
  | { kind: "dm"; userIds: number[] };

const STREAM_NAME_CACHE_TTL_MS = 5 * 60 * 1000;
const streamNameCache = new Map<string, { names: string[]; expiresAt: number }>();

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function normalizeStreamName(raw: string): string {
  return raw.trim().replace(/^#\s*/, "").trim();
}

function canonicalizeStreamAlias(raw: string): string {
  let value = normalizeStreamName(raw).toLowerCase();
  value = value.replace(/^[^a-z0-9]+/i, "");
  value = value.replace(/^[0-9]+/, "");
  value = value.replace(/^[^a-z0-9]+/i, "");
  value = value.replace(/\s+/g, " ").trim();
  value = value.replace(/(?:\s|-)+loop$/i, "").trim();
  return value;
}

function resolveConfiguredStreamName(stream: string, streams?: Record<string, unknown>): string {
  const configuredNames = streams ? Object.keys(streams) : [];
  if (configuredNames.length === 0) {
    return stream;
  }

  const exact = configuredNames.find((name) => name.toLowerCase() === stream.toLowerCase());
  if (exact) {
    return exact;
  }

  const alias = canonicalizeStreamAlias(stream);
  if (!alias) {
    return stream;
  }

  const matches = configuredNames.filter((name) => canonicalizeStreamAlias(name) === alias);
  return matches.length === 1 ? (matches[0] ?? stream) : stream;
}

function buildStreamNameCacheKey(params: { baseUrl: string; botEmail: string }): string {
  return `${params.baseUrl}::${params.botEmail.toLowerCase()}`;
}

async function listAvailableStreamNames(params: {
  client: ReturnType<typeof createZulipClient>;
}): Promise<string[]> {
  const cacheKey = buildStreamNameCacheKey({
    baseUrl: params.client.baseUrl,
    botEmail: params.client.botEmail,
  });
  const cached = streamNameCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.names;
  }

  let response: { streams?: Array<{ name?: string }> } | null = null;
  try {
    response = await params.client.request<{ streams?: Array<{ name?: string }> }>("/streams");
  } catch {
    response = null;
  }
  const names = (response?.streams ?? [])
    .map((stream) => stream.name?.trim())
    .filter((name): name is string => Boolean(name));

  if (names.length === 0) {
    return [];
  }

  streamNameCache.set(cacheKey, {
    names,
    expiresAt: Date.now() + STREAM_NAME_CACHE_TTL_MS,
  });

  return names;
}

async function resolveStreamNameForSend(params: {
  stream: string;
  accountStreams?: Record<string, unknown>;
  client: ReturnType<typeof createZulipClient>;
}): Promise<string> {
  const normalizedInput = normalizeStreamName(params.stream);
  const resolvedFromConfig = resolveConfiguredStreamName(normalizedInput, params.accountStreams);
  if (resolvedFromConfig !== normalizedInput) {
    return resolvedFromConfig;
  }

  const liveNames = await listAvailableStreamNames({ client: params.client });
  if (liveNames.length === 0) {
    return resolvedFromConfig;
  }
  const liveMap: Record<string, true> = Object.fromEntries(
    liveNames.map((name) => [name, true] as const),
  );
  return resolveConfiguredStreamName(resolvedFromConfig, liveMap);
}

function parseLegacyStreamTopic(raw: string): { stream: string; topic: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed.includes(":")) {
    return undefined;
  }
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon < 1 || lastColon === trimmed.length - 1) {
    return undefined;
  }
  const stream = normalizeStreamName(trimmed.slice(0, lastColon));
  const topic = trimmed.slice(lastColon + 1).trim();
  if (!stream || !topic) {
    return undefined;
  }
  return { stream, topic };
}

/**
 * Parse a target string:
 * - "stream:general:topic:hello" → stream message
 * - "stream:general:hello" → stream message (legacy format)
 * - "dm:12345" or "dm:12345,67890" → direct message
 * - "zulip:stream:general:topic:hello" → stream message
 */
function parseZulipTarget(raw: string): ZulipTarget {
  const trimmed = raw.trim().replace(/^zulip:/i, "");
  if (!trimmed) {
    throw new Error("Recipient is required for Zulip sends");
  }

  if (trimmed.toLowerCase().startsWith("stream:")) {
    const rest = trimmed.slice("stream:".length);
    const topicIdx = rest.toLowerCase().indexOf(":topic:");
    if (topicIdx < 0) {
      const legacy = parseLegacyStreamTopic(rest);
      if (!legacy) {
        throw new Error("Zulip stream target requires :topic: separator (stream:NAME:topic:TOPIC)");
      }
      return { kind: "stream", ...legacy };
    }
    const stream = normalizeStreamName(rest.slice(0, topicIdx));
    const topic = rest.slice(topicIdx + ":topic:".length).trim();
    if (!stream || !topic) {
      throw new Error("Zulip stream and topic are required");
    }
    return { kind: "stream", stream, topic };
  }

  if (trimmed.toLowerCase().startsWith("dm:")) {
    const ids = trimmed
      .slice("dm:".length)
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
    if (ids.length === 0) {
      throw new Error("Zulip DM target requires user IDs");
    }
    return { kind: "dm", userIds: ids };
  }

  const legacy = parseLegacyStreamTopic(trimmed);
  if (legacy) {
    return { kind: "stream", ...legacy };
  }

  throw new Error(
    `Unrecognized Zulip target: ${raw}. Use "stream:NAME:topic:TOPIC" or "dm:USER_ID"`,
  );
}

function parseBareStreamTarget(raw: string, replyToTopic?: string): ZulipTarget | undefined {
  const topic = replyToTopic?.trim();
  if (!topic) {
    return undefined;
  }
  const trimmed = raw.trim().replace(/^zulip:/i, "");
  if (!trimmed || /^dm:/i.test(trimmed) || /^stream:/i.test(trimmed) || trimmed.includes(":")) {
    return undefined;
  }
  const stream = normalizeStreamName(trimmed);
  if (!stream) {
    return undefined;
  }
  return { kind: "stream", stream, topic };
}

export async function sendMessageZulip(
  to: string,
  text: string,
  opts: ZulipSendOpts = {},
): Promise<ZulipSendResult> {
  const core = getZulipRuntime();
  const logger = core.logging.getChildLogger({ module: "zulip" });
  const cfg = core.config.loadConfig();
  const account = resolveZulipAccount({ cfg, accountId: opts.accountId });

  const botEmail = account.botEmail?.trim();
  const botApiKey = account.botApiKey?.trim();
  if (!botEmail || !botApiKey) {
    throw new Error(`Zulip bot credentials missing for account "${account.accountId}"`);
  }
  const baseUrl = normalizeZulipBaseUrl(account.baseUrl);
  if (!baseUrl) {
    throw new Error(`Zulip baseUrl missing for account "${account.accountId}"`);
  }

  const client = createZulipClient({ baseUrl, botEmail, botApiKey });
  let parsedTarget: ZulipTarget;
  try {
    parsedTarget = parseZulipTarget(to);
  } catch (error) {
    const fallback = parseBareStreamTarget(to, opts.replyToTopic);
    if (!fallback) {
      throw error;
    }
    parsedTarget = fallback;
  }
  const target: ZulipTarget =
    parsedTarget.kind === "stream"
      ? {
          ...parsedTarget,
          stream: await resolveStreamNameForSend({
            stream: parsedTarget.stream,
            accountStreams: account.config.streams,
            client,
          }),
        }
      : parsedTarget;

  let message = text?.trim() ?? "";

  // Handle media: upload and append markdown link
  const mediaUrl = opts.mediaUrl?.trim();
  if (mediaUrl) {
    try {
      const media = await core.media.loadWebMedia(mediaUrl);
      const uri = await uploadZulipFile(client, {
        buffer: media.buffer,
        fileName: media.fileName ?? "upload",
        contentType: media.contentType ?? undefined,
      });
      // Zulip uses markdown: [filename](uri)
      const fullUrl = uri.startsWith("http") ? uri : `${baseUrl}${uri}`;
      message = [message, `[${media.fileName ?? "attachment"}](${fullUrl})`]
        .filter(Boolean)
        .join("\n");
    } catch (err) {
      if (core.logging.shouldLogVerbose()) {
        logger.debug?.(`zulip send: media upload failed, falling back: ${String(err)}`);
      }
      if (isHttpUrl(mediaUrl)) {
        message = [message, mediaUrl].filter(Boolean).join("\n");
      }
    }
  }

  if (!message) {
    throw new Error("Zulip message is empty");
  }

  let messageId: string;

  if (target.kind === "stream") {
    const res = await sendZulipStreamMessage(client, {
      stream: target.stream,
      topic: opts.replyToTopic ?? target.topic,
      content: message,
    });
    messageId = String(res.id ?? "unknown");
  } else {
    const res = await sendZulipDirectMessage(client, {
      to: target.userIds,
      content: message,
    });
    messageId = String(res.id ?? "unknown");
  }

  core.channel.activity.record({
    channel: "zulip",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { messageId, target: to };
}
