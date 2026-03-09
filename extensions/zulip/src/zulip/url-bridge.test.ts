import { describe, expect, it, vi } from "vitest";
import { parseZulipBridgeUrl, readZulipUrl } from "./url-bridge.js";

function normalizeFetchInput(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function createConfig() {
  return {
    channels: {
      zulip: {
        enabled: true,
        accounts: {
          cody: {
            enabled: true,
            baseUrl: "https://zulip.example.com",
            botEmail: "cody@example.com",
            botApiKey: "secret-cody",
          },
          clawdy: {
            enabled: true,
            baseUrl: "https://zulip.example.com",
            botEmail: "clawdy@example.com",
            botApiKey: "secret-clawdy",
          },
        },
      },
    },
  };
}

describe("parseZulipBridgeUrl", () => {
  it("parses direct user_uploads URLs", () => {
    expect(
      parseZulipBridgeUrl("https://zulip.example.com/user_uploads/2/aa/bb/PastedText.txt"),
    ).toEqual({
      kind: "upload",
      baseUrl: "https://zulip.example.com",
      uploadPath: "/user_uploads/2/aa/bb/PastedText.txt",
      fileName: "PastedText.txt",
    });
  });

  it("parses narrow URLs with Zulip dot-hex topic encoding", () => {
    expect(
      parseZulipBridgeUrl(
        "https://zulip.example.com/#narrow/channel/5-04.F0.9F.92.BB-coding-loop/topic/x.3A.20OK.20this.20thing.20is.20totally.20insane/with/3538",
      ),
    ).toEqual({
      kind: "narrow",
      baseUrl: "https://zulip.example.com",
      streamOperand: 5,
      streamLabel: "04💻-coding-loop",
      topic: "x: OK this thing is totally insane",
      nearMessageId: 3538,
    });
  });
});

describe("readZulipUrl", () => {
  it("reads text uploads through authenticated fetch", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = normalizeFetchInput(input);
      expect(url).toBe("https://zulip.example.com/user_uploads/2/aa/bb/PastedText.txt");
      return new Response("Secret phrase: DGX-SPARK-NOT-FIRST.\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    const result = await readZulipUrl({
      cfg: createConfig() as never,
      url: "https://zulip.example.com/user_uploads/2/aa/bb/PastedText.txt",
      accountId: "cody",
      fetchImpl: fetchImpl as never,
    });

    expect(result).toContain("Zulip upload via account cody");
    expect(result).toContain("Secret phrase: DGX-SPARK-NOT-FIRST.");
  });

  it("reads narrow URLs into a readable transcript", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = normalizeFetchInput(input);
      expect(url).toContain("/api/v1/messages?");
      return new Response(
        JSON.stringify({
          messages: [
            {
              id: 3537,
              sender_id: 9,
              sender_email: "clawdy@example.com",
              sender_full_name: "Clawdy",
              type: "stream",
              display_recipient: "04💻 coding-loop",
              subject: "x: OK this thing is totally insane",
              content: "Can you read the file?",
              timestamp: 1773021600,
            },
            {
              id: 3538,
              sender_id: 10,
              sender_email: "cody@example.com",
              sender_full_name: "Cody",
              type: "stream",
              display_recipient: "04💻 coding-loop",
              subject: "x: OK this thing is totally insane",
              content: "Yes — here is the answer.",
              timestamp: 1773021660,
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const result = await readZulipUrl({
      cfg: {
        channels: {
          zulip: {
            enabled: true,
            accounts: {
              cody: createConfig().channels.zulip.accounts.cody,
            },
          },
        },
      } as never,
      url: "https://zulip.example.com/#narrow/channel/5-04.F0.9F.92.BB-coding-loop/topic/x.3A.20OK.20this.20thing.20is.20totally.20insane/near/3538",
      fetchImpl: fetchImpl as never,
    });

    expect(result).toContain("Zulip narrow via account cody");
    expect(result).toContain("Topic: x: OK this thing is totally insane");
    expect(result).toContain("Clawdy (#3537): Can you read the file?");
    expect(result).toContain("Cody (#3538): Yes — here is the answer.");
  });

  it("requires explicit account when multiple candidates share the same base URL", async () => {
    await expect(
      readZulipUrl({
        cfg: createConfig() as never,
        url: "https://zulip.example.com/user_uploads/2/aa/bb/PastedText.txt",
      }),
    ).rejects.toThrow("Pass --account <id>");
  });
});
