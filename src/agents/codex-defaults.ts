export const OPENAI_CODEX_DEFAULT_MODEL_REF = "openai-codex/gpt-5.4";
export const CODEX_DEFAULT_CLI_MODEL = "gpt-5.4";

export function normalizeCodexCliModel(model?: string): string {
  const trimmed = model?.trim();
  if (!trimmed) {
    return CODEX_DEFAULT_CLI_MODEL;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized.startsWith("openai-codex/")) {
    return trimmed.slice("openai-codex/".length);
  }
  if (normalized.startsWith("codex/")) {
    return trimmed.slice("codex/".length);
  }
  return trimmed;
}
