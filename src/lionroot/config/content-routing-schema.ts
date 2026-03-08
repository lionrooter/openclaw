/**
 * Content routing Zod schemas and TypeScript types.
 *
 * Extracted from src/config/zod-schema.agents.ts and src/config/types.agents.ts
 * to minimize upstream diff.
 */
import { z } from "zod";

// ── Zod schemas ──

export const ContentRoutingAgentsSchema = z.record(z.string(), z.string());

export const ContentForwardSchema = z
  .object({
    enabled: z.boolean().optional(),
    channel: z.string().optional(),
    streams: z.record(z.string(), z.string()).optional(),
    streamPattern: z.string().optional(),
    topicPrefix: z.string().optional(),
  })
  .strict()
  .optional();

export const ContentRoutingSchema = z
  .object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
    ollamaUrl: z.string().optional(),
    stickyTimeoutMs: z.number().optional(),
    defaultAgentId: z.string().optional(),
    agents: ContentRoutingAgentsSchema.optional(),
    forward: ContentForwardSchema,
  })
  .strict()
  .optional();

// ── TypeScript types ──

export type ContentForwardConfig = {
  enabled?: boolean;
  /** Channel to forward to (default: "zulip"). */
  channel?: string;
  /** Explicit agentId → stream name map. Checked first; falls back to streamPattern. */
  streams?: Record<string, string>;
  /** Stream name pattern. "{agent}" is replaced with agentId. Default: "{agent}". */
  streamPattern?: string;
  /** Topic prefix for forwarded posts. Default: "x". */
  topicPrefix?: string;
};

export type ContentRoutingConfig = {
  enabled?: boolean;
  model?: string;
  ollamaUrl?: string;
  stickyTimeoutMs?: number;
  defaultAgentId?: string;
  agents?: Record<string, string>;
  forward?: ContentForwardConfig;
};
