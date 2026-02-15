/**
 * Architectural linter — enforces module boundaries and dependency direction.
 *
 * Rules:
 *   1. Channel providers must NOT import from sibling channel providers.
 *   2. Protected core modules must NOT import from channel providers.
 *
 * Run: node --import tsx scripts/check-architecture.ts
 * Wired into: pnpm check:arch → CI
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Provider directories (channel implementations)
// ---------------------------------------------------------------------------

const PROVIDER_DIRS = [
  "src/telegram",
  "src/discord",
  "src/slack",
  "src/signal",
  "src/imessage",
  "src/whatsapp",
  "src/line",
] as const;

// ---------------------------------------------------------------------------
// Protected core directories — must NOT import from providers
// ---------------------------------------------------------------------------

const PROTECTED_CORE_DIRS = ["src/routing", "src/types", "src/shared", "src/media"] as const;

// ---------------------------------------------------------------------------
// Exemptions — files/dirs allowed to import from providers despite rules.
// Each entry is a path prefix. If a file starts with any exempt path, its
// imports from providers are allowed (for Rule 2 only; Rule 1 has no
// exemptions — providers must never cross-import).
// ---------------------------------------------------------------------------

const EXEMPT_PATHS = [
  // Hub files — architecturally required to import from providers
  "src/channels/", // dock.ts (registry) + plugins/ (bridge layer)
  "src/cli/deps.ts", // DI boundary (type-only imports)
  "src/plugin-sdk/", // SDK surface re-exports
  "src/plugins/", // Plugin runtime
  "src/infra/outbound/", // Outbound delivery hub

  // Bridge files — specific cross-cutting concerns
  "src/gateway/server-http.ts", // Slack HTTP handler registration
  "src/auto-reply/templating.ts", // StickerMetadata type from telegram
  "src/tts/", // stripMarkdown utility from line
  "src/config/types.discord.ts", // DiscordPluralKitConfig type
  "src/commands/doctor-config-flow.ts", // Telegram account resolution
  "src/test-utils/", // Test utilities need provider types
  "src/agents/tools/", // Agent tools for specific providers
  "src/agents/pi-embedded-runner/", // Embedded runner reaction levels
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Violation = {
  rule: string;
  file: string;
  line: number;
  importPath: string;
  message: string;
  fix: string;
};

function gitLsFiles(): string[] {
  const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Which provider directory does this file belong to? Returns e.g. "src/telegram" or null. */
function getProviderDir(filePath: string): string | null {
  for (const dir of PROVIDER_DIRS) {
    if (filePath.startsWith(dir + "/")) {
      return dir;
    }
  }
  return null;
}

/** Is this file inside a protected core directory? */
function isProtectedCore(filePath: string): boolean {
  return PROTECTED_CORE_DIRS.some((dir) => filePath.startsWith(dir + "/"));
}

/** Is this file exempt from the dependency direction rule? */
function isExempt(filePath: string): boolean {
  return EXEMPT_PATHS.some((prefix) => filePath.startsWith(prefix));
}

/** Resolve a relative import to a normalized path (relative to repo root). */
function resolveImport(fromFile: string, importSpecifier: string): string | null {
  // Only handle relative imports
  if (!importSpecifier.startsWith(".")) {
    return null;
  }

  const dir = dirname(fromFile);
  const resolved = join(dir, importSpecifier);
  // Normalize (remove ./ and resolve ..)
  return relative(".", resolve(resolved));
}

/** Extract import specifiers from file content. Handles `from '...'` and `import('...')`. */
function extractImports(content: string): Array<{ specifier: string; line: number }> {
  const results: Array<{ specifier: string; line: number }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineContent = lines[i];

    // Static imports: import ... from "..."  or  export ... from "..."
    const staticMatch = lineContent.match(/(?:import|export)\s+.*?from\s+["']([^"']+)["']/);
    if (staticMatch) {
      results.push({ specifier: staticMatch[1], line: i + 1 });
    }

    // Dynamic imports: import("...")
    const dynamicMatches = lineContent.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g);
    for (const match of dynamicMatches) {
      results.push({ specifier: match[1], line: i + 1 });
    }

    // require("...") — unlikely in ESM but catch it
    const requireMatches = lineContent.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g);
    for (const match of requireMatches) {
      results.push({ specifier: match[1], line: i + 1 });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Makes `... | head` safe.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });

  const files = gitLsFiles()
    .filter((f) => existsSync(f))
    .filter((f) => f.startsWith("src/"))
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    // Skip test files for dependency direction (tests legitimately reach into providers)
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".e2e.test.ts"));

  const violations: Violation[] = [];

  await Promise.all(
    files.map(async (filePath) => {
      const content = await readFile(filePath, "utf8");
      const imports = extractImports(content);
      const fileProvider = getProviderDir(filePath);
      const fileIsProtectedCore = isProtectedCore(filePath);
      const fileIsExempt = isExempt(filePath);

      for (const { specifier, line } of imports) {
        const resolved = resolveImport(filePath, specifier);
        if (!resolved) {
          continue;
        } // skip non-relative (node_modules etc.)

        const targetProvider = getProviderDir(resolved);
        if (!targetProvider) {
          continue;
        } // target is not a provider — OK

        // RULE 1: Cross-provider imports
        if (fileProvider && targetProvider && fileProvider !== targetProvider) {
          violations.push({
            rule: "Module boundary crossed",
            file: filePath,
            line,
            importPath: specifier,
            message: `Channel providers must not import from other channel providers.`,
            fix: [
              `Move shared logic to src/channels/ or src/shared/.`,
              `For types, move to src/types/.`,
            ].join("\n          "),
          });
        }

        // RULE 2: Dependency direction (core → provider)
        if (!fileProvider && fileIsProtectedCore && !fileIsExempt) {
          violations.push({
            rule: "Dependency direction reversed",
            file: filePath,
            line,
            importPath: specifier,
            message: `Core module ${PROTECTED_CORE_DIRS.find((d) => filePath.startsWith(d + "/"))}/ must not import from channel providers.`,
            fix: [
              `Inject the dependency via a function parameter or interface.`,
              `See src/cli/deps.ts for the established DI pattern.`,
            ].join("\n          "),
          });
        }
      }
    }),
  );

  if (!violations.length) {
    // eslint-disable-next-line no-console
    console.log("Architecture check passed: 0 violations");
    return;
  }

  // Sort by file path, then line number for stable output.
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.log(
      [
        `VIOLATION: ${v.rule}`,
        `  File:   ${v.file}:${v.line}`,
        `  Import: ${v.importPath}`,
        `  Rule:   ${v.message}`,
        `  Fix:    ${v.fix}`,
        "",
      ].join("\n"),
    );
  }

  process.exitCode = 1;
}

await main();
