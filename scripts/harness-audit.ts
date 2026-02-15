/**
 * Harness Health Auditor — weekly check of agent environment quality.
 *
 * Checks the specific things that matter for agent-assisted development:
 * AGENTS.md health, architectural enforcement, CI completeness, docs coverage,
 * feedback loops, and ratchet trends.
 *
 * Run: node --import tsx scripts/harness-audit.ts
 * Schedule: weekly via LaunchAgent (ai.openclaw.harness-audit)
 * Reports: ~/.openclaw/logs/harness-audit/YYYY-MM-DD.txt
 */

import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Grade = "PASS" | "WARN" | "FAIL";

type CheckResult = {
  name: string;
  grade: Grade;
  detail: string;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPORT_DIR = join(homedir(), ".openclaw/logs/harness-audit");
const MAX_REPORTS = 12; // 3 months of weekly history
const AGENTS_MD = "AGENTS.md";
const AGENTS_MD_MAX_LINES = 200;
const AGENTS_MD_MAX_AGE_DAYS = 90;
const CI_WORKFLOW = ".github/workflows/ci.yml";
const DOCS_DIR = "docs";
const DOCS_MIN_FILES = 10;
const LOC_MAX = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysSince(mtime: Date): number {
  return Math.floor((Date.now() - mtime.getTime()) / (1000 * 60 * 60 * 24));
}

function countLines(content: string): number {
  return content.split("\n").length;
}

function runCommand(cmd: string): { ok: boolean; stdout: string } {
  try {
    const stdout = execSync(cmd, {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error: unknown) {
    const err = error as { stdout?: string };
    return { ok: false, stdout: err.stdout ?? "" };
  }
}

function gitLsFiles(): string[] {
  const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Load the most recent previous report to compare trends. */
function loadLastReport(): string | null {
  if (!existsSync(REPORT_DIR)) {
    return null;
  }
  const files = readdirSync(REPORT_DIR)
    .filter((f) => f.endsWith(".txt"))
    .toSorted()
    .toReversed();
  // Skip today's report if it exists
  const todayFile = `${today()}.txt`;
  const prev = files.find((f) => f !== todayFile);
  if (!prev) {
    return null;
  }
  try {
    return readFileSync(join(REPORT_DIR, prev), "utf8");
  } catch {
    return null;
  }
}

/** Extract a numeric value from a previous report line like "WARN  LOC violations: 259 files" */
function extractCountFromReport(report: string, label: string): number | null {
  const regex = new RegExp(`${label}:\\s*(\\d+)`);
  const match = report.match(regex);
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkAgentsMdSize(): Promise<CheckResult> {
  const name = "AGENTS.md size";
  try {
    const content = await readFile(AGENTS_MD, "utf8");
    const lines = countLines(content);
    if (lines <= AGENTS_MD_MAX_LINES) {
      return { name, grade: "PASS", detail: `${lines} lines (< ${AGENTS_MD_MAX_LINES} threshold)` };
    }
    return {
      name,
      grade: "WARN",
      detail: `${lines} lines (exceeds ${AGENTS_MD_MAX_LINES} threshold)`,
    };
  } catch {
    return { name, grade: "FAIL", detail: "AGENTS.md not found" };
  }
}

async function checkAgentsMdFreshness(): Promise<CheckResult> {
  const name = "AGENTS.md freshness";
  try {
    const stat = statSync(AGENTS_MD);
    const age = daysSince(stat.mtime);
    if (age <= AGENTS_MD_MAX_AGE_DAYS) {
      return { name, grade: "PASS", detail: `modified ${age} day${age === 1 ? "" : "s"} ago` };
    }
    return {
      name,
      grade: "WARN",
      detail: `modified ${age} days ago (stale > ${AGENTS_MD_MAX_AGE_DAYS}d)`,
    };
  } catch {
    return { name, grade: "FAIL", detail: "AGENTS.md not found" };
  }
}

async function checkArchitecturalBoundaries(): Promise<CheckResult> {
  const name = "Architectural boundaries";
  const result = runCommand("node --import tsx scripts/check-architecture.ts");
  if (result.ok) {
    return { name, grade: "PASS", detail: "0 violations" };
  }
  const violationCount = (result.stdout.match(/^VIOLATION:/gm) ?? []).length;
  return {
    name,
    grade: "FAIL",
    detail: `${violationCount} violation${violationCount === 1 ? "" : "s"}`,
  };
}

async function checkCiPipeline(): Promise<CheckResult> {
  const name = "CI pipeline";
  if (!existsSync(CI_WORKFLOW)) {
    return { name, grade: "FAIL", detail: "ci.yml not found" };
  }
  const content = await readFile(CI_WORKFLOW, "utf8");
  const hasCheck = content.includes("pnpm check") || content.includes("pnpm run check");
  const hasTest = content.includes("pnpm test") || content.includes("pnpm run test");
  if (hasCheck && hasTest) {
    return { name, grade: "PASS", detail: "ci.yml found with check + test jobs" };
  }
  const missing = [!hasCheck && "check", !hasTest && "test"].filter(Boolean).join(", ");
  return { name, grade: "WARN", detail: `ci.yml found but missing: ${missing}` };
}

async function checkDocsCoverage(): Promise<CheckResult> {
  const name = "Docs coverage";
  if (!existsSync(DOCS_DIR)) {
    return { name, grade: "FAIL", detail: "docs/ directory not found" };
  }
  const allFiles = gitLsFiles().filter((f) => f.startsWith("docs/"));
  if (allFiles.length >= DOCS_MIN_FILES) {
    return { name, grade: "PASS", detail: `${allFiles.length} files in docs/` };
  }
  return {
    name,
    grade: "WARN",
    detail: `only ${allFiles.length} files in docs/ (< ${DOCS_MIN_FILES})`,
  };
}

async function checkPreCommitHooks(): Promise<CheckResult> {
  const name = "Pre-commit hooks";
  if (existsSync("git-hooks/pre-commit")) {
    return { name, grade: "PASS", detail: "git-hooks/pre-commit found" };
  }
  if (existsSync(".husky/pre-commit")) {
    return { name, grade: "PASS", detail: ".husky/pre-commit found" };
  }
  return { name, grade: "WARN", detail: "no pre-commit hook found" };
}

async function checkKnownExceptions(): Promise<CheckResult> {
  const name = "Known exceptions";
  // Count exemptions in check-architecture.ts
  try {
    const content = await readFile("scripts/check-architecture.ts", "utf8");
    const exemptMatch = content.match(/const EXEMPT_PATHS\s*=\s*\[([\s\S]*?)\]\s*as\s*const/);
    if (!exemptMatch) {
      return { name, grade: "WARN", detail: "could not parse EXEMPT_PATHS" };
    }
    const count = (exemptMatch[1].match(/"/g) ?? []).length / 2; // each entry has opening+closing quote
    const lastReport = loadLastReport();
    if (lastReport) {
      const prev = extractCountFromReport(lastReport, "Known exceptions");
      if (prev !== null) {
        const delta = count - prev;
        if (delta > 0) {
          return { name, grade: "WARN", detail: `${count} (was ${prev} last week, +${delta})` };
        }
        return {
          name,
          grade: "PASS",
          detail: `${count} (${delta === 0 ? "unchanged" : `${delta}`} from last week)`,
        };
      }
    }
    return { name, grade: "PASS", detail: `${count} (no previous report to compare)` };
  } catch {
    return { name, grade: "WARN", detail: "check-architecture.ts not found" };
  }
}

async function checkLocViolations(): Promise<CheckResult> {
  const name = "LOC violations";
  const files = gitLsFiles()
    .filter((f) => existsSync(f))
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

  let overCount = 0;
  await Promise.all(
    files.map(async (f) => {
      const content = await readFile(f, "utf8");
      if (countLines(content) > LOC_MAX) {
        overCount++;
      }
    }),
  );

  const lastReport = loadLastReport();
  if (lastReport) {
    const prev = extractCountFromReport(lastReport, "LOC violations");
    if (prev !== null) {
      const delta = overCount - prev;
      if (delta > 0) {
        return {
          name,
          grade: "WARN",
          detail: `${overCount} files > ${LOC_MAX} lines (was ${prev} last week, +${delta})`,
        };
      }
      return {
        name,
        grade: "PASS",
        detail: `${overCount} files > ${LOC_MAX} lines (${delta === 0 ? "unchanged" : `${delta}`} from last week)`,
      };
    }
  }

  // No previous — just report current. WARN if any exist (they do — 259+).
  if (overCount > 0) {
    return {
      name,
      grade: "WARN",
      detail: `${overCount} files > ${LOC_MAX} lines (no previous report)`,
    };
  }
  return { name, grade: "PASS", detail: `0 files > ${LOC_MAX} lines` };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

async function generateReport(): Promise<string> {
  const checks = await Promise.all([
    checkAgentsMdSize(),
    checkAgentsMdFreshness(),
    checkArchitecturalBoundaries(),
    checkCiPipeline(),
    checkDocsCoverage(),
    checkPreCommitHooks(),
    checkKnownExceptions(),
    checkLocViolations(),
  ]);

  const passCount = checks.filter((c) => c.grade === "PASS").length;
  const warnCount = checks.filter((c) => c.grade === "WARN").length;
  const failCount = checks.filter((c) => c.grade === "FAIL").length;

  // Determine trend from last report
  let trend = "";
  const lastReport = loadLastReport();
  if (lastReport) {
    const prevScoreMatch = lastReport.match(/Score:\s*(\d+)\/\d+\s*PASS/);
    if (prevScoreMatch) {
      const prevPass = Number(prevScoreMatch[1]);
      if (passCount > prevPass) {
        trend = `improving (was ${prevPass}/${checks.length} last week)`;
      } else if (passCount < prevPass) {
        trend = `regressing (was ${prevPass}/${checks.length} last week)`;
      } else {
        trend = `stable (was ${prevPass}/${checks.length} last week)`;
      }
    }
  }

  const lines = [
    `=== Harness Health Audit: ${today()} ===`,
    "",
    ...checks.map((c) => `${c.grade.padEnd(5)} ${c.name}: ${c.detail}`),
    "",
    `Score: ${passCount}/${checks.length} PASS, ${warnCount} WARN, ${failCount} FAIL`,
  ];

  if (trend) {
    lines.push(`Trend: ${trend}`);
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// File management
// ---------------------------------------------------------------------------

function saveReport(report: string): string {
  mkdirSync(REPORT_DIR, { recursive: true });

  const filePath = join(REPORT_DIR, `${today()}.txt`);
  writeFileSync(filePath, report, "utf8");

  // Prune old reports (keep MAX_REPORTS most recent)
  const files = readdirSync(REPORT_DIR)
    .filter((f) => f.endsWith(".txt"))
    .toSorted()
    .toReversed();

  for (const old of files.slice(MAX_REPORTS)) {
    try {
      unlinkSync(join(REPORT_DIR, old));
    } catch {
      // best effort
    }
  }

  return filePath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });

  const report = await generateReport();

  // Always print to stdout
  // eslint-disable-next-line no-console
  console.log(report);

  // Save to file
  const savedPath = saveReport(report);
  // eslint-disable-next-line no-console
  console.log(`Report saved to: ${savedPath}`);

  // Exit with failure if any FAIL grades
  if (report.includes("FAIL ")) {
    process.exitCode = 1;
  }
}

await main();
