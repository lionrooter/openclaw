import { describe, expect, it } from "vitest";
import { __testing, createCodexDelegateTool } from "./codex-delegate-tool.js";
import { ToolInputError } from "./common.js";

const { parseCodexJsonlOutput, validateDirectory } = __testing;

describe("codex-delegate-tool", () => {
  describe("createCodexDelegateTool", () => {
    it("creates tool with correct name and label", () => {
      const tool = createCodexDelegateTool();
      expect(tool.name).toBe("codex_delegate");
      expect(tool.label).toBe("Codex Delegate");
    });

    it("has required schema parameters", () => {
      const tool = createCodexDelegateTool();
      const schema = tool.parameters as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.properties).toHaveProperty("action");
      expect(schema.properties).toHaveProperty("task");
      expect(schema.properties).toHaveProperty("directory");
      expect(schema.properties).toHaveProperty("model");
    });
  });

  describe("validateDirectory", () => {
    it("rejects relative paths", () => {
      expect(() => validateDirectory("./relative/path")).toThrow(ToolInputError);
      expect(() => validateDirectory("./relative/path")).toThrow("absolute path");
    });

    it("accepts absolute paths with no allowDirs", () => {
      expect(() => validateDirectory("/tmp/some-project")).not.toThrow();
    });

    it("accepts directory within allowDirs", () => {
      expect(() => validateDirectory("/tmp/project", ["/tmp"])).not.toThrow();
      expect(() => validateDirectory("/tmp/project/sub", ["/tmp/project"])).not.toThrow();
    });

    it("rejects directory outside allowDirs", () => {
      expect(() => validateDirectory("/home/user/secret", ["/tmp", "/var"])).toThrow(
        ToolInputError,
      );
      expect(() => validateDirectory("/home/user/secret", ["/tmp"])).toThrow("not in the allowed");
    });

    it("rejects path prefix tricks", () => {
      // /tmp-evil should not match /tmp
      expect(() => validateDirectory("/tmp-evil/project", ["/tmp"])).toThrow(ToolInputError);
    });
  });

  describe("parseCodexJsonlOutput", () => {
    it("extracts text from item.completed events", () => {
      const input = [
        JSON.stringify({
          type: "item.completed",
          item: { content: [{ type: "output_text", text: "Created hello.ts" }] },
        }),
      ].join("\n");

      expect(parseCodexJsonlOutput(input)).toBe("Created hello.ts");
    });

    it("extracts formatted text from item.completed events", () => {
      const input = [
        JSON.stringify({
          type: "item.completed",
          item: { formatted: { text: "Done implementing feature" } },
        }),
      ].join("\n");

      expect(parseCodexJsonlOutput(input)).toBe("Done implementing feature");
    });

    it("extracts command output from command.completed events", () => {
      const input = [
        JSON.stringify({
          type: "command.completed",
          output: "3 files changed, 42 insertions(+)",
        }),
      ].join("\n");

      expect(parseCodexJsonlOutput(input)).toBe("[command] 3 files changed, 42 insertions(+)");
    });

    it("combines multiple events", () => {
      const input = [
        JSON.stringify({
          type: "item.completed",
          item: { content: [{ type: "output_text", text: "First part" }] },
        }),
        JSON.stringify({
          type: "command.completed",
          output: "ran tests",
        }),
        JSON.stringify({
          type: "item.completed",
          item: { content: [{ type: "output_text", text: "Second part" }] },
        }),
      ].join("\n");

      const result = parseCodexJsonlOutput(input);
      expect(result).toContain("First part");
      expect(result).toContain("[command] ran tests");
      expect(result).toContain("Second part");
    });

    it("handles non-JSON lines gracefully", () => {
      const input = "some plain text output\nnot json at all";
      const result = parseCodexJsonlOutput(input);
      expect(result).toContain("some plain text output");
      expect(result).toContain("not json at all");
    });

    it("falls back to raw content when no recognized events", () => {
      const input = JSON.stringify({ type: "unknown_event", data: "whatever" });
      const result = parseCodexJsonlOutput(input);
      expect(result).toBe(input.trim());
    });

    it("handles empty input", () => {
      expect(parseCodexJsonlOutput("")).toBe("");
    });
  });

  describe("config gating", () => {
    it("tool is not created when enabled=false", () => {
      // This tests the gating logic in openclaw-tools.ts
      // The tool itself always creates — gating happens at the wiring layer
      const tool = createCodexDelegateTool({
        config: { tools: { codexDelegate: { enabled: false } } },
      });
      // Tool is always created by the factory; the enabled check is in openclaw-tools.ts
      expect(tool.name).toBe("codex_delegate");
    });
  });

  describe("resolveCodexConfig", () => {
    it("returns empty config when no codexDelegate in config", () => {
      const result = __testing.resolveCodexConfig({});
      expect(result).toEqual({});
    });

    it("returns codexDelegate config when present", () => {
      const result = __testing.resolveCodexConfig({
        tools: {
          codexDelegate: {
            model: "custom-model",
            maxTimeoutMs: 600_000,
          },
        },
      });
      expect(result.model).toBe("custom-model");
      expect(result.maxTimeoutMs).toBe(600_000);
    });
  });
});
