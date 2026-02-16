import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchZulipMessages, type ZulipClient, type ZulipMessage } from "./client.js";
import { formatZulipTopicHistoryBody, resolveZulipTopicContext } from "./monitor.js";

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    fetchZulipMessages: vi.fn(),
  };
});

const mockedFetchZulipMessages = vi.mocked(fetchZulipMessages);

const DUMMY_CLIENT: ZulipClient = {
  baseUrl: "https://zulip.example.com",
  botEmail: "bot@zulip.example.com",
  botApiKey: "key",
  authHeader: "Basic abc",
  request: vi.fn(),
  requestForm: vi.fn(),
};

function createStreamMessage(params: {
  id: number;
  senderId: number;
  senderName: string;
  senderEmail?: string;
  content: string;
  timestamp: number;
}): ZulipMessage {
  return {
    id: params.id,
    sender_id: params.senderId,
    sender_email: params.senderEmail ?? `${params.senderName.toLowerCase()}@example.com`,
    sender_full_name: params.senderName,
    type: "stream",
    stream_id: 42,
    display_recipient: "engineering",
    subject: "topic",
    content: params.content,
    timestamp: params.timestamp,
  };
}

describe("formatZulipTopicHistoryBody", () => {
  it("formats user and bot messages with role labels and message ids", () => {
    const formatted = formatZulipTopicHistoryBody({
      messages: [
        createStreamMessage({
          id: 10,
          senderId: 101,
          senderName: "Alice",
          content: "Question",
          timestamp: 1_700_000_000,
        }),
        createStreamMessage({
          id: 11,
          senderId: 999,
          senderName: "Botty",
          content: "Answer",
          timestamp: 1_700_000_100,
        }),
      ],
      botUserId: 999,
      formatInboundEnvelope: (envelope) => `${envelope.from} :: ${envelope.body}`,
    });

    expect(formatted).toContain("Alice (user)");
    expect(formatted).toContain("Botty (assistant)");
    expect(formatted).toContain("[zulip message id: 10]");
    expect(formatted).toContain("[zulip message id: 11]");
  });
});

describe("resolveZulipTopicContext", () => {
  beforeEach(() => {
    mockedFetchZulipMessages.mockReset();
  });

  it("fetches and formats topic history for first stream turn", async () => {
    mockedFetchZulipMessages.mockResolvedValueOnce([
      createStreamMessage({
        id: 15,
        senderId: 999,
        senderName: "Botty",
        content: "Bot response",
        timestamp: 1_700_000_150,
      }),
      createStreamMessage({
        id: 13,
        senderId: 101,
        senderName: "Alice",
        content: "Prior question",
        timestamp: 1_700_000_130,
      }),
      createStreamMessage({
        id: 16,
        senderId: 102,
        senderName: "Bob",
        content: "   ",
        timestamp: 1_700_000_160,
      }),
      createStreamMessage({
        id: 17,
        senderId: 101,
        senderName: "Alice",
        content: "Current message",
        timestamp: 1_700_000_170,
      }),
    ]);

    const result = await resolveZulipTopicContext({
      client: DUMMY_CLIENT,
      kind: "stream",
      streamName: "engineering",
      topic: "deploy",
      currentMessageId: 17,
      botUserId: 999,
      initialHistoryLimit: 2,
      sessionPreviousTimestamp: undefined,
      formatInboundEnvelope: (envelope) => `${envelope.from} :: ${envelope.body}`,
    });

    expect(result.threadLabel).toBe("Zulip topic #engineering > deploy");
    expect(result.isFirstTopicTurn).toBe(true);
    expect(result.threadHistoryBody).toBeDefined();
    expect(result.threadHistoryBody).toContain("Alice (user)");
    expect(result.threadHistoryBody).toContain("Botty (assistant)");
    expect(result.threadHistoryBody).toContain("[zulip message id: 13]");
    expect(result.threadHistoryBody).toContain("[zulip message id: 15]");
    expect(result.threadHistoryBody).not.toContain("Current message");

    expect(mockedFetchZulipMessages).toHaveBeenCalledTimes(1);
    expect(mockedFetchZulipMessages).toHaveBeenCalledWith(DUMMY_CLIENT, {
      anchor: "newest",
      numBefore: 3,
      numAfter: 0,
      narrow: [
        { operator: "stream", operand: "engineering" },
        { operator: "topic", operand: "deploy" },
      ],
    });
  });

  it("does not fetch for existing stream sessions", async () => {
    const result = await resolveZulipTopicContext({
      client: DUMMY_CLIENT,
      kind: "stream",
      streamName: "engineering",
      topic: "deploy",
      currentMessageId: 17,
      botUserId: 999,
      initialHistoryLimit: 20,
      sessionPreviousTimestamp: Date.now(),
      formatInboundEnvelope: (envelope) => envelope.body,
    });

    expect(result.threadLabel).toBe("Zulip topic #engineering > deploy");
    expect(result.isFirstTopicTurn).toBe(false);
    expect(result.threadHistoryBody).toBeUndefined();
    expect(mockedFetchZulipMessages).not.toHaveBeenCalled();
  });

  it("does not fetch when history limit is disabled", async () => {
    const result = await resolveZulipTopicContext({
      client: DUMMY_CLIENT,
      kind: "stream",
      streamName: "engineering",
      topic: "deploy",
      currentMessageId: 17,
      botUserId: 999,
      initialHistoryLimit: 0,
      sessionPreviousTimestamp: undefined,
      formatInboundEnvelope: (envelope) => envelope.body,
    });

    expect(result.threadLabel).toBe("Zulip topic #engineering > deploy");
    expect(result.isFirstTopicTurn).toBe(true);
    expect(result.threadHistoryBody).toBeUndefined();
    expect(mockedFetchZulipMessages).not.toHaveBeenCalled();
  });

  it("skips topic history for DMs", async () => {
    const result = await resolveZulipTopicContext({
      client: DUMMY_CLIENT,
      kind: "dm",
      streamName: "",
      topic: "",
      currentMessageId: 17,
      botUserId: 999,
      initialHistoryLimit: 20,
      sessionPreviousTimestamp: undefined,
      formatInboundEnvelope: (envelope) => envelope.body,
    });

    expect(result.threadLabel).toBeUndefined();
    expect(result.isFirstTopicTurn).toBe(false);
    expect(result.threadHistoryBody).toBeUndefined();
    expect(mockedFetchZulipMessages).not.toHaveBeenCalled();
  });

  it("fails open when Zulip history API throws", async () => {
    mockedFetchZulipMessages.mockRejectedValueOnce(new Error("zulip timeout"));
    const verboseLog = vi.fn();

    const result = await resolveZulipTopicContext({
      client: DUMMY_CLIENT,
      kind: "stream",
      streamName: "engineering",
      topic: "deploy",
      currentMessageId: 17,
      botUserId: 999,
      initialHistoryLimit: 20,
      sessionPreviousTimestamp: undefined,
      formatInboundEnvelope: (envelope) => envelope.body,
      logVerbose: verboseLog,
    });

    expect(result.threadLabel).toBe("Zulip topic #engineering > deploy");
    expect(result.isFirstTopicTurn).toBe(true);
    expect(result.threadHistoryBody).toBeUndefined();
    expect(verboseLog).not.toHaveBeenCalled();
  });
});
