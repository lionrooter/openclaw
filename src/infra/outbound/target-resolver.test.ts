import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDirectoryEntry } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetDirectoryCache, resolveMessagingTarget } from "./target-resolver.js";

const mocks = vi.hoisted(() => ({
  listGroups: vi.fn(),
  listGroupsLive: vi.fn(),
  getChannelPlugin: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => mocks.getChannelPlugin(...args),
  normalizeChannelId: (value: string) => value,
}));

describe("resolveMessagingTarget (directory fallback)", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    mocks.listGroups.mockReset();
    mocks.listGroupsLive.mockReset();
    mocks.getChannelPlugin.mockReset();
    resetDirectoryCache();
    mocks.getChannelPlugin.mockReturnValue({
      directory: {
        listGroups: mocks.listGroups,
        listGroupsLive: mocks.listGroupsLive,
      },
    });
  });

  it("uses live directory fallback and caches the result", async () => {
    const entry: ChannelDirectoryEntry = { kind: "group", id: "123456789", name: "support" };
    mocks.listGroups.mockResolvedValue([]);
    mocks.listGroupsLive.mockResolvedValue([entry]);

    const first = await resolveMessagingTarget({
      cfg,
      channel: "discord",
      input: "support",
    });

    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.target.source).toBe("directory");
      expect(first.target.to).toBe("123456789");
    }
    expect(mocks.listGroups).toHaveBeenCalledTimes(1);
    expect(mocks.listGroupsLive).toHaveBeenCalledTimes(1);

    const second = await resolveMessagingTarget({
      cfg,
      channel: "discord",
      input: "support",
    });

    expect(second.ok).toBe(true);
    expect(mocks.listGroups).toHaveBeenCalledTimes(1);
    expect(mocks.listGroupsLive).toHaveBeenCalledTimes(1);
  });

  it("skips directory lookup for direct ids", async () => {
    const result = await resolveMessagingTarget({
      cfg,
      channel: "discord",
      input: "123456789",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.source).toBe("normalized");
      expect(result.target.to).toBe("123456789");
    }
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("treats Zulip shorthand stream:topic target as a direct target", async () => {
    const rawInput = "04:computer: coding-loop";
    mocks.getChannelPlugin.mockImplementation((channelId: string) => {
      if (channelId !== "zulip") {
        return {
          directory: {
            listGroups: mocks.listGroups,
            listGroupsLive: mocks.listGroupsLive,
          },
        } as never;
      }
      return {
        messaging: {
          targetResolver: {
            looksLikeId: (raw) => {
              const trimmed = raw.trim();
              if (/^(stream:|dm:)/i.test(trimmed)) {
                return true;
              }
              const lastColon = trimmed.lastIndexOf(":");
              return lastColon > 0 && lastColon < trimmed.length - 1;
            },
          },
        },
        directory: {
          listGroups: mocks.listGroups,
          listGroupsLive: mocks.listGroupsLive,
        },
      } as never;
    });

    const result = await resolveMessagingTarget({
      cfg,
      channel: "zulip",
      input: rawInput,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.source).toBe("normalized");
      expect(result.target.to).toBe(rawInput);
    }
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("classifies Zulip dm targets as user kind", async () => {
    mocks.getChannelPlugin.mockImplementation((channelId: string) => {
      if (channelId !== "zulip") {
        return {
          directory: {
            listGroups: mocks.listGroups,
            listGroupsLive: mocks.listGroupsLive,
          },
        } as never;
      }
      return {
        messaging: {
          targetResolver: {
            looksLikeId: (raw: string) => /^(stream:|dm:)/i.test(raw.trim()),
          },
        },
        directory: {
          listGroups: mocks.listGroups,
          listGroupsLive: mocks.listGroupsLive,
        },
      } as never;
    });

    const result = await resolveMessagingTarget({
      cfg,
      channel: "zulip",
      input: "dm:12345",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.kind).toBe("user");
      expect(result.target.to).toBe("dm:12345");
      expect(result.target.source).toBe("normalized");
    }
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });
});
