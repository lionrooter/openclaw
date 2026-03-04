import { describe, expect, it } from "vitest";
import { formatReplyForChannel } from "./format-reply.js";

// ---------------------------------------------------------------------------
// full mode
// ---------------------------------------------------------------------------

describe("formatReplyForChannel — full mode", () => {
  it("wraps a narration line in italic", () => {
    expect(formatReplyForChannel("Investigating the logs", "full")).toBe(
      "*Investigating the logs*",
    );
  });

  it("wraps narration surrounded by content", () => {
    const input = "Here is your answer\n\nInvestigating...\n\nThe fix is X";
    const expected = "Here is your answer\n\n*Investigating...*\n\nThe fix is X";
    expect(formatReplyForChannel(input, "full")).toBe(expected);
  });

  it("wraps multiple narration verbs", () => {
    expect(formatReplyForChannel("Checking the config", "full")).toBe("*Checking the config*");
    expect(formatReplyForChannel("I'm now reviewing the PR", "full")).toBe(
      "*I'm now reviewing the PR*",
    );
    expect(formatReplyForChannel("Looking into the issue", "full")).toBe(
      "*Looking into the issue*",
    );
    expect(formatReplyForChannel("Diving into the codebase", "full")).toBe(
      "*Diving into the codebase*",
    );
  });

  it("wraps expanded verb list", () => {
    expect(formatReplyForChannel("Extracting the config values", "full")).toBe(
      "*Extracting the config values*",
    );
    expect(formatReplyForChannel("Locating correct sandbox path", "full")).toBe(
      "*Locating correct sandbox path*",
    );
    expect(formatReplyForChannel("Summarizing the results", "full")).toBe(
      "*Summarizing the results*",
    );
    expect(formatReplyForChannel("Building the output", "full")).toBe("*Building the output*");
    expect(formatReplyForChannel("Creating the new file", "full")).toBe("*Creating the new file*");
    expect(formatReplyForChannel("Updating the database", "full")).toBe("*Updating the database*");
    expect(formatReplyForChannel("Resolving dependencies", "full")).toBe(
      "*Resolving dependencies*",
    );
    expect(formatReplyForChannel("Validating input schema", "full")).toBe(
      "*Validating input schema*",
    );
    expect(formatReplyForChannel("Deploying to production", "full")).toBe(
      "*Deploying to production*",
    );
    expect(formatReplyForChannel("Detecting file changes", "full")).toBe(
      "*Detecting file changes*",
    );
  });

  it("formats consecutive narration lines with blank lines between", () => {
    const input =
      "Investigating sandbox path access\nLocating correct sandbox path\nChoosing fallback cat command";
    const expected =
      "*Investigating sandbox path access*\n\n*Locating correct sandbox path*\n\n*Choosing fallback cat command*";
    expect(formatReplyForChannel(input, "full")).toBe(expected);
  });

  it("inserts transition blank line between narration and content", () => {
    const input = "Investigating sandbox path access\nHere is the answer.";
    const expected = "*Investigating sandbox path access*\n\nHere is the answer.";
    expect(formatReplyForChannel(input, "full")).toBe(expected);
  });

  it("inserts transition blank line between content and narration", () => {
    const input = "Here is context.\nInvestigating sandbox path access";
    const expected = "Here is context.\n\n*Investigating sandbox path access*";
    expect(formatReplyForChannel(input, "full")).toBe(expected);
  });

  it("does not double-insert blank lines when already separated", () => {
    const input = "Here is context.\n\nInvestigating sandbox path access\n\nThe answer is X.";
    const expected = "Here is context.\n\n*Investigating sandbox path access*\n\nThe answer is X.";
    expect(formatReplyForChannel(input, "full")).toBe(expected);
  });

  it("does not touch lines inside code fences", () => {
    const input = "```\nInvestigating the logs\n```";
    expect(formatReplyForChannel(input, "full")).toBe(input);
  });

  it("does not touch lines with markdown markers", () => {
    expect(formatReplyForChannel("# Investigating the logs", "full")).toBe(
      "# Investigating the logs",
    );
    expect(formatReplyForChannel("- Investigating the logs", "full")).toBe(
      "- Investigating the logs",
    );
    expect(formatReplyForChannel("1. Investigating the logs", "full")).toBe(
      "1. Investigating the logs",
    );
    expect(formatReplyForChannel("`Investigating` the logs", "full")).toBe(
      "`Investigating` the logs",
    );
    expect(formatReplyForChannel("[Investigating](url) the logs", "full")).toBe(
      "[Investigating](url) the logs",
    );
  });

  it("does not touch lines over 120 characters", () => {
    const long = "Investigating " + "x".repeat(120);
    expect(formatReplyForChannel(long, "full")).toBe(long);
  });

  it("collapses 4+ blank lines to 3 (2 blank)", () => {
    const input = "A\n\n\n\n\nB";
    expect(formatReplyForChannel(input, "full")).toBe("A\n\n\nB");
  });
});

