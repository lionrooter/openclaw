import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withEnv } from "../../test-utils/env.js";
import { __testing } from "./web-search.js";

const {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  isDirectPerplexityBaseUrl,
  resolvePerplexityRequestModel,
  normalizeFreshness,
  freshnessToPerplexityRecency,
  resolveGrokApiKey,
  resolveGrokModel,
  resolveGrokInlineCitations,
  extractGrokContent,
  resolveContextConfig,
  clampNumber,
  normalizeThresholdMode,
} = __testing;

describe("web_search perplexity baseUrl defaults", () => {
  it("detects a Perplexity key prefix", () => {
    expect(inferPerplexityBaseUrlFromApiKey("pplx-123")).toBe("direct");
  });

  it("detects an OpenRouter key prefix", () => {
    expect(inferPerplexityBaseUrlFromApiKey("sk-or-v1-123")).toBe("openrouter");
  });

  it("returns undefined for unknown key formats", () => {
    expect(inferPerplexityBaseUrlFromApiKey("unknown-key")).toBeUndefined();
  });

  it("prefers explicit baseUrl over key-based defaults", () => {
    expect(resolvePerplexityBaseUrl({ baseUrl: "https://example.com" }, "config", "pplx-123")).toBe(
      "https://example.com",
    );
  });

  it("defaults to direct when using PERPLEXITY_API_KEY", () => {
    expect(resolvePerplexityBaseUrl(undefined, "perplexity_env")).toBe("https://api.perplexity.ai");
  });

  it("defaults to OpenRouter when using OPENROUTER_API_KEY", () => {
    expect(resolvePerplexityBaseUrl(undefined, "openrouter_env")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("defaults to direct when config key looks like Perplexity", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "pplx-123")).toBe(
      "https://api.perplexity.ai",
    );
  });

  it("defaults to OpenRouter when config key looks like OpenRouter", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "sk-or-v1-123")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("defaults to OpenRouter for unknown config key formats", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "weird-key")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });
});

describe("web_search perplexity model normalization", () => {
  it("detects direct Perplexity host", () => {
    expect(isDirectPerplexityBaseUrl("https://api.perplexity.ai")).toBe(true);
    expect(isDirectPerplexityBaseUrl("https://api.perplexity.ai/")).toBe(true);
    expect(isDirectPerplexityBaseUrl("https://openrouter.ai/api/v1")).toBe(false);
  });

  it("strips provider prefix for direct Perplexity", () => {
    expect(resolvePerplexityRequestModel("https://api.perplexity.ai", "perplexity/sonar-pro")).toBe(
      "sonar-pro",
    );
  });

  it("keeps prefixed model for OpenRouter", () => {
    expect(
      resolvePerplexityRequestModel("https://openrouter.ai/api/v1", "perplexity/sonar-pro"),
    ).toBe("perplexity/sonar-pro");
  });

  it("keeps model unchanged when URL is invalid", () => {
    expect(resolvePerplexityRequestModel("not-a-url", "perplexity/sonar-pro")).toBe(
      "perplexity/sonar-pro",
    );
  });
});

describe("web_search freshness normalization", () => {
  it("accepts Brave shortcut values", () => {
    expect(normalizeFreshness("pd")).toBe("pd");
    expect(normalizeFreshness("PW")).toBe("pw");
  });

  it("accepts valid date ranges", () => {
    expect(normalizeFreshness("2024-01-01to2024-01-31")).toBe("2024-01-01to2024-01-31");
  });

  it("rejects invalid date ranges", () => {
    expect(normalizeFreshness("2024-13-01to2024-01-31")).toBeUndefined();
    expect(normalizeFreshness("2024-02-30to2024-03-01")).toBeUndefined();
    expect(normalizeFreshness("2024-03-10to2024-03-01")).toBeUndefined();
  });
});

describe("freshnessToPerplexityRecency", () => {
  it("maps Brave shortcuts to Perplexity recency values", () => {
    expect(freshnessToPerplexityRecency("pd")).toBe("day");
    expect(freshnessToPerplexityRecency("pw")).toBe("week");
    expect(freshnessToPerplexityRecency("pm")).toBe("month");
    expect(freshnessToPerplexityRecency("py")).toBe("year");
  });

  it("returns undefined for date ranges (not supported by Perplexity)", () => {
    expect(freshnessToPerplexityRecency("2024-01-01to2024-01-31")).toBeUndefined();
  });

  it("returns undefined for undefined/empty input", () => {
    expect(freshnessToPerplexityRecency(undefined)).toBeUndefined();
    expect(freshnessToPerplexityRecency("")).toBeUndefined();
  });
});

describe("web_search grok config resolution", () => {
  it("uses config apiKey when provided", () => {
    expect(resolveGrokApiKey({ apiKey: "xai-test-key" })).toBe("xai-test-key");
  });

  it("returns undefined when no apiKey is available", () => {
    withEnv({ XAI_API_KEY: undefined }, () => {
      expect(resolveGrokApiKey({})).toBeUndefined();
      expect(resolveGrokApiKey(undefined)).toBeUndefined();
    });
  });

  it("uses default model when not specified", () => {
    expect(resolveGrokModel({})).toBe("grok-4-1-fast");
    expect(resolveGrokModel(undefined)).toBe("grok-4-1-fast");
  });

  it("uses config model when provided", () => {
    expect(resolveGrokModel({ model: "grok-3" })).toBe("grok-3");
  });

  it("defaults inlineCitations to false", () => {
    expect(resolveGrokInlineCitations({})).toBe(false);
    expect(resolveGrokInlineCitations(undefined)).toBe(false);
  });

  it("respects inlineCitations config", () => {
    expect(resolveGrokInlineCitations({ inlineCitations: true })).toBe(true);
    expect(resolveGrokInlineCitations({ inlineCitations: false })).toBe(false);
  });
});

