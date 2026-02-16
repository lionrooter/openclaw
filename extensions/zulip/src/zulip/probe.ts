import { normalizeZulipBaseUrl, type ZulipUser } from "./client.js";

export type ZulipProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  bot?: ZulipUser;
};

export async function probeZulip(
  baseUrl: string,
  botEmail: string,
  botApiKey: string,
  timeoutMs = 5000,
): Promise<ZulipProbe> {
  const normalized = normalizeZulipBaseUrl(baseUrl);
  if (!normalized) {
    return { ok: false, error: "baseUrl missing" };
  }

  const url = `${normalized}/api/v1/users/me`;
  const auth = `Basic ${Buffer.from(`${botEmail}:${botApiKey}`).toString("base64")}`;
  const start = Date.now();
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  let timer: NodeJS.Timeout | null = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetch(url, {
      headers: { Authorization: auth },
      signal: controller?.signal,
    });
    const elapsedMs = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text || res.statusText, elapsedMs };
    }
    const bot = (await res.json()) as ZulipUser;
    return { ok: true, status: res.status, elapsedMs, bot };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - start,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
