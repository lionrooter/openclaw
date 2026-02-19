import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("config schema regressions", () => {
  const validWorkflowLane = {
    enabled: true,
    mode: "hard",
    applyWhen: "always",
    domain: "ops",
  } as const;

  it("accepts nested telegram groupPolicy overrides", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              groupPolicy: "open",
              topics: {
                "42": {
                  groupPolicy: "disabled",
                },
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch fallback "voyage"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            fallback: "voyage",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects invalid workflowLane.domain values", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          workflowLane: {
            ...validWorkflowLane,
            domain: "toString",
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((issue) => issue.path === "agents.defaults.workflowLane.domain")).toBe(
        true,
      );
    }
  });

  it("rejects invalid workflowLane.mode values", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "main",
            workflowLane: {
              ...validWorkflowLane,
              mode: "disabled",
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((issue) => issue.path === "agents.list.0.workflowLane.mode")).toBe(
        true,
      );
    }
  });

  it("rejects invalid workflowLane.applyWhen values", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "main",
            workflowLane: {
              ...validWorkflowLane,
              applyWhen: "sometimes",
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some((issue) => issue.path === "agents.list.0.workflowLane.applyWhen"),
      ).toBe(true);
    }
  });

  it("accepts safe iMessage remoteHost", () => {
    const res = validateConfigObject({
      channels: {
        imessage: {
          remoteHost: "bot@gateway-host",
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects unsafe iMessage remoteHost", () => {
    const res = validateConfigObject({
      channels: {
        imessage: {
          remoteHost: "bot@gateway-host -oProxyCommand=whoami",
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.imessage.remoteHost");
    }
  });

  it("accepts iMessage attachment root patterns", () => {
    const res = validateConfigObject({
      channels: {
        imessage: {
          attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
          remoteAttachmentRoots: ["/Volumes/relay/attachments"],
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects relative iMessage attachment roots", () => {
    const res = validateConfigObject({
      channels: {
        imessage: {
          attachmentRoots: ["./attachments"],
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.imessage.attachmentRoots.0");
    }
  });
});
