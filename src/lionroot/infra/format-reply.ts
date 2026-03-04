import type { ReplyFormattingMode } from "../../config/types.base.js";

/**
 * Matches narration/status lines produced by agent reasoning.
 * Gerund-led phrases like "Investigating the logs...", "I'm now checking..."
 */
const NARRATION_RE =
  /^(?:(?:I(?:'m|'m| am)\s+)?(?:now\s+)?(?:investigating|inspecting|monitoring|checking|analyzing|examining|reviewing|looking\s+(?:at|into|for)|searching|exploring|scanning|reading|parsing|processing|evaluating|verifying|confirming|fetching|retrieving|pulling|gathering|collecting|compiling|preparing|setting\s+up|starting|beginning|initiating|attempting|trying|working\s+on|getting|running|executing|testing|debugging|tracing|digging\s+into|diving\s+into|noting|planning|drafting|extracting|locating|choosing|securing|summarizing|loading|applying|building|creating|updating|removing|determining|resolving|identifying|generating|converting|validating|configuring|connecting|comparing|completing|finalizing|implementing|deploying|cleaning|opening|closing|mapping|matching|combining|refining|detecting|handling))\b/i;

/**
 * Markdown structural markers — lines containing these are NOT narration,
 * even if they happen to start with a narration verb.
 */
const MARKDOWN_MARKER_RE = /(?:^#{1,6}\s|^[-*]\s|^\d+\.\s|[`[])/;

const MAX_NARRATION_LENGTH = 120;

function isNarrationLine(line: string): boolean {
  if (line.length > MAX_NARRATION_LENGTH) {
    return false;
  }
  if (MARKDOWN_MARKER_RE.test(line)) {
    return false;
  }
  return NARRATION_RE.test(line);
}

/**
 * Split text into blocks, preserving code fences as single opaque blocks.
 * Returns { text, inFence } tuples.
 */
function splitBlocks(text: string): Array<{ text: string; inFence: boolean }> {
  const lines = text.split("\n");
  const blocks: Array<{ text: string; inFence: boolean }> = [];
  let current: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inFence) {
        // End of fence — include closing marker
        current.push(line);
        blocks.push({ text: current.join("\n"), inFence: true });
        current = [];
        inFence = false;
      } else {
        // Start of fence — flush preceding content
        if (current.length > 0) {
          blocks.push({ text: current.join("\n"), inFence: false });
          current = [];
        }
        current.push(line);
        inFence = true;
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push({ text: current.join("\n"), inFence });
  }
  return blocks;
}

/**
 * Format a non-fenced text block in "full" mode.
 * - Narration lines become *italicized*
 * - Consecutive narration lines get blank lines between them
 * - Transition blank lines are inserted at narration↔content boundaries
 */
function formatBlockFull(blockText: string): string {
  const lines = blockText.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const isBlank = !trimmed;
    const isNarr = !isBlank && isNarrationLine(trimmed);

    if (isBlank) {
      result.push(lines[i]);
      continue;
    }

    if (isNarr) {
      // Insert transition blank line if previous non-blank line was NOT narration
      // and there's no blank line already separating them
      if (result.length > 0) {
        const prev = result[result.length - 1];
        if (prev.trim() !== "") {
          // Previous line is non-blank — check if it was content or narration
          // We need to look back to see if previous was narration (already italicized)
          const prevIsFormattedNarr = prev.startsWith("*") && prev.endsWith("*");
          if (prevIsFormattedNarr) {
            // Consecutive narration — insert blank line between
            result.push("");
          } else {
            // Content → narration transition — insert blank line
            result.push("");
          }
        }
      }
      result.push(`*${trimmed}*`);
    } else {
      // Non-narration, non-blank line
      // Insert transition blank line if previous was narration and no blank line between
      if (result.length > 0) {
        const prev = result[result.length - 1];
        const prevIsFormattedNarr =
          prev.trim() !== "" && prev.startsWith("*") && prev.endsWith("*");
        if (prevIsFormattedNarr) {
          result.push("");
        }
      }
      result.push(lines[i]);
    }
  }

  return result.join("\n");
}

/**
 * Format a non-fenced text block in "compact" mode.
 * - Narration lines become (parenthesized) with trailing ellipsis trimmed
 * - No blank line insertion — compact stays tight
 */
function formatBlockCompact(blockText: string): string {
  const lines = blockText.split("\n");
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return line;
      }
      if (isNarrationLine(trimmed)) {
        const cleaned = trimmed.replace(/\.{2,}$/, "");
        return `(${cleaned})`;
      }
      return line;
    })
    .join("\n");
}

function formatFull(text: string): string {
  const blocks = splitBlocks(text);
  const formatted = blocks.map((block) => {
    if (block.inFence) {
      return block.text;
    }
    return formatBlockFull(block.text);
  });
  // Collapse 3+ consecutive blank lines to 2
  return formatted.join("\n").replace(/\n{4,}/g, "\n\n\n");
}

function formatCompact(text: string): string {
  const blocks = splitBlocks(text);
  const formatted = blocks.map((block) => {
    if (block.inFence) {
      return block.text;
    }
    return formatBlockCompact(block.text);
  });
  // Collapse 3+ consecutive blank lines to 1
  return formatted.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function formatReplyForChannel(text: string, mode: ReplyFormattingMode): string {
  if (!text || mode === "off") {
    return text;
  }
  if (mode === "full") {
    return formatFull(text);
  }
  if (mode === "compact") {
    return formatCompact(text);
  }
  return text;
}
