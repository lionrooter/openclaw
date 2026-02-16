import { describe, expect, it } from "vitest";
import { ToolInputError } from "./common.js";
import { __testing, createMaestroTool } from "./maestro-tool.js";

describe("maestro-tool", () => {
  it("creates tool with expected metadata", () => {
    const tool = createMaestroTool();
    expect(tool.name).toBe("maestro");
    expect(tool.label).toBe("Maestro Queue");
  });

  it("builds list args as json output", () => {
    const args = __testing.buildTaskApiArgs("list", { owner: "cody", status: "active" });
    expect(args).toEqual(["list", "--status", "active", "--owner", "cody", "--json"]);
  });

  it("builds enqueue args with required fields", () => {
    const args = __testing.buildTaskApiArgs("enqueue", {
      owner: "cody",
      title: "Investigate",
      ask: "Find bug",
      priority: "p1",
      actor: "cody",
    });
    expect(args).toContain("enqueue");
    expect(args).toContain("--owner");
    expect(args).toContain("cody");
    expect(args).toContain("--title");
    expect(args).toContain("Investigate");
    expect(args).toContain("--ask");
    expect(args).toContain("Find bug");
    expect(args).toContain("--priority");
    expect(args).toContain("p1");
  });

  it("requires owner/title/ask for enqueue", () => {
    expect(() => __testing.buildTaskApiArgs("enqueue", {})).toThrow(ToolInputError);
  });

  it("requires task+owner+actor for reassign", () => {
    expect(() => __testing.buildTaskApiArgs("reassign", { task: "x.md", owner: "leo" })).toThrow(
      ToolInputError,
    );
  });

  it("prefers taskApiPath param over env/default", () => {
    const result = __testing.resolveTaskApiPath({ taskApiPath: "/tmp/task-api" });
    expect(result).toBe("/tmp/task-api");
  });
});
