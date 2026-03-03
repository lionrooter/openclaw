import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IMessageRpcClient } from "./client.js";
import { clearIMessageProbeCache, probeIMessage } from "./probe.js";

const detectBinaryMock = vi.hoisted(() => vi.fn());
const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn());

vi.mock("../commands/onboard-helpers.js", () => ({
  detectBinary: (...args: unknown[]) => detectBinaryMock(...args),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: (...args: unknown[]) => createIMessageRpcClientMock(...args),
}));

beforeEach(() => {
  clearIMessageProbeCache();
  detectBinaryMock.mockClear().mockResolvedValue(true);
  runCommandWithTimeoutMock.mockClear().mockResolvedValue({
    stdout: "",
    stderr: 'unknown command "rpc" for "imsg"',
    code: 1,
    signal: null,
    killed: false,
  });
  createIMessageRpcClientMock.mockClear();
});

describe("probeIMessage", () => {
  it("marks unknown rpc subcommand as fatal", async () => {
    const result = await probeIMessage(1000, { cliPath: "imsg" });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/rpc/i);
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });

  it("marks authorization denied as fatal", async () => {
    runCommandWithTimeoutMock.mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    createIMessageRpcClientMock.mockResolvedValue({
      request: vi.fn(async () => {
        throw new Error(
          'imsg rpc: failed to parse permissionDenied(path: "/Users/me/Library/Messages/chat.db", underlying: authorization denied (code: 23))',
        );
      }),
      stop: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      waitForClose: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient);

    const result = await probeIMessage(1000, { cliPath: "imsg" });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/authorization denied/i);
    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(1);
  });

  it("marks not-authorized startup errors as fatal", async () => {
    runCommandWithTimeoutMock.mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    createIMessageRpcClientMock.mockResolvedValue({
      request: vi.fn(async () => {
        throw new Error("imsg rpc: failed to start: not authorized to access db path");
      }),
      stop: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      waitForClose: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient);

    const result = await probeIMessage(1000, { cliPath: "imsg" });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/not authorized/i);
    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(1);
  });
});
