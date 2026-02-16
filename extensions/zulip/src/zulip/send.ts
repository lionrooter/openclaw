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

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Parse a target string:
 * - "stream:general:topic:hello" → stream message
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
      throw new Error("Zulip stream target requires :topic: separator (stream:NAME:topic:TOPIC)");
    }
    const stream = rest.slice(0, topicIdx).trim();
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

  throw new Error(
    `Unrecognized Zulip target: ${raw}. Use "stream:NAME:topic:TOPIC" or "dm:USER_ID"`,
  );
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
  const target = parseZulipTarget(to);

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
