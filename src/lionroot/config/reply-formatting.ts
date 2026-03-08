import { normalizeChannelId } from "../../channels/plugins/index.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyFormattingMode } from "../../config/types.base.js";
import { resolveAccountEntry } from "../../routing/account-lookup.js";
import { normalizeAccountId } from "../../routing/session-key.js";

type FormattingConfigEntry = {
  formatting?: {
    mode?: ReplyFormattingMode;
  };
};

type FormattingConfigSection = FormattingConfigEntry & {
  accounts?: Record<string, FormattingConfigEntry>;
};

const DEFAULT_FORMATTING_MODES = new Map<string, ReplyFormattingMode>([
  ["zulip", "full"],
  ["discord", "full"],
  ["imessage", "compact"],
  ["telegram", "compact"],
  ["signal", "compact"],
  ["whatsapp", "compact"],
]);

const isReplyFormattingMode = (value: unknown): value is ReplyFormattingMode =>
  value === "full" || value === "compact" || value === "off";

function resolveFormattingModeFromSection(
  section: FormattingConfigSection | undefined,
  accountId?: string | null,
): ReplyFormattingMode | undefined {
  if (!section) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts = section.accounts;
  if (accounts && typeof accounts === "object") {
    const match = resolveAccountEntry(accounts, normalizedAccountId);
    const matchMode = match?.formatting?.mode;
    if (isReplyFormattingMode(matchMode)) {
      return matchMode;
    }
  }
  const sectionMode = section.formatting?.mode;
  return isReplyFormattingMode(sectionMode) ? sectionMode : undefined;
}

export function resolveReplyFormattingMode(params: {
  cfg?: Partial<OpenClawConfig>;
  channel?: string | null;
  accountId?: string | null;
}): ReplyFormattingMode {
  const channel = normalizeChannelId(params.channel);
  const defaultMode = channel ? (DEFAULT_FORMATTING_MODES.get(channel) ?? "off") : "off";
  if (!channel || !params.cfg) {
    return defaultMode;
  }
  const channelsConfig = params.cfg.channels as Record<string, unknown> | undefined;
  const section = (channelsConfig?.[channel] ??
    (params.cfg as Record<string, unknown> | undefined)?.[channel]) as
    | FormattingConfigSection
    | undefined;
  return resolveFormattingModeFromSection(section, params.accountId) ?? defaultMode;
}
