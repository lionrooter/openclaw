import type { TemplateContext } from "../auto-reply/templating.js";
/**
 * Zulip DM group ID normalization and resolution.
 *
 * Extracted from get-reply-run.ts to minimize upstream diff.
 */
import { normalizeChatType } from "../channels/chat-type.js";
import { resolveGroupSessionKey } from "../config/sessions.js";

export function normalizeZulipDmGroupId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  const withoutRoot = trimmed.replace(/^(?:zulip|user):/i, "");
  const withoutUser = withoutRoot.replace(/^user:/i, "");
  return withoutUser.trim().toLowerCase() || undefined;
}

export function resolveZulipFollowupGroupId(sessionCtx: TemplateContext): string | undefined {
  const resolvedBySession = resolveGroupSessionKey(sessionCtx)?.id;
  if (resolvedBySession) {
    return resolvedBySession;
  }
  const normalizedChatType = normalizeChatType(sessionCtx.ChatType);
  if (sessionCtx.Provider?.trim().toLowerCase() !== "zulip" || normalizedChatType !== "direct") {
    return undefined;
  }
  return normalizeZulipDmGroupId(sessionCtx.From) ?? normalizeZulipDmGroupId(sessionCtx.SenderId);
}