describe("web_search grok response parsing", () => {
  it("extracts content from Responses API message blocks", () => {
    const result = extractGrokContent({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "hello from output" }],
        },
      ],
    });
    expect(result.text).toBe("hello from output");
    expect(result.annotationCitations).toEqual([]);
  });

  it("extracts url_citation annotations from content blocks", () => {
    const result = extractGrokContent({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "hello with citations",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.com/a",
                  start_index: 0,
                  end_index: 5,
                },
                {
                  type: "url_citation",
                  url: "https://example.com/b",
                  start_index: 6,
                  end_index: 10,
                },
                {
                  type: "url_citation",
                  url: "https://example.com/a",
                  start_index: 11,
                  end_index: 15,
                }, // duplicate
              ],
            },
          ],
        },
      ],
    });
    expect(result.text).toBe("hello with citations");
    expect(result.annotationCitations).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("falls back to deprecated output_text", () => {
    const result = extractGrokContent({ output_text: "hello from output_text" });
    expect(result.text).toBe("hello from output_text");
    expect(result.annotationCitations).toEqual([]);
  });

  it("returns undefined text when no content found", () => {
    const result = extractGrokContent({});
    expect(result.text).toBeUndefined();
    expect(result.annotationCitations).toEqual([]);
  });
});

describe("web_search_context resolveContextConfig", () => {
  it("returns undefined for missing config", () => {
    expect(resolveContextConfig(undefined)).toBeUndefined();
    expect(resolveContextConfig({})).toBeUndefined();
  });

  it("returns undefined when tools.web.search is missing", () => {
    expect(resolveContextConfig({ tools: {} } as unknown as OpenClawConfig)).toBeUndefined();
    expect(
      resolveContextConfig({ tools: { web: {} } } as unknown as OpenClawConfig),
    ).toBeUndefined();
    expect(
      resolveContextConfig({ tools: { web: { search: {} } } } as unknown as OpenClawConfig),
    ).toBeUndefined();
  });

  it("returns undefined for non-object context", () => {
    expect(
      resolveContextConfig({
        tools: { web: { search: { context: "invalid" } } },
      } as unknown as OpenClawConfig),
    ).toBeUndefined();
  });

  it("extracts nested context config correctly", () => {
    const cfg = {
      tools: {
        web: {
          search: {
            context: {
              enabled: true,
              maxTokens: 4096,
              maxUrls: 10,
              maxTokensPerUrl: 2048,
              thresholdMode: "strict",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = resolveContextConfig(cfg);
    expect(result).toBeDefined();
    expect(result!.enabled).toBe(true);
    expect(result!.maxTokens).toBe(4096);
    expect(result!.maxUrls).toBe(10);
    expect(result!.maxTokensPerUrl).toBe(2048);
    expect(result!.thresholdMode).toBe("strict");
  });

  it("returns partial config when some fields omitted", () => {
    const cfg = {
      tools: { web: { search: { context: { enabled: false } } } },
    } as unknown as OpenClawConfig;
    const result = resolveContextConfig(cfg);
    expect(result).toBeDefined();
    expect(result!.enabled).toBe(false);
    expect(result!.maxTokens).toBeUndefined();
  });
});

describe("web_search_context normalizeThresholdMode", () => {
  it("returns balanced for undefined/empty", () => {
    expect(normalizeThresholdMode(undefined)).toBe("balanced");
    expect(normalizeThresholdMode("")).toBe("balanced");
    expect(normalizeThresholdMode("  ")).toBe("balanced");
  });

  it("accepts valid modes (case insensitive)", () => {
    expect(normalizeThresholdMode("strict")).toBe("strict");
    expect(normalizeThresholdMode("BALANCED")).toBe("balanced");
    expect(normalizeThresholdMode("Lenient")).toBe("lenient");
    expect(normalizeThresholdMode("disabled")).toBe("disabled");
  });

  it("returns balanced for invalid modes", () => {
    expect(normalizeThresholdMode("unknown")).toBe("balanced");
    expect(normalizeThresholdMode("aggressive")).toBe("balanced");
  });
});

describe("web_search_context clampNumber", () => {
  it("returns fallback for undefined", () => {
    expect(clampNumber(undefined, 1, 100, 50)).toBe(50);
  });

  it("returns fallback for NaN/Infinity", () => {
    expect(clampNumber(NaN, 1, 100, 50)).toBe(50);
    expect(clampNumber(Infinity, 1, 100, 50)).toBe(50);
    expect(clampNumber(-Infinity, 1, 100, 50)).toBe(50);
  });

  it("clamps to minimum", () => {
    expect(clampNumber(0, 1024, 32768, 8192)).toBe(1024);
    expect(clampNumber(-5, 1024, 32768, 8192)).toBe(1024);
    expect(clampNumber(500, 1024, 32768, 8192)).toBe(1024);
  });

  it("clamps to maximum", () => {
    expect(clampNumber(99999, 1024, 32768, 8192)).toBe(32768);
    expect(clampNumber(40000, 1024, 32768, 8192)).toBe(32768);
  });

  it("floors fractional values", () => {
    expect(clampNumber(2048.7, 1024, 32768, 8192)).toBe(2048);
    expect(clampNumber(1024.9, 1024, 32768, 8192)).toBe(1024);
  });

  it("passes through valid values", () => {
    expect(clampNumber(4096, 1024, 32768, 8192)).toBe(4096);
    expect(clampNumber(1024, 1024, 32768, 8192)).toBe(1024);
    expect(clampNumber(32768, 1024, 32768, 8192)).toBe(32768);
  });
});