// ---------------------------------------------------------------------------
// compact mode
// ---------------------------------------------------------------------------

describe("formatReplyForChannel — compact mode", () => {
  it("wraps a narration line in parentheses", () => {
    expect(formatReplyForChannel("Investigating the logs", "compact")).toBe(
      "(Investigating the logs)",
    );
  });

  it("wraps narration surrounded by content", () => {
    const input = "Here is your answer\n\nInvestigating...\n\nThe fix is X";
    const expected = "Here is your answer\n\n(Investigating)\n\nThe fix is X";
    expect(formatReplyForChannel(input, "compact")).toBe(expected);
  });

  it("trims trailing ellipsis", () => {
    expect(formatReplyForChannel("Checking...", "compact")).toBe("(Checking)");
    expect(formatReplyForChannel("Checking....", "compact")).toBe("(Checking)");
  });

  it("formats consecutive narration lines without blank line insertion", () => {
    const input = "Investigating sandbox path\nLocating the file\nChoosing fallback";
    const expected = "(Investigating sandbox path)\n(Locating the file)\n(Choosing fallback)";
    expect(formatReplyForChannel(input, "compact")).toBe(expected);
  });

  it("does not touch lines inside code fences", () => {
    const input = "```\nInvestigating the logs\n```";
    expect(formatReplyForChannel(input, "compact")).toBe(input);
  });

  it("collapses 3+ blank lines to 1 blank", () => {
    const input = "A\n\n\n\nB";
    expect(formatReplyForChannel(input, "compact")).toBe("A\n\nB");
  });
});

// ---------------------------------------------------------------------------
// off mode
// ---------------------------------------------------------------------------

describe("formatReplyForChannel — off mode", () => {
  it("passes through unchanged", () => {
    const input = "Investigating the logs\n\n\n\n\nStuff";
    expect(formatReplyForChannel(input, "off")).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// edge cases
// ---------------------------------------------------------------------------

describe("formatReplyForChannel — edge cases", () => {
  it("returns empty string unchanged", () => {
    expect(formatReplyForChannel("", "full")).toBe("");
    expect(formatReplyForChannel("", "compact")).toBe("");
  });

  it("returns text with no reasoning unchanged", () => {
    const input = "Here is the answer to your question.";
    expect(formatReplyForChannel(input, "full")).toBe(input);
    expect(formatReplyForChannel(input, "compact")).toBe(input);
  });

  it("formats all-reasoning message", () => {
    const input = "Investigating...\nChecking the config";
    expect(formatReplyForChannel(input, "full")).toBe(
      "*Investigating...*\n\n*Checking the config*",
    );
  });

  it("handles unclosed code fence gracefully", () => {
    const input = "```\nInvestigating the logs\nno closing fence";
    expect(formatReplyForChannel(input, "full")).toBe(input);
  });
});
